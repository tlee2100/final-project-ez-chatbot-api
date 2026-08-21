import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { InjectMapper } from '@automapper/nestjs';
import type { Mapper } from '@automapper/core';

import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto, ChangePasswordDto } from './dto/update-user.dto';
import { UserRole } from './enums/user-role.enum';
import { UserDto } from './dto/user.dto';
import type { JwtUser } from '../auth/types/jwt-user.type';
import { type PaginateQuery, type Paginated, paginate } from 'nestjs-paginate';
import { USER_PAGINATION_CONFIG } from './config/user-pagination.config';
import { EmailQueueService } from '../notification/email-queue.service';
import { ActivateAccountDto } from '../auth/dto/activate-account.dto';
import { ACTIVATION_TOKEN_EXPIRES_MS } from '../notification/constants/email.constants';

type PaginatedUserDtos = Omit<Paginated<User>, 'data'> & {
  data: UserDto[];
};

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectMapper()
    private readonly mapper: Mapper,
    private readonly emailQueueService: EmailQueueService,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findAll(
    query: PaginateQuery,
    actor: JwtUser,
  ): Promise<PaginatedUserDtos> {
    const qb = this.userRepository.createQueryBuilder('user');

    if (actor.role !== UserRole.SUPER_ADMIN) {
      qb.andWhere('user.organizationId = :organizationId', {
        organizationId: actor.organizationId,
      });
    }

    const paginated = await paginate(query, qb, USER_PAGINATION_CONFIG);

    return {
      ...paginated,
      data: this.mapper.mapArray(paginated.data, User, UserDto),
    };
  }

  async create(createUserDto: CreateUserDto, actor: JwtUser) {
    if (actor.role === UserRole.ADMIN) {
      if (
        createUserDto.role !== UserRole.AGENT ||
        createUserDto.organizationId !== actor.organizationId
      ) {
        throw new ForbiddenException(
          'Admin can only create agents in their organization',
        );
      }
    } else if (
      actor.role !== UserRole.SUPER_ADMIN ||
      createUserDto.role === UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('You cannot create this user');
    }

    if (
      await this.userRepository.findOne({
        where: { email: createUserDto.email },
        withDeleted: true,
      })
    ) {
      throw new ConflictException('User with this email already exists');
    }

    const activationToken = randomBytes(32).toString('base64url');
    const activationTokenExpiresAt = new Date(
      Date.now() + this.getActivationTokenLifetimeMs(),
    );
    const user = this.userRepository.create({
      ...createUserDto,
      password: await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
      isActive: false,
      activationTokenHash: this.hashActivationToken(activationToken),
      activationTokenExpiresAt,
    });
    const saved = await this.userRepository.save(user);

    try {
      await this.emailQueueService.enqueueUserActivationEmail({
        to: saved.email,
        userName: saved.name,
        email: saved.email,
        activationToken,
        activationUrl: `${process.env.FRONTEND_URL || ''}/set-password`,
        expiresAt: activationTokenExpiresAt.toISOString(),
      });
    } catch {
      await this.userRepository.delete(saved.id);
      throw new InternalServerErrorException(
        'User was not created because the activation email could not be queued',
      );
    }

    return {
      user: this.mapper.map(saved, User, UserDto),
      activationEmailQueued: true,
    };
  }

  async activateAccount(dto: ActivateAccountDto) {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException('New passwords do not match');
    }

    const user = await this.userRepository.findOne({
      where: { activationTokenHash: this.hashActivationToken(dto.token) },
    });
    if (!user || !user.activationTokenExpiresAt) {
      throw new BadRequestException('Invalid activation token');
    }
    if (user.isActive || user.activationTokenExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Activation token has expired or was used');
    }

    user.password = await bcrypt.hash(dto.newPassword, 10);
    user.isActive = true;
    user.activationTokenHash = null;
    user.activationTokenExpiresAt = null;
    user.refreshToken = null;
    const saved = await this.userRepository.save(user);
    await this.enqueuePasswordChangedNotification(saved, new Date());
    return { message: 'Account activated successfully' };
  }

  async validateActivationToken(token: string) {
    const user = await this.userRepository.findOne({
      where: { activationTokenHash: this.hashActivationToken(token) },
    });
    if (!user || !user.activationTokenExpiresAt) {
      throw new NotFoundException('Invalid activation token');
    }
    if (user.isActive || user.activationTokenExpiresAt.getTime() < Date.now()) {
      throw new NotFoundException('Activation token has expired or was used');
    }
    return { valid: true };
  }

  async resendActivation(id: string, actor: JwtUser) {
    const user = await this.findUserEntity(id);
    this.assertCanManage(user, actor);
    if (user.isActive) {
      throw new BadRequestException('User account is already active');
    }

    // Rate-limiting / cooldown: enforce minimum 60 seconds between resends
    if (
      user.activationTokenExpiresAt &&
      user.activationTokenExpiresAt.getTime() >
        Date.now() + this.getActivationTokenLifetimeMs() - 60 * 1000
    ) {
      throw new BadRequestException(
        'Please wait at least 60 seconds before requesting another activation email',
      );
    }

    const activationToken = randomBytes(32).toString('base64url');
    const activationTokenExpiresAt = new Date(
      Date.now() + this.getActivationTokenLifetimeMs(),
    );
    user.activationTokenHash = this.hashActivationToken(activationToken);
    user.activationTokenExpiresAt = activationTokenExpiresAt;
    await this.userRepository.save(user);

    try {
      await this.emailQueueService.enqueueUserActivationEmail({
        to: user.email,
        userName: user.name,
        email: user.email,
        activationToken,
        activationUrl: `${process.env.FRONTEND_URL || ''}/set-password`,
        expiresAt: activationTokenExpiresAt.toISOString(),
      });
    } catch {
      user.activationTokenHash = null;
      user.activationTokenExpiresAt = null;
      await this.userRepository.save(user);
      throw new InternalServerErrorException(
        'The activation email could not be queued',
      );
    }
    return { activationEmailQueued: true };
  }

  async findByEmail(email: string) {
    return this.userRepository.findOne({ where: { email } });
  }

  async findOne(id: string, actor?: JwtUser): Promise<UserDto> {
    const user = await this.findUserEntity(id);
    if (actor) this.assertCanManage(user, actor);
    return this.mapper.map(user, User, UserDto);
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: JwtUser,
    file?: Express.Multer.File,
  ) {
    if (id === actor.id) {
      throw new ForbiddenException(
        'You cannot update yourself through this endpoint. Use /users/me.',
      );
    }
    const user = await this.findUserEntity(id);
    this.assertCanManage(user, actor);

    Object.assign(user, dto);
    if (file) user.avatarUrl = (await this.uploadAvatar(file)).secure_url;
    return this.mapper.map(await this.userRepository.save(user), User, UserDto);
  }

  async updateMe(id: string, dto: UpdateUserDto, file?: Express.Multer.File) {
    const user = await this.findUserEntity(id);
    Object.assign(user, dto);
    if (file) user.avatarUrl = (await this.uploadAvatar(file)).secure_url;
    return this.mapper.map(await this.userRepository.save(user), User, UserDto);
  }

  async changePassword(id: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException('New passwords do not match');
    }

    const user = await this.findUserEntity(id);
    if (!(await bcrypt.compare(dto.currentPassword, user.password))) {
      throw new ForbiddenException('Current password is incorrect');
    }

    user.password = await bcrypt.hash(dto.newPassword, 10);
    user.refreshToken = null;
    const saved = await this.userRepository.save(user);
    await this.enqueuePasswordChangedNotification(saved, new Date());
    return { message: 'Password changed successfully' };
  }

  async updateInternal(
    id: string,
    fields: Partial<
      Pick<
        User,
        | 'refreshToken'
        | 'previousRefreshToken'
        | 'previousRefreshTokenExpiresAt'
        | 'twoFactorEnabled'
        | 'twoFactorSecret'
      >
    >,
  ) {
    const user = await this.findUserEntity(id);
    Object.assign(user, fields);
    return this.userRepository.save(user);
  }

  async remove(id: string, actor: JwtUser) {
    if (id === actor.id) {
      throw new ForbiddenException('You cannot delete yourself');
    }
    const user = await this.findUserEntity(id);
    this.assertCanManage(user, actor);
    await this.userRepository.softRemove(user);
    return { message: 'User deleted successfully' };
  }

  private async findUserEntity(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private assertCanManage(target: User, actor: JwtUser): void {
    if (actor.role === UserRole.SUPER_ADMIN) return;
    if (
      actor.role !== UserRole.ADMIN ||
      target.role !== UserRole.AGENT ||
      target.organizationId !== actor.organizationId
    ) {
      throw new ForbiddenException(
        'You do not have permission to manage this user',
      );
    }
  }

  private uploadAvatar(file: Express.Multer.File): Promise<UploadApiResponse> {
    if (!file?.buffer) throw new BadRequestException('Avatar file is required');
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
      process.env;
    if (
      !CLOUDINARY_CLOUD_NAME ||
      !CLOUDINARY_API_KEY ||
      !CLOUDINARY_API_SECRET
    ) {
      throw new InternalServerErrorException(
        'Cloudinary environment variables are missing',
      );
    }

    cloudinary.config({
      cloud_name: CLOUDINARY_CLOUD_NAME,
      api_key: CLOUDINARY_API_KEY,
      api_secret: CLOUDINARY_API_SECRET,
    });

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'users/avatars', resource_type: 'image' },
        (error, result) => {
          if (error) {
            reject(new Error(error.message || 'Cloudinary upload failed'));
            return;
          }
          if (result) {
            resolve(result);
            return;
          }
          reject(new Error('Cloudinary upload failed'));
        },
      );
      stream.end(file.buffer);
    });
  }

  private hashActivationToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private getActivationTokenLifetimeMs(): number {
    return ACTIVATION_TOKEN_EXPIRES_MS;
  }

  private async enqueuePasswordChangedNotification(
    user: Pick<User, 'id' | 'email' | 'name'>,
    changedAt: Date,
  ): Promise<void> {
    try {
      await this.emailQueueService.enqueuePasswordChangedEmail({
        to: user.email,
        userName: user.name,
        changedAt: changedAt.toISOString(),
      });
    } catch (error) {
      this.logger.error(
        `Password changed email could not be queued for user ${user.id}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
