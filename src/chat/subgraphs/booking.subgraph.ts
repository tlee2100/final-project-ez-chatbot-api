import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { Logger } from '@nestjs/common';
import { AgentState } from '../graph-state';
import type { GraphRunOptions } from '../graph-state';
import type { AiService } from '../ai.service';
import type { IToolProvider } from '../interfaces/tool-provider.interface';
import type { ChatGateway } from '../chat.gateway';
import type { LLMMessage } from '../interfaces/llm-request.interface';
import { getBookingOptionPrompt, getSlotCardPrompt } from '../prompts';
import { localeLanguage } from '../chat-locale.utils';
import {
  parseBookingOptionSelection,
  extractBookingCommandJson,
} from '../chat-message-components';
import {
  bookAppointmentToolNames,
  parseBookingSlotSelection,
} from '../chat-flow.utils';

export interface BookingSubgraphDeps {
  toolProvider: IToolProvider;
  aiService: AiService;
  logger: Logger;
  conversationId: string;
  siteId: string;
  options: Pick<
    GraphRunOptions,
    | 'site'
    | 'maxTokensPerResponse'
    | 'systemPromptOverride'
    | 'siteContext'
    | 'visitorContext'
  >;
  chatGateway: ChatGateway;
  res?: ExpressResponse;
  server: SocketServer;
  streamedTokensRef?: { count: number };
  bookingTools: DynamicStructuredTool[];
  clearActiveFlow: () => Promise<void>;
  onCreatedBookingCode?: (code: string) => void;
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

/**
 * BookingSubgraph — handles appointment booking flows with interrupt() confirmation.
 */
export function buildBookingSubgraph(deps: BookingSubgraphDeps) {
  const {
    toolProvider,
    aiService,
    logger,
    conversationId,
    options,
    chatGateway,
    res,
    server,
    streamedTokensRef,
    bookingTools,
    clearActiveFlow,
    onCreatedBookingCode,
  } = deps;

  const initBookingNode = (state: typeof AgentState.State) => {
    const services = options.siteContext?.bookingServices ?? [];
    const resources = options.siteContext?.bookingResources ?? [];
    const templateId = options.siteContext?.industryTemplateId;
    if (services.length > 0) {
      const prompt = getBookingOptionPrompt(
        state.locale,
        'service',
        templateId,
      );
      return {
        messages: [
          new AIMessage(`${prompt}\n\n<booking-step>service</booking-step>`),
        ],
      };
    }
    if (resources.length > 0) {
      const prompt = getBookingOptionPrompt(
        state.locale,
        'resource',
        templateId,
      );
      return {
        messages: [
          new AIMessage(`${prompt}\n\n<booking-step>resource</booking-step>`),
        ],
      };
    }
    const prompt = getBookingOptionPrompt(state.locale, 'date', templateId);
    return {
      messages: [
        new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
      ],
    };
  };

  const structuredBookingStepNode = async (state: typeof AgentState.State) => {
    const userText = getLatestUserText(state).trim();
    const locale = state.locale;
    const bookingOption =
      parseBookingOptionSelection(userText) ??
      (/^(?:bỏ\s*qua(?:\s*(?:email|bước\s*này))?|skip(?:\s*email)?|khỏi(?:\s*cần)?\s*email|không\s*(?:cần|dùng|có)?\s*email|スキップ)$/i.test(
        userText,
      )
        ? { action: 'skip_email' as const }
        : null);
    const slotSelection = parseBookingSlotSelection(userText);
    const services = options.siteContext?.bookingServices ?? [];
    const resources = options.siteContext?.bookingResources ?? [];
    const lang = localeLanguage(locale);

    // 1. Handle /update-draft-booking command
    const updateDraftJson = extractBookingCommandJson(
      userText,
      'update-draft-booking',
    );
    if (updateDraftJson) {
      try {
        const draftPayload = JSON.parse(updateDraftJson) as Record<
          string,
          unknown
        >;
        const service = services.find((s) => s.id === draftPayload.serviceId);
        const resource = resources.find(
          (r) => r.id === draftPayload.resourceId,
        );

        const holdDate =
          typeof draftPayload.date === 'string' ? draftPayload.date : '';
        const holdTimeSlot =
          typeof draftPayload.timeSlot === 'string'
            ? draftPayload.timeSlot
            : '';
        const holdResourceId =
          typeof draftPayload.resourceId === 'string'
            ? draftPayload.resourceId
            : '';

        let updatedSessionId =
          typeof draftPayload.sessionId === 'string'
            ? draftPayload.sessionId
            : undefined;

        // Always use conversationId as fallback — the original holdSlot
        // call used conversationId when no sessionId was provided, so we
        // must match it here to release old holds correctly.
        const effectiveSessionId = updatedSessionId || conversationId;

        if (toolProvider && holdResourceId && holdDate && holdTimeSlot) {
          try {
            logger.log(
              `[Structured Step] Updating hold on draft edit: date=${holdDate}, timeSlot=${holdTimeSlot}, resourceId=${holdResourceId}, sessionId=${effectiveSessionId}`,
            );
            const holdResult = await toolProvider.execute({
              name: 'holdSlot',
              arguments: {
                resourceId: holdResourceId,
                serviceId: draftPayload.serviceId,
                date: holdDate,
                timeSlot: holdTimeSlot,
                slotCount:
                  typeof draftPayload.slotCount === 'number'
                    ? draftPayload.slotCount
                    : Array.isArray(draftPayload.slots)
                      ? draftPayload.slots.length
                      : 1,
                slots: draftPayload.slots,
                sessionId: effectiveSessionId,
              },
            });
            if (
              holdResult?.output &&
              typeof holdResult.output === 'object' &&
              'sessionId' in holdResult.output
            ) {
              updatedSessionId = (holdResult.output as { sessionId: string })
                .sessionId;
            }
          } catch (holdErr) {
            logger.error(
              '[Structured Step] Failed to hold slot on update-draft-booking',
              holdErr,
            );
          }
        }

        const rawServiceIds = Array.isArray(draftPayload.serviceIds)
          ? (draftPayload.serviceIds as string[])
          : draftPayload.serviceId
            ? [draftPayload.serviceId as string]
            : [];
        const serviceNames: string[] = [];
        for (const sId of rawServiceIds) {
          const matched = services.find((s) => s.id === sId);
          if (matched) serviceNames.push(matched.name);
        }

        chatGateway.emitBookingSummary(conversationId, {
          ...draftPayload,
          sessionId: updatedSessionId || effectiveSessionId,
          locale: state.activeFlowLocale ?? state.locale,
          serviceId: rawServiceIds[0] ?? service?.id,
          serviceIds: rawServiceIds.length > 0 ? rawServiceIds : undefined,
          serviceName:
            serviceNames[0] ??
            service?.name ??
            (draftPayload.serviceName as string),
          serviceNames: serviceNames.length > 0 ? serviceNames : undefined,
          resourceName: resource?.name ?? (draftPayload.resourceName as string),
        });
        const prompt =
          lang === 'vi'
            ? 'Vui lòng xem lại thông tin đặt lịch ở thẻ bên dưới và bấm xác nhận để hoàn tất.'
            : lang === 'ja'
              ? '下のカードで予約内容を確認し、確定してください。'
              : 'Please review the booking details on the card below and confirm to complete.';
        return {
          messages: [new AIMessage(prompt)],
        };
      } catch (err) {
        logger.error('[Structured Step] Failed update-draft-booking', err);
      }
    }

    // 2. Handle /confirm-booking command
    const confirmBookingJson = extractBookingCommandJson(
      userText,
      'confirm-booking',
    );
    if (confirmBookingJson && toolProvider) {
      try {
        const confirmPayload = JSON.parse(confirmBookingJson) as Record<
          string,
          unknown
        >;
        const cleanedConfirmPayload = { ...confirmPayload };
        if (
          typeof cleanedConfirmPayload.serviceId === 'string' &&
          !cleanedConfirmPayload.serviceId.trim()
        ) {
          delete cleanedConfirmPayload.serviceId;
        }
        if (Array.isArray(cleanedConfirmPayload.serviceIds)) {
          const filtered = (
            cleanedConfirmPayload.serviceIds as string[]
          ).filter((id) => typeof id === 'string' && id.trim().length > 0);
          if (filtered.length > 0) {
            cleanedConfirmPayload.serviceIds = filtered;
          } else {
            delete cleanedConfirmPayload.serviceIds;
          }
        }
        if (Array.isArray(cleanedConfirmPayload.slots)) {
          cleanedConfirmPayload.slots = (
            cleanedConfirmPayload.slots as Array<Record<string, unknown>>
          ).map((s) => {
            const cleanedSlot = { ...s };
            if (
              typeof cleanedSlot.serviceId === 'string' &&
              !cleanedSlot.serviceId.trim()
            ) {
              delete cleanedSlot.serviceId;
            }
            return cleanedSlot;
          });
        }
        logger.log(
          `[Structured Step] Executing createBooking directly: ${JSON.stringify(cleanedConfirmPayload)}`,
        );
        const result = await toolProvider.execute({
          name: 'createBooking',
          arguments: cleanedConfirmPayload,
        });
        const p = result.output as Record<string, unknown> | undefined;
        if (p && !p.error && typeof p.bookingCode === 'string') {
          if (onCreatedBookingCode) {
            onCreatedBookingCode(p.bookingCode);
          }
          chatGateway.emitBookingSuccess(conversationId, {
            ...p,
            locale: state.locale,
          });
          await clearActiveFlow();
          const prompt =
            lang === 'vi'
              ? 'Đặt lịch thành công! Cảm ơn bạn.'
              : lang === 'ja'
                ? 'ご予約が完了しました！ありがとうございます。'
                : 'Your booking is confirmed! Thank you.';
          return {
            messages: [new AIMessage(prompt)],
          };
        } else if (p?.error) {
          const errorMsg =
            typeof p.error === 'string'
              ? p.error
              : 'Booking failed. Please try again.';
          return {
            messages: [new AIMessage(errorMsg)],
          };
        }
      } catch (err) {
        logger.error('[Structured Step] Failed confirm-booking', err);
      }
    }

    const templateId = options.siteContext?.industryTemplateId;

    // 3. Handle /select-booking-option actions
    if (bookingOption) {
      if (
        bookingOption.action === 'select_service' ||
        bookingOption.action === 'skip_service'
      ) {
        if (resources.length === 0) {
          const prompt = getBookingOptionPrompt(locale, 'date', templateId);
          return {
            messages: [
              new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
            ],
          };
        }
        const prompt = getBookingOptionPrompt(locale, 'resource', templateId);
        return {
          messages: [
            new AIMessage(`${prompt}\n\n<booking-step>resource</booking-step>`),
          ],
        };
      }

      if (
        bookingOption.action === 'select_resource' ||
        bookingOption.action === 'no_preference'
      ) {
        const prompt = getBookingOptionPrompt(locale, 'date', templateId);
        return {
          messages: [
            new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
          ],
        };
      }

      if (bookingOption.action === 'choose_date') {
        const prompt =
          lang === 'vi'
            ? 'Vui lòng nhập ngày bạn muốn đặt lịch (ví dụ: ngày mai, hoặc DD/MM/YYYY).'
            : lang === 'ja'
              ? 'ご希望の予約日を入力してください（例：明日、またはYYYY-MM-DD）。'
              : 'Please provide the date you would like to book (e.g. tomorrow, or YYYY-MM-DD).';
        return {
          messages: [new AIMessage(prompt)],
        };
      }

      if (bookingOption.action === 'select_date' && toolProvider) {
        const selectedDate = bookingOption.value;
        const userMessages = state.messages
          .filter((m) => m.constructor?.name?.includes('HumanMessage'))
          .map(messageText);

        const lastServiceOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter(
            (o) =>
              o?.action === 'select_service' || o?.action === 'skip_service',
          )
          .pop();
        const serviceOpt =
          lastServiceOpt?.action === 'select_service'
            ? lastServiceOpt
            : undefined;

        const resourceOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter(
            (o) =>
              o?.action === 'select_resource' || o?.action === 'no_preference',
          )
          .pop();

        const isSkipService = lastServiceOpt?.action === 'skip_service';
        const isSalon = templateId === 'salon';

        const serviceId = isSkipService
          ? undefined
          : (serviceOpt?.value ??
            services.find((s) => s.id === serviceOpt?.value)?.id ??
            services.find((s) =>
              userMessages.some((msg) =>
                msg.toLowerCase().includes(s.name.toLowerCase()),
              ),
            )?.id ??
            (isSalon ? services[0]?.id : undefined));

        const resourceId =
          resourceOpt?.action === 'no_preference'
            ? undefined
            : (resourceOpt?.value ??
              resources.find((r) => r.id === resourceOpt?.value)?.id ??
              resources.find((r) =>
                userMessages.some(
                  (msg) =>
                    msg.toLowerCase() === r.name.toLowerCase() ||
                    msg.toLowerCase().endsWith(` with ${r.name.toLowerCase()}`),
                ),
              )?.id);

        try {
          logger.log(
            `[Structured Step] Calling getAvailableSlots directly: date=${selectedDate}, serviceId=${serviceId}, resourceId=${resourceId}`,
          );
          const result = await toolProvider.execute({
            name: 'getAvailableSlots',
            arguments: {
              date: selectedDate,
              serviceId,
              resourceId,
            },
          });
          chatGateway.emitBookingSlots(conversationId, result.output);

          const prompt = getSlotCardPrompt(locale);
          return {
            messages: [new AIMessage(prompt)],
          };
        } catch (err) {
          logger.error('[Structured Step] Failed to fetch slots directly', err);
          return {
            messages: [new AIMessage(getSlotCardPrompt(locale))],
          };
        }
      }

      if (
        bookingOption.action === 'submit_text' &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || '')
      ) {
        const prompt =
          lang === 'vi'
            ? 'Bạn vui lòng cho biết số điện thoại để tiếp tục.\n\n<booking-input>phone</booking-input>'
            : lang === 'ja'
              ? '電話番号を入力してください。\n\n<booking-input>phone</booking-input>'
              : 'Please provide your phone number to continue.\n\n<booking-input>phone</booking-input>';
        return {
          messages: [new AIMessage(prompt)],
        };
      }

      if (
        bookingOption.action === 'skip_email' ||
        (bookingOption.action === 'submit_text' &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || ''))
      ) {
        const userMessages = state.messages
          .filter((m) => m.constructor?.name?.includes('HumanMessage'))
          .map(messageText);

        const latestSlotSel = state.messages
          .slice()
          .reverse()
          .filter((m) => m.constructor?.name?.includes('HumanMessage'))
          .map((m) => parseBookingSlotSelection(messageText(m)))
          .find(Boolean);

        const normalizeStr = (str: string) =>
          str
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .trim();

        const lastServiceOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter(
            (o) =>
              o?.action === 'select_service' || o?.action === 'skip_service',
          )
          .pop();

        const isSkipService = lastServiceOpt?.action === 'skip_service';
        const isSalon = templateId === 'salon';
        const serviceOpt =
          lastServiceOpt?.action === 'select_service'
            ? lastServiceOpt
            : undefined;

        const resourceOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter(
            (o) =>
              o?.action === 'select_resource' || o?.action === 'no_preference',
          )
          .pop();

        const isExcludedNameText = (val: string) => {
          const norm = normalizeStr(val);
          if (
            /^(?:khong uu tien|bat ky|no preference|any|skip|bo qua)$/i.test(
              norm,
            )
          )
            return true;
          return (
            resources.some((r) => normalizeStr(r.name) === norm) ||
            services.some((s) => normalizeStr(s.name) === norm)
          );
        };

        const nameOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter(
            (o) =>
              o?.action === 'submit_text' &&
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.value || '') &&
              !/^[+0-9\s().-]{7,25}$/.test(o.value?.trim() || '') &&
              !isExcludedNameText(o.value || ''),
          )
          .shift();

        const phoneMsg = userMessages
          .filter(
            (t) =>
              /^[+0-9\s().-]{7,25}$/.test(t.trim()) &&
              !t.startsWith('/select-') &&
              !t.startsWith('/confirm-') &&
              !t.startsWith('/update-'),
          )
          .pop();

        const submittedEmail =
          bookingOption.action === 'submit_text' &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || '')
            ? bookingOption.value
            : undefined;

        const rawName =
          nameOpt?.value ??
          nameOpt?.label ??
          options.visitorContext?.name ??
          '';

        const rawSelectedServiceIds = (serviceOpt?.value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        const selectedServices = isSkipService
          ? []
          : rawSelectedServiceIds
              .map((sId) =>
                services.find(
                  (s) =>
                    s.id === sId || s.name.toLowerCase() === sId.toLowerCase(),
                ),
              )
              .filter((s): s is NonNullable<typeof s> => Boolean(s));

        const matchedService =
          isSkipService || (!isSalon && !serviceOpt)
            ? undefined
            : services.find((s) => {
                if (serviceOpt?.value === s.id) return true;
                const sNorm = normalizeStr(s.name);
                return userMessages.some((msg) =>
                  normalizeStr(msg).includes(sNorm),
                );
              });

        const singleServiceId = isSkipService
          ? undefined
          : (serviceOpt?.value ??
            matchedService?.id ??
            (isSalon && services.length > 0 ? services[0]?.id : undefined));

        const singleService = isSkipService
          ? undefined
          : services.find((s) => s.id === singleServiceId);
        const resourceId =
          latestSlotSel?.resourceId ??
          (resourceOpt?.action === 'no_preference'
            ? undefined
            : (resourceOpt?.value ?? resources[0]?.id));

        const resource = resources.find((r) => r.id === resourceId);
        const slotCount =
          latestSlotSel?.slotCount ??
          (Array.isArray(latestSlotSel?.slots)
            ? latestSlotSel.slots.length
            : 1);

        const serviceIds: string[] | undefined =
          selectedServices.length > 0
            ? selectedServices.map((s) => s.id)
            : rawSelectedServiceIds.length > 0
              ? rawSelectedServiceIds
              : singleServiceId
                ? Array(slotCount).fill(singleServiceId)
                : undefined;

        const serviceNames: string[] | undefined =
          selectedServices.length > 0
            ? selectedServices.map((s) => s.name)
            : singleService
              ? Array(slotCount).fill(singleService.name)
              : undefined;

        const primaryServiceId: string | undefined =
          serviceIds?.[0] ?? singleServiceId;
        const primaryServiceName: string | undefined =
          serviceNames?.[0] ?? singleService?.name;

        // Calculate chronological endTimeSlot
        let calculatedEndTimeSlot = latestSlotSel?.endTimeSlot;
        if (
          Array.isArray(latestSlotSel?.slots) &&
          latestSlotSel.slots.length > 0
        ) {
          const sorted = [...latestSlotSel.slots].sort((a, b) => {
            const dc = (a.date || '').localeCompare(b.date || '');
            if (dc !== 0) return dc;
            return (a.timeSlot || '').localeCompare(b.timeSlot || '');
          });
          const lastSlot = sorted[sorted.length - 1];
          if (lastSlot?.timeSlot) {
            const [h, m] = lastSlot.timeSlot.split(':').map(Number);
            const endM = (h || 0) * 60 + (m || 0) + 30;
            calculatedEndTimeSlot = `${String(Math.floor(endM / 60) % 24).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
          }
        } else if (latestSlotSel?.timeSlot) {
          const [h, m] = latestSlotSel.timeSlot.split(':').map(Number);
          const endM = (h || 0) * 60 + (m || 0) + 30 * slotCount;
          calculatedEndTimeSlot = `${String(Math.floor(endM / 60) % 24).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
        }

        const enrichedSlots = latestSlotSel?.slots?.map((s, idx) => ({
          resourceId: s.resourceId,
          date: s.date,
          timeSlot: s.timeSlot,
          serviceId: s.serviceId ?? serviceIds?.[idx] ?? primaryServiceId,
          serviceName:
            s.serviceName ?? serviceNames?.[idx] ?? primaryServiceName,
          staffName: s.staffName ?? resource?.name,
        }));

        chatGateway.emitBookingSummary(conversationId, {
          locale: state.activeFlowLocale ?? state.locale,
          customerName: rawName || 'Khách hàng',
          phone: phoneMsg?.trim() ?? '',
          customerEmail: submittedEmail,
          serviceId: primaryServiceId,
          serviceIds,
          serviceName: primaryServiceName,
          serviceNames,
          resourceId,
          resourceName: resource?.name,
          date: latestSlotSel?.date,
          timeSlot: latestSlotSel?.timeSlot,
          endTimeSlot: calculatedEndTimeSlot,
          slotCount,
          slots: enrichedSlots ?? latestSlotSel?.slots,
        });

        const prompt =
          lang === 'vi'
            ? 'Vui lòng xem và xác nhận thông tin đặt lịch trong thẻ bên dưới.'
            : lang === 'ja'
              ? '下のカードで予約内容を確認し、確定してください。'
              : 'Please review and confirm your booking details in the card below.';
        return {
          messages: [new AIMessage(prompt)],
        };
      }
    }

    // 4. Handle /select-booking-slot
    if (slotSelection && toolProvider) {
      const userMessages = state.messages
        .filter((m) => m.constructor?.name?.includes('HumanMessage'))
        .map(messageText);

      const serviceOpt = userMessages
        .map((t) => parseBookingOptionSelection(t))
        .filter((o) => o?.action === 'select_service')
        .pop();

      const selectedServiceIds = serviceOpt?.value
        ? serviceOpt.value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [];
      const serviceCount = selectedServiceIds.length;

      const slotCount =
        slotSelection.slotCount ??
        (Array.isArray(slotSelection.slots) ? slotSelection.slots.length : 1);

      if (serviceCount >= 2 && slotCount < serviceCount) {
        let mismatchPrompt = '';
        if (lang === 'vi') {
          mismatchPrompt = `Bạn đã chọn ${serviceCount} dịch vụ nhưng chỉ chọn ${slotCount} khung giờ. Vui lòng chọn đủ ${serviceCount} khung giờ (mỗi dịch vụ tương ứng 1 khung giờ) hoặc chọn lại chỉ 1 dịch vụ.\n\n<booking-step>service</booking-step>`;
        } else if (lang === 'ja') {
          mismatchPrompt = `${serviceCount}つのサービスを選択されていますが、${slotCount}つの時間枠のみ選択されています。各サービスに1つずつ（合計${serviceCount}枠）の時間枠を選択するか、1つのサービスのみを選択し直してください。\n\n<booking-step>service</booking-step>`;
        } else {
          mismatchPrompt = `You have selected ${serviceCount} services but only chosen ${slotCount} time slot(s). Please select ${serviceCount} time slots (one slot per service) or choose only 1 service.\n\n<booking-step>service</booking-step>`;
        }

        try {
          const result = await toolProvider.execute({
            name: 'getAvailableSlots',
            arguments: {
              date: slotSelection.date,
              serviceId: serviceOpt?.value,
              resourceId: slotSelection.resourceId,
            },
          });
          chatGateway.emitBookingSlots(conversationId, result.output);
        } catch (err) {
          logger.error(
            '[Structured Step] Failed to re-fetch slots on slot count mismatch',
            err,
          );
        }

        return {
          messages: [new AIMessage(mismatchPrompt)],
        };
      }

      try {
        logger.log(
          `[Structured Step] Calling holdSlot directly: date=${slotSelection.date}, timeSlot=${slotSelection.timeSlot}, resourceId=${slotSelection.resourceId}, slotCount=${slotCount}`,
        );
        await toolProvider.execute({
          name: 'holdSlot',
          arguments: {
            date: slotSelection.date,
            timeSlot: slotSelection.timeSlot,
            resourceId: slotSelection.resourceId,
            slotCount,
            slots: slotSelection.slots,
            sessionId: conversationId,
          },
        });
      } catch (err) {
        logger.error('[Structured Step] Failed to hold slot', err);
      }

      const hasName = !!options.visitorContext?.name;
      const prompt = getBookingOptionPrompt(locale, 'name');
      const marker = hasName ? '\n\n<booking-step>name</booking-step>' : '';
      return {
        messages: [new AIMessage(`${prompt}${marker}`)],
      };
    }

    return {};
  };

  /**
   * draftBookingNode — emits booking summary card and calls interrupt() to pause.
   */
  const draftBookingNode = () => {
    logger.log({
      event: 'booking_interrupt_start',
      conversationId,
    });

    // INTERRUPT — graph pause here, waiting for user confirm/abandon action
    const userDecision = interrupt<
      { type: string; conversationId: string },
      string
    >({
      type: 'booking_confirmation',
      conversationId,
    });

    logger.log({
      event: 'booking_interrupt_resumed',
      conversationId,
      decisionPrefix:
        typeof userDecision === 'string'
          ? userDecision.slice(0, 30)
          : 'non-string',
    });

    if (
      typeof userDecision === 'string' &&
      /^\/abandon-booking\b/i.test(userDecision)
    ) {
      return { exitSubgraph: 'abandon' as const };
    }

    return {
      messages: [
        new HumanMessage(typeof userDecision === 'string' ? userDecision : ''),
      ],
    };
  };

  const bookingModelNode = async (state: typeof AgentState.State) => {
    const convertedMessages: LLMMessage[] = state.messages.map((m) => ({
      role: m.constructor?.name?.includes('HumanMessage')
        ? ('user' as const)
        : ('assistant' as const),
      content: messageText(m),
    }));

    const systemPrompt = aiService.buildSystemPrompt({
      messages: convertedMessages,
      summary: state.summary,
      siteId: state.siteId,
      conversationId: state.conversationId,
      visitorContext: state.visitorContext,
      siteContext: state.siteContext,
      systemPromptOverride: options.systemPromptOverride,
      locale: state.locale,
    });

    const messagesWithSystem = [
      new SystemMessage(systemPrompt),
      ...state.messages,
    ];

    const allowedNames = bookAppointmentToolNames(getLatestUserText(state));
    const visibleTools = bookingTools.filter((t) =>
      allowedNames.includes(t.name),
    );

    const boundModel = aiService
      .buildModelForSite(
        options.site ?? {},
        0.0,
        false,
        options.maxTokensPerResponse,
      )
      .bindTools(visibleTools);

    const response = await boundModel.invoke(messagesWithSystem, {
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            if (token) {
              if (streamedTokensRef) {
                streamedTokensRef.count++;
              }
              if (res) {
                res.write(token);
              }
              server
                .to(`conversation-${conversationId}`)
                .emit('aiChunk', { token, conversationId });
            }
          },
        },
      ],
    });

    return { messages: [response] };
  };

  const bookingToolNode = new ToolNode(bookingTools);

  const parseToolsNode = async (state: typeof AgentState.State) => {
    const recentToolMessages: BaseMessage[] = [];
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (!(message instanceof ToolMessage)) break;
      recentToolMessages.unshift(message as BaseMessage);
    }

    for (const toolMessage of recentToolMessages) {
      try {
        const rawContent =
          typeof toolMessage.content === 'string'
            ? toolMessage.content
            : JSON.stringify(toolMessage.content);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          parsed = null;
        }

        if (!parsed) continue;

        if (toolMessage.name?.includes('getAvailableSlots')) {
          chatGateway.emitBookingSlots(conversationId, parsed);
        } else if (toolMessage.name?.includes('createBooking')) {
          const p =
            parsed && typeof parsed === 'object'
              ? (parsed as Record<string, unknown>)
              : null;
          const hasError = !!p?.error;
          const bookingCode = p?.bookingCode;
          if (
            !hasError &&
            typeof bookingCode === 'string' &&
            bookingCode.trim().length > 0
          ) {
            if (onCreatedBookingCode) {
              onCreatedBookingCode(bookingCode);
            }
            chatGateway.emitBookingSuccess(conversationId, {
              ...p,
              locale: state.locale,
            });
            await clearActiveFlow();
          }

          if (p?.isSummaryCardEmitted || p?.error === 'ACTION_REQUIRED') {
            const isVietnamese = localeLanguage(state.locale) === 'vi';
            const summaryMsg = isVietnamese
              ? 'Dạ, thông tin đặt lịch của bạn đã được cập nhật đầy đủ. Vui lòng kiểm tra và xác nhận trên phiếu đặt lịch bên dưới nhé!'
              : 'Your booking summary is ready. Please review and confirm your details below!';

            if (res) {
              res.write(summaryMsg);
            }
            server
              ?.to(`conversation-${conversationId}`)
              ?.emit('aiChunk', { token: summaryMsg, conversationId });

            return {
              messages: [new AIMessage(summaryMsg)],
            };
          }
        }
      } catch (error) {
        logger.error('Failed to parse tool output in booking subgraph', error);
      }
    }

    return {};
  };

  const customToolsCondition = (
    state: typeof AgentState.State,
  ): 'tools' | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    const hasToolCalls =
      lastMessage &&
      'tool_calls' in lastMessage &&
      Array.isArray((lastMessage as AIMessage).tool_calls) &&
      ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0;

    return hasToolCalls ? 'tools' : END;
  };

  const getLastToolName = (state: typeof AgentState.State): string | null => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      'tool_calls' in lastMessage &&
      Array.isArray((lastMessage as AIMessage).tool_calls) &&
      ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0
    ) {
      return (lastMessage as AIMessage).tool_calls?.[0]?.name ?? null;
    }
    return null;
  };

  const workflow = new StateGraph(AgentState)
    .addNode('init_booking', initBookingNode)
    .addNode('structured_booking_step', structuredBookingStepNode)
    .addNode('draft_booking', draftBookingNode)
    .addNode('model_node', bookingModelNode)
    .addNode('tools', bookingToolNode)
    .addNode('parse_tools', parseToolsNode)
    .addConditionalEdges(
      START,
      (state) => {
        if (state.intent === 'book_appointment_init') return 'init_booking';
        if (state.intent === 'structured_booking_step')
          return 'structured_booking_step';
        return 'model_node';
      },
      {
        init_booking: 'init_booking',
        structured_booking_step: 'structured_booking_step',
        model_node: 'model_node',
      },
    )
    .addEdge('init_booking', END)
    .addEdge('structured_booking_step', END)
    .addConditionalEdges('model_node', customToolsCondition, {
      tools: 'tools',
      __end__: END,
    })
    .addEdge('tools', 'parse_tools')
    .addConditionalEdges(
      'parse_tools',
      (state) => {
        const lastToolName = getLastToolName(state);
        if (lastToolName === 'draftBooking') return 'draft_booking';
        return 'model_node';
      },
      { draft_booking: 'draft_booking', model_node: 'model_node' },
    )
    .addConditionalEdges(
      'draft_booking',
      (state) => (state.exitSubgraph === 'abandon' ? 'exit' : 'model_node'),
      { exit: END, model_node: 'model_node' },
    );

  return workflow.compile();
}
