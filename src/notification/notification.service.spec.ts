import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationService } from './notification.service';
import { NotificationGateway } from './notification.gateway';
import { Notification } from './entities/notification.entity';
import { NotificationType } from './enums/notification-type.enum';

describe('NotificationService', () => {
  let service: NotificationService;

  const mockNotificationRepository = {
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(),
  };

  const mockNotificationGateway = {
    emitNewNotification: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: getRepositoryToken(Notification),
          useValue: mockNotificationRepository,
        },
        {
          provide: NotificationGateway,
          useValue: mockNotificationGateway,
        },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a notification and emit an event', async () => {
      const dto = {
        recipientId: 'user-1',
        type: NotificationType.SYSTEM,
        title: 'Test',
        message: 'Test message',
      };

      const mockNotification = { id: 'notif-1', ...dto };

      mockNotificationRepository.create.mockReturnValue(mockNotification);
      mockNotificationRepository.save.mockResolvedValue(mockNotification);

      const result = await service.create(dto);

      expect(mockNotificationRepository.create).toHaveBeenCalledWith({
        ...dto,
        recipient: { id: dto.recipientId },
        site: null,
        conversation: null,
      });
      expect(mockNotificationRepository.save).toHaveBeenCalledWith(
        mockNotification,
      );
      expect(mockNotificationGateway.emitNewNotification).toHaveBeenCalledWith(
        dto.recipientId,
        mockNotification,
      );
      expect(result).toEqual(mockNotification);
    });
  });

  describe('markAsRead', () => {
    it('should mark an unread notification as read', async () => {
      const mockNotification = { id: 'notif-1', readAt: null };
      mockNotificationRepository.findOne.mockResolvedValue(mockNotification);
      mockNotificationRepository.save.mockImplementation((n) =>
        Promise.resolve(n),
      );

      const result = await service.markAsRead('notif-1', 'user-1');

      expect(mockNotificationRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'notif-1', recipient: { id: 'user-1' } },
        relations: { site: true, conversation: true },
      });
      expect(result.readAt).toBeInstanceOf(Date);
      expect(mockNotificationRepository.save).toHaveBeenCalled();
    });

    it('should not update if already read', async () => {
      const pastDate = new Date('2026-01-01');
      const mockNotification = { id: 'notif-1', readAt: pastDate };
      mockNotificationRepository.findOne.mockResolvedValue(mockNotification);

      const result = await service.markAsRead('notif-1', 'user-1');

      expect(result.readAt).toEqual(pastDate);
      expect(mockNotificationRepository.save).not.toHaveBeenCalled();
    });
  });
});
