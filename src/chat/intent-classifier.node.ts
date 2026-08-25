import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Logger } from '@nestjs/common';
import { AgentState } from './graph-state';
import type {
  CancelFlowAction,
  GraphRunOptions,
  IntentType,
} from './graph-state';
import type { AiService } from './ai.service';
import {
  getCancelFlowClassifierPrompt,
  getIntentClassifierPrompt,
} from './prompts';
import {
  extractBookingCode,
  extractPhoneFromText,
} from './booking-cancellation.utils';
import {
  detectBookingTriggerLocale,
  detectSmallTalkLocale,
  isBookingAbandonment,
  isBookingSlotSelection,
  parseBookingSlotSelection,
  shouldContinueBookingFlow,
} from './chat-flow.utils';
import { UNDETERMINED_LOCALE } from './chat-locale.utils';
import {
  bookingOptionNeedsModel,
  parseBookingOptionSelection,
} from './chat-message-components';

export interface IntentClassifierDeps {
  aiService: AiService;
  logger: Logger;
  options: Pick<
    GraphRunOptions,
    | 'site'
    | 'conversationId'
    | 'siteContext'
    | 'sentimentDetection'
    | 'onNegativeSentiment'
    | 'hasNegativeSentiment'
  >;
  applyLocaleState: (
    intent: IntentType,
    detectedLocale?: string | null,
  ) => Promise<{
    intent: IntentType;
    locale: string;
    activeFlow: string | null;
    activeFlowLocale: string | null;
  }>;
  getActiveFlow: () => string | null;
  getActiveFlowLocale: () => string | null;
  getCurrentLocale: () => string;
  onNegativeSentimentDetected?: () => Promise<void>;
}

export function buildIntentClassifierNode(deps: IntentClassifierDeps) {
  const {
    aiService,
    logger,
    options,
    applyLocaleState,
    getActiveFlow,
    getActiveFlowLocale,
    getCurrentLocale,
    onNegativeSentimentDetected,
  } = deps;

  return async (state: typeof AgentState.State) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const contentStr =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? '');
    const bookingEnabled = state.siteContext.bookingEnabled === true;
    const activeFlow = getActiveFlow();
    const activeFlowLocale = getActiveFlowLocale();
    const currentLocale = getCurrentLocale();

    const isCancelAbortPhrase = (text: string): boolean => {
      if (
        /^\/keep-booking\b/i.test(text) ||
        /^\/(?:abandon-cancel|cancel-abort)\b/i.test(text)
      ) {
        return true;
      }
      if (
        activeFlow === 'CANCELLATION' ||
        (state.cancelState?.step !== null &&
          state.cancelState?.step !== undefined)
      ) {
        return (
          /(?:thôi|không|đừng)\s*(?:hủy|huỷ)(?:\s*nữa)?/i.test(text) ||
          /(?:đổi\s*ý|giữ\s*lịch|bỏ\s*qua|không\s*muốn\s*hủy)/i.test(text) ||
          /\b(?:nevermind|keep\s*my\s*booking|don'?t\s*cancel|abort\s*cancel|stop\s*cancel(?:lation)?)\b/i.test(
            text,
          ) ||
          /(?:キャンセルしない|やめる|維持する|そのまま)/i.test(text)
        );
      }
      return false;
    };

    if (isCancelAbortPhrase(contentStr)) {
      logger.log('[Fast-Path Intent] cancel flow abort');
      return {
        ...(await applyLocaleState('abort_cancel_flow', state.locale)),
        pendingCancelFlowAction: 'ABORT_CANCELLATION' as CancelFlowAction,
        switchTopicAfterAbort: false,
      };
    }

    const extractedCode = extractBookingCode(contentStr);
    const extractedPhone = extractPhoneFromText(contentStr);

    if (/^\/(?:(?:confirm-)?cancel-booking|keep-booking)\b/i.test(contentStr)) {
      return applyLocaleState('cancel_booking', state.locale);
    }

    if (extractedCode && /^[A-Z0-9]{8}$/i.test(contentStr.trim())) {
      logger.log(`[Fast-Path Intent] booking code entered: ${extractedCode}`);
      return applyLocaleState('cancel_booking', state.locale);
    }

    if (
      activeFlow === 'CANCELLATION' &&
      (extractedCode ||
        extractedPhone ||
        contentStr.replace(/\D/g, '').length >= 3)
    ) {
      logger.log(`[Fast-Path Intent] active cancellation input: ${contentStr}`);
      return applyLocaleState('cancel_booking', state.locale);
    }

    if (
      state.cancelState?.step !== null &&
      state.cancelState?.step !== undefined
    ) {
      const cancelStep = state.cancelState.step;

      if (cancelStep === 'ask_code' && extractedCode) {
        return applyLocaleState('cancel_booking', state.locale);
      }
      if (
        cancelStep === 'verify_phone' &&
        (extractedPhone || contentStr.replace(/\D/g, '').length >= 3)
      ) {
        return applyLocaleState('cancel_booking', state.locale);
      }
      if (
        cancelStep === 'await_confirm' &&
        /^\/confirm-cancel-booking\b/i.test(contentStr)
      ) {
        return applyLocaleState('cancel_booking', state.locale);
      }

      try {
        const actionSchema = z.object({
          action: z
            .enum(['PROVIDE_INFO', 'ABORT_CANCELLATION', 'SWITCH_TOPIC'])
            .catch('SWITCH_TOPIC'),
        });
        const model = aiService
          .buildModelForSite(options.site ?? {}, 0, false)
          .withStructuredOutput(actionSchema);
        const actionResult = await model.invoke([
          new SystemMessage(
            getCancelFlowClassifierPrompt(cancelStep, state.locale),
          ),
          new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
        ]);

        logger.log(
          `Cancel flow classifier action: ${actionResult.action} (step: ${cancelStep})`,
        );

        if (actionResult.action === 'PROVIDE_INFO') {
          return applyLocaleState('cancel_booking', state.locale);
        }

        if (actionResult.action === 'ABORT_CANCELLATION') {
          return {
            ...(await applyLocaleState('abort_cancel_flow', state.locale)),
            pendingCancelFlowAction: 'ABORT_CANCELLATION' as CancelFlowAction,
            switchTopicAfterAbort: false,
          };
        }

        if (actionResult.action === 'SWITCH_TOPIC') {
          return {
            ...(await applyLocaleState('abort_cancel_flow', state.locale)),
            pendingCancelFlowAction: 'SWITCH_TOPIC' as CancelFlowAction,
            switchTopicAfterAbort: true,
          };
        }
      } catch (err) {
        logger.warn('Cancel flow classifier failed, falling back', err);
        if (!extractedCode && !extractedPhone) {
          return {
            ...(await applyLocaleState('abort_cancel_flow', state.locale)),
            pendingCancelFlowAction: 'SWITCH_TOPIC' as CancelFlowAction,
            switchTopicAfterAbort: true,
          };
        }
        return applyLocaleState('cancel_booking', state.locale);
      }
    }

    // ── 1. Fast-Path Check (Deterministic routing without LLM call) ──
    if (/^\/(?:update-draft-booking|confirm-booking)\b/i.test(contentStr)) {
      logger.log('[Fast-Path Intent] structured_booking_step (update/confirm)');
      return applyLocaleState('structured_booking_step', activeFlowLocale);
    }

    if (/^\/abandon-booking\b/i.test(contentStr)) {
      logger.log('[Fast-Path Intent] abandoned booking');
      return applyLocaleState(
        'abandon_booking',
        contentStr.match(/"locale"\s*:\s*"([^"]+)"/i)?.[1],
      );
    }

    if (activeFlow === 'BOOKING' && isBookingAbandonment(contentStr)) {
      logger.log('[Fast-Path Intent] natural booking abandonment');
      return applyLocaleState('abandon_booking', activeFlowLocale);
    }

    if (
      activeFlow === 'BOOKING' &&
      /^(?:bỏ\s*qua(?:\s*(?:email|bước\s*này))?|skip(?:\s*email)?|khỏi(?:\s*cần)?\s*email|không\s*(?:cần|dùng|có)?\s*email|スキップ)$/i.test(
        contentStr.trim(),
      )
    ) {
      logger.log('[Fast-Path Intent] structured_booking_step skip_email');
      return applyLocaleState('structured_booking_step', activeFlowLocale);
    }

    const bookingOption = parseBookingOptionSelection(contentStr);
    if (bookingOption) {
      const intent = bookingOptionNeedsModel(bookingOption)
        ? 'book_appointment'
        : 'structured_booking_step';
      logger.log(`[Fast-Path Intent] ${intent} option`);
      return applyLocaleState(intent, bookingOption.locale);
    }

    if (isBookingSlotSelection(contentStr)) {
      logger.log('[Fast-Path Intent] structured_booking_step slot');
      return applyLocaleState(
        'structured_booking_step',
        parseBookingSlotSelection(contentStr)?.language,
      );
    }

    if (/^\/(?:confirm-)?cancel-booking\b/i.test(contentStr)) {
      logger.log('[Fast-Path Intent] cancel_booking');
      return applyLocaleState('cancel_booking', activeFlowLocale);
    }

    if (bookingEnabled) {
      const triggerLocale = detectBookingTriggerLocale(
        contentStr,
        currentLocale,
      );
      if (triggerLocale) {
        logger.log(
          `[Fast-Path Intent] natural book_appointment_init trigger (${triggerLocale})`,
        );
        return applyLocaleState('book_appointment_init', triggerLocale);
      }
    }

    if (!activeFlow) {
      const smallTalkLocale = detectSmallTalkLocale(contentStr, currentLocale);
      if (smallTalkLocale) {
        logger.log(
          `[Fast-Path Intent] small_talk trigger (${smallTalkLocale})`,
        );
        return applyLocaleState('small_talk', smallTalkLocale);
      }
    }

    // ── 2. LLM Intent Classifier ──
    const intents = bookingEnabled
      ? ([
          'question',
          'system_question',
          'out_of_scope',
          'request_human',
          'small_talk',
          'book_appointment',
          'check_booking',
          'cancel_booking',
          'abandon_booking',
        ] as const)
      : ([
          'question',
          'system_question',
          'out_of_scope',
          'request_human',
          'small_talk',
        ] as const);

    const intentSchema = z.object({
      intent: z.enum(intents).catch('small_talk'),
      sentiment: z.enum(['positive', 'neutral', 'negative']).catch('neutral'),
      locale: z.string().catch(UNDETERMINED_LOCALE),
    });

    const model = aiService
      .buildModelForSite(options.site ?? {}, 0, false)
      .withStructuredOutput(intentSchema);

    try {
      const response = await model.invoke([
        new SystemMessage(
          getIntentClassifierPrompt(
            bookingEnabled,
            activeFlow === 'BOOKING',
            state.siteContext.humanHandoffEnabled === true,
          ),
        ),
        new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
      ]);

      logger.log(
        `Intent classified: ${response.intent}, Sentiment: ${response.sentiment}, Locale: ${response.locale}`,
      );

      const intent = shouldContinueBookingFlow(
        activeFlow,
        response.intent,
        contentStr,
        state.siteContext,
      )
        ? 'book_appointment'
        : response.intent;

      if (
        options.sentimentDetection &&
        response.sentiment === 'negative' &&
        options.onNegativeSentiment
      ) {
        if (!options.hasNegativeSentiment) {
          logger.log(
            `Negative sentiment detected for conversation ${options.conversationId}. Alerting agents.`,
          );
          if (onNegativeSentimentDetected) {
            onNegativeSentimentDetected().catch((err: unknown) =>
              logger.error('Failed to notify negative sentiment', err),
            );
          }
        }
      }

      return applyLocaleState(intent, response.locale);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(
        `Intent classification fallback for site ${options.site?.id ?? 'unknown'}: ${errMsg.slice(0, 150)}`,
      );
      return applyLocaleState(
        shouldContinueBookingFlow(activeFlow, 'small_talk')
          ? 'book_appointment'
          : 'small_talk',
        UNDETERMINED_LOCALE,
      );
    }
  };
}
