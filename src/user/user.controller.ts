import {
  Body,
  Controller,
  Get,
  Post,
  UseInterceptors,
  ClassSerializerInterceptor,
  Param,
  Patch,
  Delete,
  UseGuards,
  Req,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ChangePasswordDto, UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import {
  Paginate,
  type PaginateQuery,
  ApiOkPaginatedResponse,
} from 'nestjs-paginate';
import { USER_PAGINATION_CONFIG } from './config/user-pagination.config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  DeleteUserResponseDto,
  CreateUserResponseDto,
  UserDto,
} from './dto/user.dto';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { UserRole } from './enums/user-role.enum';
import { Roles } from 'src/auth/decorators/roles.decorator';
import type { AuthRequest } from 'src/auth/types/auth-request.type';

const avatarUploadOptions = {
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    callback(
      file.mimetype.startsWith('image/')
        ? null
        : new BadRequestException('Avatar must be an image'),
      file.mimetype.startsWith('image/'),
    );
  },
};

const avatarMultipartBody = {
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', example: 'Nguyen Van B' },
      gender: { type: 'string', example: 'male' },
      dateOfBirth: { type: 'string', example: '1995-01-20' },
      phone: { type: 'string', example: '+84901234567' },
      avatar: { type: 'string', format: 'binary' },
    },
  },
};

@ApiTags('Users')
@ApiBearerAuth()
@ApiExtraModels(UserDto, DeleteUserResponseDto, CreateUserResponseDto)
@Controller('users')
@UseInterceptors(ClassSerializerInterceptor)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @ApiOperation({
    summary: 'Get all users with pagination, filtering and sorting',
  })
  @ApiOkPaginatedResponse(UserDto, USER_PAGINATION_CONFIG)
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  findAll(@Paginate() query: PaginateQuery, @Req() req: AuthRequest) {
    return this.userService.findAll(query, req.user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({
    status: 201,
    description: 'User created successfully',
    type: CreateUserResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 409,
    description: 'User with this email already exists',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  create(
    @Body() createUserDto: CreateUserDto,
    @Req() req: AuthRequest,
  ): Promise<CreateUserResponseDto> {
    return this.userService.create(createUserDto, req.user);
  }

  @Post(':id/resend-activation')
  @ApiOperation({ summary: 'Resend user account activation email' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({
    status: 201,
    description: 'Activation email queued successfully',
  })
  @ApiResponse({ status: 400, description: 'User is already active' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  resendActivation(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<{ activationEmailQueued: boolean }> {
    return this.userService.resendActivation(id, req.user);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Current user retrieved successfully',
    type: UserDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: AuthRequest): Promise<UserDto> {
    return this.userService.findOne(req.user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get user by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'User ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({
    status: 200,
    description: 'User retrieved successfully',
    type: UserDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 404,
    description: 'User not found',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  findOne(@Param('id') id: string, @Req() req: AuthRequest): Promise<UserDto> {
    return this.userService.findOne(id, req.user);
  }

  @Patch('me')
  @UseInterceptors(FileInterceptor('avatar', avatarUploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiBody(avatarMultipartBody)
  @ApiResponse({
    status: 200,
    description: 'Current user updated successfully',
    type: UserDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @UseGuards(JwtAuthGuard)
  updateMe(
    @Req() req: AuthRequest,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UserDto> {
    return this.userService.updateMe(req.user.id, updateUserDto, file);
  }

  @Patch('me/password')
  @ApiOperation({ summary: 'Change current user password' })
  @ApiBody({ type: ChangePasswordDto })
  @UseGuards(JwtAuthGuard)
  changePassword(@Req() req: AuthRequest, @Body() dto: ChangePasswordDto) {
    return this.userService.changePassword(req.user.id, dto);
  }

  @Patch(':id')
  @UseInterceptors(FileInterceptor('avatar', avatarUploadOptions))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Update user',
    description: 'Update user information except email and role',
  })
  @ApiParam({
    name: 'id',
    description: 'User ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiBody(avatarMultipartBody)
  @ApiResponse({
    status: 200,
    description: 'User updated successfully',
    type: UserDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 404,
    description: 'User not found',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Req() req: AuthRequest,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UserDto> {
    return this.userService.update(id, updateUserDto, req.user, file);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete user',
  })
  @ApiParam({
    name: 'id',
    description: 'User ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({
    status: 200,
    description: 'User deleted successfully',
    type: DeleteUserResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 404,
    description: 'User not found',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<DeleteUserResponseDto> {
    return this.userService.remove(id, req.user);
  }
}
