import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  Conversation,
  HandlingStatus,
} from '../chat/entities/conversation.entity';
import {
  ChatMessage,
  FeedbackRating,
  SenderType,
} from '../chat/entities/chat-message.entity';
import { Site } from '../site/entities/site.entity';
import { User } from '../user/entities/user.entity';
import { Organization } from '../organization/entities/organization.entity';
import { Document } from '../document/entities/document.entity';
import { DocumentChunk } from '../document/entities/document-chunk.entity';
import { UserRole } from '../user/enums/user-role.enum';
import type { JwtUser } from '../auth/types/jwt-user.type';
import {
  DashboardAnalyticsDto,
  ChatActivityPointDto,
} from './dto/analytics-dashboard.dto';

function formatTokens(t: number): string {
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1_000) return `${(t / 1_000).toFixed(1)}K`;
  return t.toString();
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly chatMessageRepo: Repository<ChatMessage>,
    @InjectRepository(Site)
    private readonly siteRepo: Repository<Site>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(Document)
    private readonly documentRepo: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly documentChunkRepo: Repository<DocumentChunk>,
  ) {}

  async getDashboardAnalytics(
    user: JwtUser,
    startDateStr?: string,
    endDateStr?: string,
  ): Promise<DashboardAnalyticsDto> {
    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;
    const isAgent = user.role === UserRole.AGENT;
    const orgId = user.organizationId;

    // 1. Get site IDs within scope based on User Role
    let siteIds: string[] = [];
    if (isSuperAdmin) {
      const sites = await this.siteRepo.find({ select: { id: true } });
      siteIds = sites.map((s) => s.id);
    } else if (isAgent) {
      const assignedSites = await this.siteRepo
        .createQueryBuilder('site')
        .innerJoin('site.agents', 'agent', 'agent.id = :userId', {
          userId: user.id,
        })
        .select('site.id')
        .getMany();
      siteIds = assignedSites.map((s) => s.id);
    } else if (orgId) {
      const sites = await this.siteRepo.find({
        where: [{ organizationId: orgId }, { ownerId: user.id }],
        select: { id: true },
      });
      siteIds = sites.map((s) => s.id);
    }

    // 2. Count Sites
    let totalSites = 0;
    let activeSites = 0;

    if (isSuperAdmin) {
      totalSites = await this.siteRepo.count();
      activeSites = await this.siteRepo.count({ where: { isAiActive: true } });
    } else if (isAgent) {
      totalSites = siteIds.length;
      if (siteIds.length > 0) {
        activeSites = await this.siteRepo.count({
          where: { id: In(siteIds), isAiActive: true },
        });
      }
    } else if (orgId) {
      totalSites = await this.siteRepo.count({
        where: [{ organizationId: orgId }, { ownerId: user.id }],
      });
      activeSites = await this.siteRepo.count({
        where: [
          { organizationId: orgId, isAiActive: true },
          { ownerId: user.id, isAiActive: true },
        ],
      });
    }

    // 3. Count Organizations
    let totalOrganizations = 0;
    let activeOrganizations = 0;

    if (isSuperAdmin) {
      totalOrganizations = await this.orgRepo.count();
      activeOrganizations = await this.orgRepo.count({
        where: { status: 'Active' },
      });
    } else if (orgId) {
      totalOrganizations = 1;
      const org = await this.orgRepo.findOne({ where: { id: orgId } });
      activeOrganizations = org && org.status === 'Active' ? 1 : 0;
    }

    // 4. Count Agents
    let totalAgents = 0;
    if (isSuperAdmin) {
      totalAgents = await this.userRepo.count({
        where: { role: UserRole.AGENT },
      });
    } else if (isAgent) {
      totalAgents = 1;
    } else if (orgId) {
      totalAgents = await this.userRepo.count({
        where: { organizationId: orgId, role: UserRole.AGENT },
      });
    }

    // 5. Count Conversations & Containment Rate
    let totalChats = 0;
    let aiHandledCount = 0;
    let agentHandledCount = 0;
    let recentConversations: Conversation[] = [];

    if (siteIds.length > 0) {
      totalChats = await this.conversationRepo.count({
        where: { siteId: In(siteIds) },
      });

      aiHandledCount = await this.conversationRepo.count({
        where: {
          siteId: In(siteIds),
          handlingStatus: HandlingStatus.AI_HANDLING,
        },
      });

      agentHandledCount = await this.conversationRepo.count({
        where: {
          siteId: In(siteIds),
          handlingStatus: In([
            HandlingStatus.AGENT_HANDLING,
            HandlingStatus.WAITING_FOR_AGENT,
          ]),
        },
      });

      recentConversations = await this.conversationRepo.find({
        where: { siteId: In(siteIds) },
        relations: { site: true },
        order: { createdAt: 'DESC' },
        take: 5,
      });
    }

    // 5.1. Count User Feedback (Helpful / Unhelpful)
    let helpfulCount = 0;
    let unhelpfulCount = 0;

    if (siteIds.length > 0) {
      const feedbackCounts = await this.chatMessageRepo
        .createQueryBuilder('message')
        .innerJoin('message.conversation', 'conversation')
        .select('message.feedbackRating', 'rating')
        .addSelect('COUNT(message.id)', 'count')
        .where('conversation.siteId IN (:...siteIds)', { siteIds })
        .andWhere('message.feedbackRating IS NOT NULL')
        .groupBy('message.feedbackRating')
        .getRawMany<{ rating: FeedbackRating; count: string }>();

      for (const row of feedbackCounts) {
        const countVal = parseInt(row.count, 10) || 0;
        if (row.rating === FeedbackRating.HELPFUL) {
          helpfulCount = countVal;
        } else if (row.rating === FeedbackRating.UNHELPFUL) {
          unhelpfulCount = countVal;
        }
      }
    }

    const totalCalculated = aiHandledCount + agentHandledCount;
    let aiResolved = 80;
    let agentHandoff = 20;

    if (totalCalculated > 0) {
      aiResolved = Math.round((aiHandledCount / totalCalculated) * 100);
      agentHandoff = 100 - aiResolved;
    }

    // 6. Real Avg Agent Response Time calculation (Turn-based precomputed responseTimeSec)
    let avgResponseTime = 'N/A';
    if (siteIds.length > 0) {
      try {
        const resTimeRaw = await this.chatMessageRepo
          .createQueryBuilder('m')
          .innerJoin('m.conversation', 'c')
          .select('AVG(m.responseTimeSec)', 'avgDiff')
          .where('c.siteId IN (:...siteIds)', { siteIds })
          .andWhere('m.senderType = :agentType', {
            agentType: SenderType.AGENT,
          })
          .andWhere('m.responseTimeSec IS NOT NULL')
          .getRawOne<{ avgDiff: string | null }>();

        let diffStr = resTimeRaw?.avgDiff;

        // Fallback to on-the-fly calculation for historical messages not yet backfilled
        if (!diffStr) {
          const legacyRaw = await this.chatMessageRepo.manager.query<
            { avgDiff: string | null }[]
          >(
            `SELECT AVG(EXTRACT(EPOCH FROM (agent."createdAt" - (
               SELECT MAX(v."createdAt")
               FROM chat_messages v
               WHERE v."conversationId" = agent."conversationId"
                 AND v."senderType" = $1
                 AND v."createdAt" < agent."createdAt"
                 AND v."createdAt" >= agent."createdAt" - INTERVAL '1 hour'
             )))) AS "avgDiff"
             FROM chat_messages agent
             INNER JOIN conversations c ON c.id = agent."conversationId"
             WHERE c."siteId" = ANY($2)
               AND agent."senderType" = $3`,
            [SenderType.VISITOR, siteIds, SenderType.AGENT],
          );
          diffStr = legacyRaw?.[0]?.avgDiff;
        }

        if (diffStr) {
          const sec = parseFloat(diffStr);
          if (!isNaN(sec) && sec > 0) {
            if (sec >= 60) {
              const mins = Math.floor(sec / 60);
              const remainingSec = Math.round(sec % 60);
              avgResponseTime =
                remainingSec > 0 ? `${mins}m ${remainingSec}s` : `${mins}m`;
            } else {
              avgResponseTime = `${Math.round(sec)}s`;
            }
          }
        }
      } catch {
        // Fallback default
      }
    }

    // 7. Real Token Usage calculation (only AI messages consume LLM tokens)
    let totalTokens = 0;
    if (siteIds.length > 0) {
      const tokenSumRaw = await this.chatMessageRepo
        .createQueryBuilder('m')
        .innerJoin('m.conversation', 'c')
        .select('SUM(COALESCE(m.tokenCount, 0))', 'total')
        .where('c.siteId IN (:...siteIds)', { siteIds })
        .andWhere('m.senderType = :aiSender', { aiSender: SenderType.AI })
        .getRawOne<{ total: string | null }>();

      totalTokens = parseInt(tokenSumRaw?.total || '0', 10) || 0;
    }
    const estimatedCost = Number(((totalTokens / 1000) * 0.02).toFixed(2));

    // 8. Real Chat Activity & Token Activity Groupings (Daily, Weekly, Monthly)
    const dailyActivity: ChatActivityPointDto[] = [];
    const dailyTokenActivity: ChatActivityPointDto[] = [];

    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let startDateObj: Date;
    let endDateObj: Date;
    let isCustomRange = false;

    if (startDateStr && endDateStr) {
      isCustomRange = true;
      startDateObj = new Date(startDateStr + 'T00:00:00.000Z');
      endDateObj = new Date(endDateStr + 'T23:59:59.999Z');
    } else {
      startDateObj = new Date();
      startDateObj.setDate(startDateObj.getDate() - 6);
      startDateObj.setHours(0, 0, 0, 0);
      endDateObj = new Date();
    }

    const dailyChatMap: Record<string, number> = {};
    const dailyTokenMap: Record<string, number> = {};

    if (siteIds.length > 0) {
      const dailyChatRows = await this.conversationRepo
        .createQueryBuilder('c')
        .select("TO_CHAR(c.createdAt, 'YYYY-MM-DD')", 'dayStr')
        .addSelect('COUNT(c.id)', 'count')
        .where('c.siteId IN (:...siteIds)', { siteIds })
        .andWhere('c.createdAt >= :startDate', { startDate: startDateObj })
        .andWhere('c.createdAt <= :endDate', { endDate: endDateObj })
        .groupBy("TO_CHAR(c.createdAt, 'YYYY-MM-DD')")
        .getRawMany<{ dayStr: string; count: string }>();

      for (const row of dailyChatRows) {
        dailyChatMap[row.dayStr] = parseInt(row.count, 10) || 0;
      }

      const dailyTokenRows = await this.chatMessageRepo
        .createQueryBuilder('m')
        .innerJoin('m.conversation', 'c')
        .select("TO_CHAR(m.createdAt, 'YYYY-MM-DD')", 'dayStr')
        .addSelect('SUM(COALESCE(m.tokenCount, 0))', 'tokenSum')
        .where('c.siteId IN (:...siteIds)', { siteIds })
        .andWhere('m.senderType = :aiSender', { aiSender: SenderType.AI })
        .andWhere('m.createdAt >= :startDate', { startDate: startDateObj })
        .andWhere('m.createdAt <= :endDate', { endDate: endDateObj })
        .groupBy("TO_CHAR(m.createdAt, 'YYYY-MM-DD')")
        .getRawMany<{ dayStr: string; tokenSum: string }>();

      for (const row of dailyTokenRows) {
        dailyTokenMap[row.dayStr] = parseInt(row.tokenSum, 10) || 0;
      }
    }

    if (isCustomRange) {
      const curr = new Date(startDateObj);
      while (curr <= endDateObj) {
        const dayStr = curr.toISOString().slice(0, 10);
        const dayOfMonth = curr.getUTCDate();
        const monthNum = curr.getUTCMonth() + 1;
        const label = `${dayOfMonth < 10 ? '0' : ''}${dayOfMonth}/${monthNum < 10 ? '0' : ''}${monthNum}`;

        dailyActivity.push({
          label,
          value: dailyChatMap[dayStr] || 0,
        });

        dailyTokenActivity.push({
          label,
          value: dailyTokenMap[dayStr] || 0,
        });

        curr.setUTCDate(curr.getUTCDate() + 1);
      }
    } else {
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const label = dayNames[d.getDay()];

        dailyActivity.push({
          label,
          value: dailyChatMap[dayStr] || 0,
        });

        dailyTokenActivity.push({
          label,
          value: dailyTokenMap[dayStr] || 0,
        });
      }
    }

    // 8.2 Weekly (last 4 weeks)
    const weeklyActivity: ChatActivityPointDto[] = [];
    const weeklyTokenActivity: ChatActivityPointDto[] = [];

    for (let w = 3; w >= 0; w--) {
      const weekLabel = `Week ${4 - w}`;
      const startW = new Date();
      startW.setDate(now.getDate() - (w + 1) * 7);
      const endW = new Date();
      endW.setDate(now.getDate() - w * 7);

      let wChatCount = 0;
      let wTokenCount = 0;

      if (siteIds.length > 0) {
        wChatCount = await this.conversationRepo
          .createQueryBuilder('c')
          .where('c.siteId IN (:...siteIds)', { siteIds })
          .andWhere('c.createdAt >= :startW AND c.createdAt < :endW', {
            startW,
            endW,
          })
          .getCount();

        const wTokenRaw = await this.chatMessageRepo
          .createQueryBuilder('m')
          .innerJoin('m.conversation', 'c')
          .select('SUM(COALESCE(m.tokenCount, 0))', 'sum')
          .where('c.siteId IN (:...siteIds)', { siteIds })
          .andWhere('m.senderType = :aiSender', { aiSender: SenderType.AI })
          .andWhere('m.createdAt >= :startW AND m.createdAt < :endW', {
            startW,
            endW,
          })
          .getRawOne<{ sum: string | null }>();

        wTokenCount = parseInt(wTokenRaw?.sum || '0', 10) || 0;
      }

      weeklyActivity.push({ label: weekLabel, value: wChatCount });
      weeklyTokenActivity.push({ label: weekLabel, value: wTokenCount });
    }

    // 8.3 Monthly (last 6 months)
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthlyActivity: ChatActivityPointDto[] = [];
    const monthlyTokenActivity: ChatActivityPointDto[] = [];

    for (let m = 5; m >= 0; m--) {
      const targetDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const nextMonthDate = new Date(
        now.getFullYear(),
        now.getMonth() - m + 1,
        1,
      );
      const label = monthNames[targetDate.getMonth()];

      let mChatCount = 0;
      let mTokenCount = 0;

      if (siteIds.length > 0) {
        mChatCount = await this.conversationRepo
          .createQueryBuilder('c')
          .where('c.siteId IN (:...siteIds)', { siteIds })
          .andWhere(
            'c.createdAt >= :targetDate AND c.createdAt < :nextMonthDate',
            {
              targetDate,
              nextMonthDate,
            },
          )
          .getCount();

        const mTokenRaw = await this.chatMessageRepo
          .createQueryBuilder('m')
          .innerJoin('m.conversation', 'c')
          .select('SUM(COALESCE(m.tokenCount, 0))', 'sum')
          .where('c.siteId IN (:...siteIds)', { siteIds })
          .andWhere('m.senderType = :aiSender', { aiSender: SenderType.AI })
          .andWhere(
            'm.createdAt >= :targetDate AND m.createdAt < :nextMonthDate',
            {
              targetDate,
              nextMonthDate,
            },
          )
          .getRawOne<{ sum: string | null }>();

        mTokenCount = parseInt(mTokenRaw?.sum || '0', 10) || 0;
      }

      monthlyActivity.push({ label, value: mChatCount });
      monthlyTokenActivity.push({ label, value: mTokenCount });
    }

    // 9. Real Top Documents from database
    let topDocuments: Array<{
      id: string;
      name: string;
      siteName: string;
      hits: number;
    }> = [];
    if (siteIds.length > 0) {
      try {
        const docs = await this.documentRepo
          .createQueryBuilder('d')
          .innerJoin('d.site', 's')
          .leftJoin('d.chunks', 'dc')
          .select('d.id', 'id')
          .addSelect('d.filename', 'name')
          .addSelect('s.name', 'siteName')
          .addSelect('COUNT(dc.id)', 'chunkCount')
          .where('d.siteId IN (:...siteIds)', { siteIds })
          .groupBy('d.id')
          .addGroupBy('d.filename')
          .addGroupBy('s.name')
          .orderBy('d.uploadedAt', 'DESC')
          .limit(10)
          .getRawMany<{
            id: string;
            name: string;
            siteName: string;
            chunkCount: string;
          }>();

        topDocuments = docs.map((doc) => ({
          id: doc.id,
          name: doc.name,
          siteName: doc.siteName,
          hits: Math.max(parseInt(doc.chunkCount, 10) || 1, 1),
        }));
      } catch {
        // Fallback empty
      }
    }

    // 10. Real Usage by Site from database
    let usageBySite: Array<{
      siteId: string;
      siteName: string;
      tokens: number;
      percentage: number;
      estimatedCost: string;
    }> = [];
    if (siteIds.length > 0) {
      try {
        const siteUsageRows = await this.siteRepo
          .createQueryBuilder('s')
          .leftJoin('conversations', 'c', 'c.siteId = s.id')
          .leftJoin(
            'chat_messages',
            'm',
            'm.conversationId = c.id AND m.senderType = :aiSender',
            { aiSender: SenderType.AI },
          )
          .select('s.id', 'siteId')
          .addSelect('s.name', 'siteName')
          .addSelect('COALESCE(SUM(m.tokenCount), 0)', 'tokens')
          .where('s.id IN (:...siteIds)', { siteIds })
          .groupBy('s.id')
          .addGroupBy('s.name')
          .orderBy('"tokens"', 'DESC')
          .getRawMany<{ siteId: string; siteName: string; tokens: string }>();

        const grandTotal = siteUsageRows.reduce(
          (acc, row) => acc + (parseInt(row.tokens, 10) || 0),
          0,
        );

        usageBySite = siteUsageRows.map((row) => {
          const siteTokens = parseInt(row.tokens, 10) || 0;
          const pct =
            grandTotal > 0 ? Math.round((siteTokens / grandTotal) * 100) : 0;
          const estCost = `$${((siteTokens / 1000) * 0.02).toFixed(2)}`;
          return {
            siteId: row.siteId,
            siteName: row.siteName,
            tokens: siteTokens,
            percentage: pct,
            estimatedCost: estCost,
          };
        });
      } catch {
        // Fallback empty
      }
    }

    // 11. Map Recent Activity
    const recentActivity = recentConversations.map((conv) => {
      const minutesAgo = Math.max(
        Math.floor((Date.now() - new Date(conv.createdAt).getTime()) / 60000),
        1,
      );
      const timeAgo =
        minutesAgo < 60
          ? `${minutesAgo} min ago`
          : `${Math.floor(minutesAgo / 60)} hour(s) ago`;

      return {
        id: conv.id,
        type:
          conv.handlingStatus === HandlingStatus.AGENT_HANDLING
            ? 'agent'
            : 'chat',
        title: `Chat session on ${conv.site?.name || 'Site'}`,
        description: `Visitor ${conv.visitorName} (${conv.visitorEmail})`,
        time: new Date(conv.createdAt).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        timeAgo,
      };
    });

    return {
      stats: [
        {
          id: 'total-chats',
          title: 'Total Chats',
          value: totalChats.toLocaleString('en-US'),
          icon: 'message',
          iconColor: '#6366f1',
          iconBg: '#ede9fe',
          isMock: false,
        },
        {
          id: 'active-sites',
          title: 'Active Sites',
          value: activeSites.toString(),
          icon: 'global',
          iconColor: '#10b981',
          iconBg: '#d1fae5',
          isMock: false,
        },
        {
          id: 'avg-response-time',
          title: 'Agent Response Time',
          value: avgResponseTime,
          icon: 'clock',
          iconColor: '#f59e0b',
          iconBg: '#fef3c7',
          isMock: false,
        },
        {
          id: 'token-usage',
          title: 'Token Usage',
          value: formatTokens(totalTokens),
          icon: 'api',
          iconColor: '#8b5cf6',
          iconBg: '#f3e8ff',
          isMock: false,
        },
      ],
      totalChats,
      activeSites,
      totalSites,
      totalOrganizations,
      activeOrganizations,
      totalAgents,
      totalTokens,
      avgResponseTime,
      estimatedCost,
      containmentRate: {
        aiResolved,
        agentHandoff,
      },
      chatActivity: {
        daily: dailyActivity,
        weekly: weeklyActivity,
        monthly: monthlyActivity,
      },
      tokenUsage: {
        daily: dailyTokenActivity,
        weekly: weeklyTokenActivity,
        monthly: monthlyTokenActivity,
      },
      userFeedback: [
        { label: 'Helpful', value: helpfulCount, color: '#10b981' },
        { label: 'Not Helpful', value: unhelpfulCount, color: '#ef4444' },
      ],
      recentActivity:
        recentActivity.length > 0
          ? recentActivity
          : [
              {
                id: '1',
                type: 'chat',
                title: 'System Initialized',
                description:
                  'Analytics engine connected and tracking live metrics.',
                time: '12:00',
                timeAgo: 'Just now',
              },
            ],
      topDocuments,
      usageBySite,
    };
  }
}
