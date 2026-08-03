import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../user/enums/user-role.enum';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { AnalyticsService } from './analytics.service';
import { DashboardAnalyticsDto } from './dto/analytics-dashboard.dto';

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({
    summary:
      'Get aggregate analytics for dashboard. Scoped by role and organization ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard analytics retrieved successfully',
    type: DashboardAnalyticsDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getDashboardAnalytics(@Req() req: AuthRequest) {
    return this.analyticsService.getDashboardAnalytics(req.user);
  }
}
