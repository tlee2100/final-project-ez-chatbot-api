jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { AnalyticsService } from './analytics.service';
import { UserRole } from '../user/enums/user-role.enum';
import { FeedbackRating } from '../chat/entities/chat-message.entity';
import { createRepositoryMock } from '../test/service-test-helpers';
import type { JwtUser } from '../auth/types/jwt-user.type';

describe('AnalyticsService', () => {
  function makeService() {
    const conversationRepo = createRepositoryMock();
    const chatMessageRepo = createRepositoryMock();
    const siteRepo = createRepositoryMock();
    const userRepo = createRepositoryMock();
    const orgRepo = createRepositoryMock();

    const service = new AnalyticsService(
      conversationRepo as never,
      chatMessageRepo as never,
      siteRepo as never,
      userRepo as never,
      orgRepo as never,
    );

    return {
      service,
      conversationRepo,
      chatMessageRepo,
      siteRepo,
      userRepo,
      orgRepo,
    };
  }

  it('aggregates real user feedback for sites in scope', async () => {
    const { service, siteRepo, chatMessageRepo, conversationRepo } =
      makeService();

    siteRepo.find.mockResolvedValue([{ id: 'site-1' }, { id: 'site-2' }]);
    siteRepo.count.mockResolvedValue(2);
    conversationRepo.count.mockResolvedValue(10);
    conversationRepo.find.mockResolvedValue([]);

    const qbMock = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { rating: FeedbackRating.HELPFUL, count: '15' },
        { rating: FeedbackRating.UNHELPFUL, count: '3' },
      ]),
    };
    chatMessageRepo.createQueryBuilder.mockReturnValue(qbMock);

    const user: JwtUser = {
      id: 'user-1',
      email: 'admin@example.com',
      role: UserRole.SUPER_ADMIN,
      organizationId: null,
    };

    const result = await service.getDashboardAnalytics(user);

    expect(result.userFeedback).toEqual([
      { label: 'Helpful', value: 15, color: '#10b981' },
      { label: 'Not Helpful', value: 3, color: '#ef4444' },
    ]);
    expect(qbMock.where).toHaveBeenCalledWith(
      'conversation.siteId IN (:...siteIds)',
      { siteIds: ['site-1', 'site-2'] },
    );
  });
});
