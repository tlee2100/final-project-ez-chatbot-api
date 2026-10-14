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
    const chatMessageRepo = {
      ...createRepositoryMock(),
      manager: {
        query: jest.fn().mockResolvedValue([{ avgDiff: null }]),
      },
    };
    const siteRepo = createRepositoryMock();
    const userRepo = createRepositoryMock();
    const orgRepo = createRepositoryMock();
    const documentRepo = createRepositoryMock();
    const documentChunkRepo = createRepositoryMock();

    const service = new AnalyticsService(
      conversationRepo as never,
      chatMessageRepo as never,
      siteRepo as never,
      userRepo as never,
      orgRepo as never,
      documentRepo as never,
      documentChunkRepo as never,
    );

    return {
      service,
      conversationRepo,
      chatMessageRepo,
      siteRepo,
      userRepo,
      orgRepo,
      documentRepo,
      documentChunkRepo,
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
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getRawOne: jest.fn().mockResolvedValue(null),
      getRawMany: jest.fn().mockResolvedValue([
        { rating: FeedbackRating.HELPFUL, count: '15' },
        { rating: FeedbackRating.UNHELPFUL, count: '3' },
      ]),
    };
    chatMessageRepo.createQueryBuilder.mockReturnValue(qbMock as never);
    conversationRepo.createQueryBuilder.mockReturnValue(qbMock as never);

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
