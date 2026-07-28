import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { UserRole } from './enums/user-role.enum';
import { InjectMapper } from '@automapper/nestjs';
import type { Mapper } from '@automapper/core';
import { UserDto } from './dto/user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectMapper()
    private readonly mapper: Mapper,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id },
    });
  }

  async findAll(query: QueryUserDto) {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.userRepository.createQueryBuilder('user');

    if (query.email) {
      qb.andWhere('user.email ILIKE :email', { email: `%${query.email}%` });
    }

    if (query.name) {
      qb.andWhere('user.name ILIKE :name', { name: `%${query.name}%` });
    }

    if (query.role) {
      qb.andWhere('user.role = :role', { role: query.role });
    }

    if (query.sortBy) {
      qb.orderBy(`user.${query.sortBy}`, query.order || 'ASC');
    }

    qb.skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    const userDtos = this.mapper.mapArray(data, User, UserDto);

    return {
      data: userDtos,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(createUserDto: CreateUserDto) {
    const extistingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (extistingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(createUserDto.password, salt);

    const user = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword,
      role: createUserDto.role ?? UserRole.AGENT,
    });

    const saved = await this.userRepository.save(user);

    return this.mapper.map(saved, User, UserDto);
  }

  async findByEmail(email: string) {
    return this.userRepository.findOne({
      where: { email },
    });
  }

  async findOne(id: string) {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.mapper.map(user, User, UserDto);
  }

  async getMe(id: string): Promise<UserDto> {
    const user = await this.findUserEntity(id);

    return this.mapper.map(user, User, UserDto);
  }

  private async findUserEntity(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const user = await this.findUserEntity(id);

    let hashedPassword: string | undefined;
    if (updateUserDto.password) {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(updateUserDto.password, salt);
    }

    const { password: _password, ...rest } = updateUserDto;
    void _password;

    Object.assign(user, rest);
    Object.assign(user, rest);

    if (hashedPassword) {
      user.password = hashedPassword;
    }

    const saved = await this.userRepository.save(user);

    return this.mapper.map(saved, User, UserDto);
  }

  async remove(id: string) {
    const user = await this.findUserEntity(id);

    await this.userRepository.remove(user);

    return {
      message: 'User deleted successfully',
    };
  }
}
