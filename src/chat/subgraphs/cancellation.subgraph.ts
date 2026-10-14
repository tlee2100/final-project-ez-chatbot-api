import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { Logger } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { AgentState } from '../graph-state';
import type { CancelFlowAction, CancelState, CancelStep } from '../graph-state';
import type { IToolProvider } from '../interfaces/tool-provider.interface';
import type { BookingService } from '../../booking/booking.service';
import type { ChatGateway } from '../chat.gateway';
import { getAbortChip, getCancelPrompts } from '../prompts';
import {
  extractBookingCode,
  extractPhoneFromText,
  normalizePhone,
} from '../booking-cancellation.utils';
import { localeLanguage } from '../chat-locale.utils';

export interface CancellationSubgraphDeps {
  toolProvider: IToolProvider;
  bookingService: BookingService;
  logger: Logger;
  conversationId: string;
  siteId: string;
  chatGateway: ChatGateway;
  res?: ExpressResponse;
  server: SocketServer;
  clearActiveFlow: () => Promise<void>;
  activeConversationBookingCode: (
    state: typeof AgentState.State,
  ) => Promise<string | undefined>;
  onCancelledBookingCode?: (code: string) => void;
}

const messageText = (message: BaseMessage): string => {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (
          c &&
          typeof c === 'object' &&
          'text' in c &&
          typeof (c as { text: string }).text === 'string'
        ) {
          return (c as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return JSON.stringify(message.content);
};

const getLatestUserText = (state: typeof AgentState.State): string => {
  const msg = [...state.messages]
    .reverse()
    .find((m) => m.constructor?.name?.includes('HumanMessage'));
  return msg ? messageText(msg) : '';
};

const buildCancellationPayload = (booking: {
  code: string;
  status: string;
  customerName: string;
  phone: string;
  serviceId?: string | null;
  service?: { name: string } | null;
  resourceId?: string | null;
  resource?: { name: string } | null;
  startAt: Date;
  timezone: string;
}) => ({
  bookingCode: booking.code,
  status: booking.status,
  customerName: booking.customerName,
  phone: booking.phone,
  serviceId: booking.serviceId ?? undefined,
  serviceName: booking.service?.name,
  resourceId: booking.resourceId ?? undefined,
  resourceName: booking.resource?.name,
  date: formatInTimeZone(booking.startAt, booking.timezone, 'yyyy-MM-dd'),
  timeSlot: formatInTimeZone(booking.startAt, booking.timezone, 'HH:mm'),
});

/**
 * CancellationSubgraph — state machine for booking cancellation with phone verification & interrupt().
 */
export function buildCancellationSubgraph(deps: CancellationSubgraphDeps) {
  const {
    toolProvider,
    bookingService,
    logger,
    conversationId,
    siteId,
    chatGateway,
    res,
    server,
    clearActiveFlow,
    activeConversationBookingCode,
    onCancelledBookingCode,
  } = deps;

  const askCodeNode = async (state: typeof AgentState.State) => {
    const userText = getLatestUserText(state);
    const prompts = getCancelPrompts(state.locale);
    const abortChip = getAbortChip(state.locale);
    const bookingCode =
      state.cancelState?.bookingCode ??
      extractBookingCode(userText) ??
      (await activeConversationBookingCode(state));

    if (!bookingCode) {
      return {
        cancelState: {
          step: 'ask_code' as CancelStep,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [
          new AIMessage(`${prompts.askCode} [cancel:ask_code|]${abortChip}`),
        ],
      };
    }

    const booking = await bookingService
      .getBookingByCode(siteId, bookingCode)
      .catch(() => null);

    if (!booking) {
      await clearActiveFlow();
      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [new AIMessage(prompts.notFound)],
      };
    }

    if (booking.status.toLowerCase() === 'cancelled') {
      await clearActiveFlow();
      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [new AIMessage(prompts.alreadyCancelled)],
      };
    }

    return {
      cancelState: {
        step: 'verify_phone' as CancelStep,
        bookingCode,
        phoneVerified: false,
      },
      messages: [
        new AIMessage(
          `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]${abortChip}`,
        ),
      ],
    };
  };

  const verifyPhoneNode = async (state: typeof AgentState.State) => {
    const userText = getLatestUserText(state);
    const prompts = getCancelPrompts(state.locale);
    const bookingCode =
      state.cancelState?.bookingCode ??
      extractBookingCode(userText) ??
      (await activeConversationBookingCode(state));
    const abortChip = getAbortChip(state.locale);
    const isVi = localeLanguage(state.locale) === 'vi';

    if (!bookingCode) {
      return {
        cancelState: {
          step: 'ask_code' as CancelStep,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [
          new AIMessage(`${prompts.askCode} [cancel:ask_code|]${abortChip}`),
        ],
      };
    }

    if (conversationId.startsWith('admin-test-')) {
      const testCancellationPayload = {
        bookingCode,
        status: 'confirmed',
        customerName: 'Admin Tester',
        phone: '0901234567',
        serviceId: undefined,
        serviceName: 'Dịch vụ thử nghiệm',
        resourceId: undefined,
        resourceName: 'Nhân viên thử nghiệm',
        date: new Date().toISOString().split('T')[0],
        timeSlot: '10:00',
      };

      if (!/^\/confirm-cancel-booking\b/i.test(userText)) {
        chatGateway.emitBookingCancellation(
          conversationId,
          testCancellationPayload,
        );
        return {
          messages: [
            new AIMessage(
              isVi
                ? 'Vui lòng kiểm tra và xác nhận hủy lịch.'
                : 'Please review and confirm the booking cancellation.',
            ),
          ],
        };
      }

      if (onCancelledBookingCode) {
        onCancelledBookingCode(bookingCode);
      }
      chatGateway.emitBookingCancelled(conversationId, {
        ...testCancellationPayload,
        status: 'cancelled',
      });
      return {
        messages: [
          new AIMessage(
            isVi
              ? 'Lịch đặt thử nghiệm của bạn đã được hủy.'
              : 'Your test booking has been cancelled.',
          ),
        ],
      };
    }

    const booking = await bookingService
      .getBookingByCode(siteId, bookingCode)
      .catch(() => null);

    if (!booking) {
      await clearActiveFlow();
      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [new AIMessage(prompts.notFound)],
      };
    }

    const providedPhone = extractPhoneFromText(userText);
    if (!providedPhone) {
      return {
        cancelState: state.cancelState,
        messages: [
          new AIMessage(
            `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]${abortChip}`,
          ),
        ],
      };
    }

    const isPhoneMatch =
      normalizePhone(providedPhone) === normalizePhone(booking.phone);

    if (!isPhoneMatch) {
      return {
        cancelState: state.cancelState,
        messages: [
          new AIMessage(
            `${prompts.phoneWrong} [cancel:verify_phone|${bookingCode}]${abortChip}`,
          ),
        ],
      };
    }

    const payload = {
      ...buildCancellationPayload(booking),
      locale: state.locale,
    };
    chatGateway.emitBookingCancellation(conversationId, payload);

    logger.log({
      event: 'cancel_interrupt_start',
      conversationId,
    });

    // INTERRUPT — graph pause here, waiting for user confirm-cancel or keep-booking
    const userDecision = interrupt<
      { type: string; conversationId: string },
      string
    >({
      type: 'cancel_confirmation',
      conversationId,
    });

    logger.log({
      event: 'cancel_interrupt_resumed',
      conversationId,
      decisionPrefix:
        typeof userDecision === 'string'
          ? userDecision.slice(0, 30)
          : 'non-string',
    });

    if (typeof userDecision === 'string') {
      if (/^\/keep-booking\b/i.test(userDecision)) {
        await clearActiveFlow();
        return {
          cancelState: {
            step: null,
            bookingCode: null,
            phoneVerified: false,
          },
          exitSubgraph: 'switch_topic' as const,
        };
      }

      if (!/^\/confirm-cancel-booking\b/i.test(userDecision)) {
        await clearActiveFlow();
        return {
          cancelState: {
            step: null,
            bookingCode: null,
            phoneVerified: false,
          },
          exitSubgraph: 'switch_topic' as const,
        };
      }
    }

    return {
      cancelState: {
        step: 'await_confirm' as CancelStep,
        bookingCode,
        phoneVerified: true,
      },
      messages: [
        new HumanMessage(typeof userDecision === 'string' ? userDecision : ''),
      ],
    };
  };

  const confirmExecuteNode = async (state: typeof AgentState.State) => {
    const userText = getLatestUserText(state);
    const prompts = getCancelPrompts(state.locale);
    const { bookingCode } = state.cancelState;

    if (/^\/keep-booking\b/i.test(userText)) {
      await clearActiveFlow();
      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [new AIMessage(prompts.keepConfirmed)],
      };
    }

    if (/^\/confirm-cancel-booking\b/i.test(userText)) {
      if (!bookingCode) {
        await clearActiveFlow();
        return {
          cancelState: {
            step: null,
            bookingCode: null,
            phoneVerified: false,
          },
          messages: [new AIMessage(prompts.cancelFail)],
        };
      }

      logger.log(
        `[cancelBookingNode] Executing cancelBooking for code: ${bookingCode}`,
      );
      const result = await toolProvider.execute({
        name: 'cancelBooking',
        arguments: { bookingCode },
      });

      const resultOutput = result.output as Record<string, unknown> | undefined;
      if (resultOutput?.status !== 'cancelled') {
        await clearActiveFlow();
        return {
          cancelState: {
            step: null,
            bookingCode: null,
            phoneVerified: false,
          },
          messages: [new AIMessage(prompts.cancelFail)],
        };
      }

      if (onCancelledBookingCode) {
        onCancelledBookingCode(bookingCode);
      }
      const booking = await bookingService
        .getBookingByCode(siteId, bookingCode)
        .catch(() => null);
      if (booking) {
        chatGateway.emitBookingCancelled(conversationId, {
          ...buildCancellationPayload(booking),
          ...resultOutput,
          locale: state.locale,
        });
      }

      await clearActiveFlow();

      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        messages: [new AIMessage(prompts.cancelSuccess)],
      };
    }

    if (!/^\/confirm-cancel-booking\b/i.test(userText)) {
      if (/^\/keep-booking\b/i.test(userText)) {
        await clearActiveFlow();
        return {
          cancelState: {
            step: null,
            bookingCode: null,
            phoneVerified: false,
          },
          messages: [new AIMessage(prompts.keepConfirmed)],
        };
      }

      await clearActiveFlow();
      return {
        cancelState: {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        exitSubgraph: 'switch_topic' as const,
      };
    }
  };

  const abortCancelFlowNode = (state: typeof AgentState.State) => {
    const prompts = getCancelPrompts(state.locale);
    const action = state.pendingCancelFlowAction;
    const resetState: CancelState = {
      step: null,
      bookingCode: null,
      phoneVerified: false,
    };

    if (action === 'SWITCH_TOPIC' || state.switchTopicAfterAbort) {
      logger.log(
        '[abortCancelFlowNode] Topic switch requested — resetting cancelState and re-classifying intent',
      );
      return {
        cancelState: resetState,
        pendingCancelFlowAction: null as CancelFlowAction | null,
        switchTopicAfterAbort: true,
      };
    }

    const keepMsg = prompts.keepConfirmed;
    if (res) {
      res.write(keepMsg);
    }
    server
      ?.to(`conversation-${conversationId}`)
      ?.emit('aiChunk', { token: keepMsg, conversationId });

    return {
      cancelState: resetState,
      pendingCancelFlowAction: null as CancelFlowAction | null,
      switchTopicAfterAbort: false,
      messages: [new AIMessage(keepMsg)],
    };
  };

  const workflow = new StateGraph(AgentState)
    .addNode('ask_code', askCodeNode)
    .addNode('verify_phone', verifyPhoneNode)
    .addNode('confirm_execute', confirmExecuteNode)
    .addNode('abort_cancel_flow', abortCancelFlowNode)
    .addConditionalEdges(
      START,
      (state) => {
        if (state.intent === 'abort_cancel_flow') return 'abort_cancel_flow';
        if (state.cancelState?.step === 'verify_phone') return 'verify_phone';
        if (state.cancelState?.step === 'await_confirm')
          return 'confirm_execute';
        if (state.cancelState?.bookingCode) return 'verify_phone';
        return 'ask_code';
      },
      {
        ask_code: 'ask_code',
        verify_phone: 'verify_phone',
        confirm_execute: 'confirm_execute',
        abort_cancel_flow: 'abort_cancel_flow',
      },
    )
    .addConditionalEdges(
      'ask_code',
      (state) =>
        state.cancelState.step === 'verify_phone' ? 'verify_phone' : END,
      { verify_phone: 'verify_phone', __end__: END },
    )
    .addConditionalEdges(
      'verify_phone',
      (state) => {
        if (state.exitSubgraph === 'switch_topic') return 'abort_cancel_flow';
        if (state.cancelState.step === 'await_confirm')
          return 'confirm_execute';
        return END;
      },
      {
        abort_cancel_flow: 'abort_cancel_flow',
        confirm_execute: 'confirm_execute',
        __end__: END,
      },
    )
    .addEdge('confirm_execute', END)
    .addEdge('abort_cancel_flow', END);

  return workflow.compile();
}
