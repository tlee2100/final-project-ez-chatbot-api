import { ApiProperty } from '@nestjs/swagger';

export class ChatActivityPointDto {
  @ApiProperty({ example: 'Mon' })
  label: string;

  @ApiProperty({ example: 120 })
  value: number;
}

export class ChatActivityDto {
  @ApiProperty({ type: [ChatActivityPointDto] })
  daily: ChatActivityPointDto[];

  @ApiProperty({ type: [ChatActivityPointDto] })
  weekly: ChatActivityPointDto[];

  @ApiProperty({ type: [ChatActivityPointDto] })
  monthly: ChatActivityPointDto[];
}

export class TokenUsageDto {
  @ApiProperty({ type: [ChatActivityPointDto] })
  daily: ChatActivityPointDto[];

  @ApiProperty({ type: [ChatActivityPointDto] })
  weekly: ChatActivityPointDto[];

  @ApiProperty({ type: [ChatActivityPointDto] })
  monthly: ChatActivityPointDto[];
}

export class UserFeedbackItemDto {
  @ApiProperty({ example: 'Helpful' })
  label: string;

  @ApiProperty({ example: 85 })
  value: number;

  @ApiProperty({ example: '#10b981' })
  color: string;
}

export class ContainmentRateDto {
  @ApiProperty({
    example: 78,
    description: 'Percentage of chats handled by AI',
  })
  aiResolved: number;

  @ApiProperty({
    example: 22,
    description: 'Percentage of chats requiring agent handoff',
  })
  agentHandoff: number;
}

export class RecentActivityItemDto {
  @ApiProperty({ example: '1' })
  id: string;

  @ApiProperty({ example: 'chat' })
  type: string;

  @ApiProperty({ example: 'New chat session on TechSolutions Inc.' })
  title: string;

  @ApiProperty({ example: 'Visitor asked about product pricing' })
  description: string;

  @ApiProperty({ example: '13:55' })
  time: string;

  @ApiProperty({ example: '5 min ago' })
  timeAgo: string;
}

export class DashboardStatItemDto {
  @ApiProperty({ example: 'total-chats' })
  id: string;

  @ApiProperty({ example: 'Total Chats' })
  title: string;

  @ApiProperty({ example: '1,248' })
  value: string;

  @ApiProperty({ example: 12 })
  trend: number;

  @ApiProperty({ example: 'up' })
  trendDirection: string;

  @ApiProperty({ example: 'message' })
  icon: string;

  @ApiProperty({ example: '#6366f1' })
  iconColor: string;

  @ApiProperty({ example: '#ede9fe' })
  iconBg: string;

  @ApiProperty({ example: false })
  isMock: boolean;
}

export class DashboardAnalyticsDto {
  @ApiProperty({ type: [DashboardStatItemDto] })
  stats: DashboardStatItemDto[];

  @ApiProperty({ example: 1248 })
  totalChats: number;

  @ApiProperty({ example: 8 })
  activeSites: number;

  @ApiProperty({ example: 10 })
  totalSites: number;

  @ApiProperty({ example: 5 })
  totalOrganizations: number;

  @ApiProperty({ example: 4 })
  activeOrganizations: number;

  @ApiProperty({ example: 12 })
  totalAgents: number;

  @ApiProperty({ type: ContainmentRateDto })
  containmentRate: ContainmentRateDto;

  @ApiProperty({ type: ChatActivityDto })
  chatActivity: ChatActivityDto;

  @ApiProperty({ type: TokenUsageDto })
  tokenUsage: TokenUsageDto;

  @ApiProperty({ type: [UserFeedbackItemDto] })
  userFeedback: UserFeedbackItemDto[];

  @ApiProperty({ type: [RecentActivityItemDto] })
  recentActivity: RecentActivityItemDto[];
}
