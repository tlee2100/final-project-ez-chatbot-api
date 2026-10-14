jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));
jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
  AutomapperProfile: class {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { McpService } from './mcp.service';
import { McpController } from './mcp.controller';
import { Document } from '../document/entities/document.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import { KnowledgeRetrievalService } from '../document/retrieval/knowledge-retrieval.service';
import { BookingService } from '../booking/booking.service';
import { createRepositoryMock } from '../test/service-test-helpers';
import { UserRole } from '../user/enums/user-role.enum';
import type { McpValidatedContext } from './types/mcp.types';

describe('McpService & McpController (Tenant Isolation)', () => {
  let mcpService: McpService;
  let mcpController: McpController;
  let userRepository: ReturnType<typeof createRepositoryMock>;

  const mockQueryBuilder = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  beforeEach(async () => {
    userRepository = createRepositoryMock();
    userRepository.createQueryBuilder.mockReturnValue(
      mockQueryBuilder as never,
    );

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpService,
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), verify: jest.fn() },
        },
        {
          provide: getRepositoryToken(Document),
          useValue: createRepositoryMock(),
        },
        {
          provide: KnowledgeRetrievalService,
          useValue: {},
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: createRepositoryMock(),
        },
        {
          provide: getRepositoryToken(User),
          useValue: userRepository,
        },
        {
          provide: getRepositoryToken(Site),
          useValue: createRepositoryMock(),
        },
        {
          provide: BookingService,
          useValue: {},
        },
      ],
    }).compile();

    mcpService = module.get<McpService>(McpService);
    mcpController = module.get<McpController>(McpController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('McpService.getUserDetails', () => {
    const siteId = 'site-123';
    const email = 'agent@example.com';

    it('returns user details when user belongs to the site', async () => {
      const mockUser = {
        id: 'user-1',
        name: 'Agent Smith',
        email: 'agent@example.com',
        phone: '0123456789',
        role: UserRole.AGENT,
        avatarUrl: 'https://avatar.com/1.png',
      };

      mockQueryBuilder.getOne.mockResolvedValue(mockUser);

      const result = await mcpService.getUserDetails(siteId, email);

      expect(userRepository.createQueryBuilder).toHaveBeenCalledWith('user');
      expect(mockQueryBuilder.innerJoin).toHaveBeenCalledWith(
        'sites',
        'site',
        'site.id = :siteId',
        { siteId },
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'user.email = :email',
        {
          email,
        },
      );
      expect(result).toEqual({
        id: 'user-1',
        name: 'Agent Smith',
        email: 'agent@example.com',
        phone: '0123456789',
        role: UserRole.AGENT,
        avatarUrl: 'https://avatar.com/1.png',
      });
    });

    it('returns null when user does not belong to the site or is not found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await mcpService.getUserDetails(
        siteId,
        'cross-tenant@example.com',
      );

      expect(result).toBeNull();
    });
  });

  describe('McpController.getUserDetails', () => {
    const context: McpValidatedContext = {
      siteId: 'site-123',
      conversationId: 'conv-123',
      authorizedActor: { type: 'service', id: 1 },
    };

    it('returns user profile when user belongs to tenant', async () => {
      const mockUser = {
        id: 'user-1',
        name: 'Agent Smith',
        email: 'agent@example.com',
        phone: '0123456789',
        role: UserRole.AGENT,
        avatarUrl: 'https://avatar.com/1.png',
      };

      mockQueryBuilder.getOne.mockResolvedValue(mockUser);

      const result = await mcpController.getUserDetails(
        'agent@example.com',
        context,
      );

      expect(result).toEqual(mockUser);
    });

    it('returns Guest Visitor fallback when user belongs to different tenant (cross-tenant)', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await mcpController.getUserDetails(
        'unknown@example.com',
        context,
      );

      expect(result).toEqual({
        email: 'unknown@example.com',
        name: 'Guest Visitor',
        role: 'VISITOR',
        phone: null,
      });
    });
  });
});
