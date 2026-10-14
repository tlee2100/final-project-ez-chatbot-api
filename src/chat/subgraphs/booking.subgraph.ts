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
  onCreatedBookingCode?: (
    code: string,
    details?: { customerName?: string; customerEmail?: string },
  ) => void;
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
    const templateId = options.siteContext?.industryTemplateId;
    const isSalon = templateId === 'salon';

    if (isSalon) {
      const prompt = getBookingOptionPrompt(
        state.locale,
        'booking_type',
        templateId,
        { isInitial: true },
      );
      return {
        messages: [
          new AIMessage(
            `${prompt}\n\n<booking-step>booking_type</booking-step>`,
          ),
        ],
      };
    }

    const services = options.siteContext?.bookingServices ?? [];
    const resources = options.siteContext?.bookingResources ?? [];
    if (services.length > 0) {
      const prompt = getBookingOptionPrompt(
        state.locale,
        'service',
        templateId,
        { isInitial: true },
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
        { isInitial: true },
      );
      return {
        messages: [
          new AIMessage(`${prompt}\n\n<booking-step>resource</booking-step>`),
        ],
      };
    }
    const prompt = getBookingOptionPrompt(state.locale, 'date', templateId, {
      isInitial: true,
    });
    return {
      messages: [
        new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
      ],
    };
  };

  const structuredBookingStepNode = async (state: typeof AgentState.State) => {
    const userText = getLatestUserText(state).trim();
    const locale = state.locale;

    const lastBotMessage = state.messages
      .slice()
      .reverse()
      .find((m) => m.constructor?.name?.includes('AIMessage'));
    const lastBotText = lastBotMessage ? messageText(lastBotMessage) : '';

    const isNameStep =
      /<booking-step>\s*name\s*<\/booking-step>/i.test(lastBotText) ||
      /(?:provide your name|cho biết tên|tên của bạn|お名前|enter your name|your name)/i.test(
        lastBotText,
      );

    const isTypedName =
      isNameStep &&
      userText.length > 0 &&
      !userText.startsWith('/') &&
      !/^[+0-9\s().-]{7,25}$/.test(userText) &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userText);

    const isTypedEmail =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userText) && !userText.startsWith('/');

    const parsedOption =
      parseBookingOptionSelection(userText) ??
      (/^(?:bỏ\s*qua(?:\s*(?:email|bước\s*này))?|skip(?:\s*email)?|khỏi(?:\s*cần)?\s*email|không\s*(?:cần|dùng|có)?\s*email|スキップ)$/i.test(
        userText,
      )
        ? { action: 'skip_email' as const }
        : null);

    const bookingOption =
      parsedOption ??
      (isTypedName
        ? { action: 'submit_text' as const, value: userText }
        : isTypedEmail
          ? { action: 'submit_text' as const, value: userText }
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

        const rawSlots = Array.isArray(draftPayload.slots)
          ? (draftPayload.slots as Array<Record<string, unknown>>)
          : [];
        const distinctResourceNames = Array.from(
          new Set(
            rawSlots
              .map((s) => {
                const r = resources.find((item) => item.id === s.resourceId);
                return (
                  (s.resourceName as string) ||
                  (s.staffName as string) ||
                  r?.name
                );
              })
              .filter(Boolean),
          ),
        );
        const combinedResourceName =
          distinctResourceNames.length > 0
            ? distinctResourceNames.join(', ')
            : (resource?.name ?? (draftPayload.resourceName as string));

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
          resourceName: combinedResourceName,
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
            onCreatedBookingCode(p.bookingCode, {
              customerName:
                typeof p.customerName === 'string' ? p.customerName : undefined,
              customerEmail:
                typeof p.customerEmail === 'string'
                  ? p.customerEmail
                  : undefined,
            });
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

    // 3. Handle /select-booking-option actions and /assign-slot-services
    const assignSlotServicesMatch = userText.match(
      /^\/assign-slot-services\s+(.+?)(?:\s+::|$)/i,
    );
    if (assignSlotServicesMatch) {
      const hasName = !!options.visitorContext?.name;
      const prompt = getBookingOptionPrompt(locale, 'name');
      const marker = hasName ? '\n\n<booking-step>name</booking-step>' : '';
      return {
        messages: [new AIMessage(`${prompt}${marker}`)],
      };
    }

    if (bookingOption) {
      if (bookingOption.action === 'select_booking_type') {
        if (templateId === 'salon' && bookingOption.value === 'multiple') {
          const prompt = getBookingOptionPrompt(
            locale,
            'party_size',
            templateId,
          );
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>party_size</booking-step>`,
              ),
            ],
          };
        }
        if (services.length > 0) {
          const prompt = getBookingOptionPrompt(locale, 'service', templateId);
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>service</booking-step>`,
              ),
            ],
          };
        }
        if (resources.length > 0) {
          const prompt = getBookingOptionPrompt(locale, 'resource', templateId);
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>resource</booking-step>`,
              ),
            ],
          };
        }
        const prompt = getBookingOptionPrompt(locale, 'date', templateId);
        return {
          messages: [
            new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
          ],
        };
      }

      if (bookingOption.action === 'select_party_size') {
        if (services.length > 0) {
          const prompt = getBookingOptionPrompt(locale, 'service', templateId);
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>service</booking-step>`,
              ),
            ],
          };
        }
        const prompt = getBookingOptionPrompt(locale, 'date', templateId);
        return {
          messages: [
            new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
          ],
        };
      }

      if (
        bookingOption.action === 'assign_remaining_service' ||
        bookingOption.action === 'assign_slot_services'
      ) {
        const hasName = !!options.visitorContext?.name;
        const prompt = getBookingOptionPrompt(locale, 'name');
        const marker = hasName ? '\n\n<booking-step>name</booking-step>' : '';
        return {
          messages: [new AIMessage(`${prompt}${marker}`)],
        };
      }

      if (
        bookingOption.action === 'select_service' ||
        bookingOption.action === 'skip_service'
      ) {
        const userMessages = state.messages
          .filter((m) => m.constructor?.name?.includes('HumanMessage'))
          .map(messageText);
        const bookingTypeOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter((o) => o?.action === 'select_booking_type')
          .pop();
        const partySizeOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter((o) => o?.action === 'select_party_size')
          .pop();
        const isSalonGroup =
          templateId === 'salon' &&
          (bookingTypeOpt?.value === 'multiple' || !!partySizeOpt);

        if (resources.length === 0 || isSalonGroup) {
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
                userMessages.some((msg) =>
                  msg.toLowerCase().includes(r.name.toLowerCase()),
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
          const extractSlots = (output: unknown): unknown[] => {
            if (!output) return [];
            if (Array.isArray(output)) return output;
            if (typeof output === 'object') {
              const obj = output as Record<string, unknown>;
              if (Array.isArray(obj.result)) return obj.result;
              if (Array.isArray(obj.slots)) return obj.slots;
              if (Array.isArray(obj.data)) return obj.data;
            }
            if (typeof output === 'string') {
              try {
                const parsed: unknown = JSON.parse(output);
                return extractSlots(parsed);
              } catch {
                return [];
              }
            }
            return [];
          };

          const rawSlots = extractSlots(result.output);
          chatGateway.emitBookingSlots(conversationId, rawSlots);

          if (rawSlots.length === 0) {
            const staffObj = resources.find((r) => r.id === resourceId);
            const staffName = staffObj?.name || '';
            const [year, month, day] = (selectedDate || '').split('-');
            const displayDate =
              day && month
                ? `${day}/${month}${year ? '/' + year : ''}`
                : selectedDate;

            let noSlotPrompt = '';
            if (lang === 'vi') {
              noSlotPrompt = staffName
                ? `Rất tiếc, nhân viên **${staffName}** không có khung giờ trống vào ngày **${displayDate}** (do đã kín lịch hoặc đang nghỉ/bị chặn lịch). Quý khách vui lòng chọn ngày khác hoặc chọn nhân viên khác nhé!\n\n<booking-step>date</booking-step>`
                : `Rất tiếc, ngày **${displayDate}** hiện không còn khung giờ trống nào. Quý khách vui lòng chọn ngày khác nhé!\n\n<booking-step>date</booking-step>`;
            } else if (lang === 'ja') {
              noSlotPrompt = staffName
                ? `申し訳ございません。スタッフ **${staffName}** は **${displayDate}** に予約可能な時間枠がございません（満席または休業のため）。別の日程または別のスタッフをお選びください。\n\n<booking-step>date</booking-step>`
                : `申し訳ございません。**${displayDate}** には現在予約可能な時間枠がございません。別の日程をお選びください。\n\n<booking-step>date</booking-step>`;
            } else {
              noSlotPrompt = staffName
                ? `Sorry, staff member **${staffName}** has no available time slots on **${displayDate}** (fully booked or on leave). Please choose another date or staff member!\n\n<booking-step>date</booking-step>`
                : `Sorry, there are no available time slots on **${displayDate}**. Please choose another date!\n\n<booking-step>date</booking-step>`;
            }

            return {
              messages: [new AIMessage(noSlotPrompt)],
            };
          }

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

        const isAnonymousVisitor =
          !options.visitorContext?.name ||
          options.visitorContext.name.trim().toLowerCase() === 'guest' ||
          options.visitorContext.name.trim().toLowerCase() === '[none]';

        // Find the typed name directly after the name prompt in conversation history
        let typedNameFromHistory: string | undefined;
        for (let i = 0; i < state.messages.length; i++) {
          const msg = state.messages[i];
          if (msg.constructor?.name?.includes('AIMessage')) {
            const txt = messageText(msg);
            const isNamePrompt =
              /<booking-step>\s*name\s*<\/booking-step>/i.test(txt) ||
              /(?:provide your name|cho biết tên|tên của bạn|nhập tên|vui lòng cho biết tên|お名前|enter your name|your name)/i.test(
                txt,
              );
            if (isNamePrompt) {
              for (let j = i + 1; j < state.messages.length; j++) {
                const nextMsg = state.messages[j];
                if (nextMsg.constructor?.name?.includes('HumanMessage')) {
                  const candidate = messageText(nextMsg).trim();
                  if (
                    candidate &&
                    !candidate.startsWith('/') &&
                    !/^[+0-9\s().-]{7,25}$/.test(candidate) &&
                    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) &&
                    !isExcludedNameText(candidate)
                  ) {
                    typedNameFromHistory = candidate;
                    break;
                  }
                }
              }
            }
          }
        }

        // Fallback: look at user message right before phone number
        if (!typedNameFromHistory) {
          const phoneIndex = userMessages.findIndex(
            (t) =>
              /^[+0-9\s().-]{7,25}$/.test(t.trim()) &&
              !t.startsWith('/select-') &&
              !t.startsWith('/confirm-') &&
              !t.startsWith('/update-'),
          );
          if (phoneIndex > 0) {
            for (let k = phoneIndex - 1; k >= 0; k--) {
              const candidate = userMessages[k].trim();
              if (
                candidate &&
                !candidate.startsWith('/') &&
                !/^[+0-9\s().-]{7,25}$/.test(candidate) &&
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) &&
                !isExcludedNameText(candidate)
              ) {
                typedNameFromHistory = candidate;
                break;
              }
            }
          }
        }

        const rawName =
          nameOpt?.value ??
          nameOpt?.label ??
          typedNameFromHistory ??
          (!isAnonymousVisitor ? options.visitorContext?.name : undefined) ??
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

        const assignedRemainingOpt = userMessages
          .map((t) => parseBookingOptionSelection(t))
          .filter((o) => o?.action === 'assign_remaining_service')
          .pop();
        const remainingServiceId = assignedRemainingOpt?.value;
        const remainingService = services.find(
          (s) => s.id === remainingServiceId || s.name === remainingServiceId,
        );

        type SlotAssignment = {
          slotIndex: number;
          serviceId: string;
          serviceName?: string;
          timeSlot?: string;
        };
        let customAssignments: SlotAssignment[] | null = null;
        for (const msg of userMessages) {
          const m = msg.match(/^\/assign-slot-services\s+(.+?)(?:\s+::|$)/i);
          if (m) {
            try {
              const parsed = JSON.parse(m[1]) as {
                assignments?: SlotAssignment[];
              };
              if (Array.isArray(parsed?.assignments)) {
                customAssignments = parsed.assignments;
              }
            } catch {
              // Ignore invalid JSON
            }
          }
        }

        const serviceIds: string[] | undefined = customAssignments
          ? Array.from({ length: slotCount }, (_, idx) => {
              const found = customAssignments.find((a) => a.slotIndex === idx);
              return (
                found?.serviceId ?? selectedServices[0]?.id ?? singleServiceId
              );
            })
          : selectedServices.length > 0
            ? Array.from({ length: slotCount }, (_, idx) => {
                if (idx < selectedServices.length) {
                  return selectedServices[idx].id;
                }
                return remainingServiceId ?? selectedServices[0].id;
              })
            : rawSelectedServiceIds.length > 0
              ? rawSelectedServiceIds
              : singleServiceId
                ? Array(slotCount).fill(singleServiceId)
                : undefined;

        const serviceNames: string[] | undefined = customAssignments
          ? Array.from({ length: slotCount }, (_, idx) => {
              const found = customAssignments.find((a) => a.slotIndex === idx);
              const sObj = services.find((s) => s.id === found?.serviceId);
              return (
                found?.serviceName ??
                sObj?.name ??
                selectedServices[0]?.name ??
                singleService?.name
              );
            })
          : selectedServices.length > 0
            ? Array.from({ length: slotCount }, (_, idx) => {
                if (idx < selectedServices.length) {
                  return selectedServices[idx].name;
                }
                return remainingService?.name ?? selectedServices[0].name;
              })
            : singleService
              ? Array(slotCount).fill(singleService.name)
              : undefined;

        const primaryServiceId: string | undefined =
          serviceIds?.[0] ?? singleServiceId;
        const primaryServiceName: string | undefined =
          serviceNames?.[0] ?? singleService?.name;

        // Calculate chronological endTimeSlot using site's configured slotDuration
        const slotDuration =
          options.siteContext?.bookingHours?.slotDuration ?? 30;
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
            const endM = (h || 0) * 60 + (m || 0) + slotDuration;
            calculatedEndTimeSlot = `${String(Math.floor(endM / 60) % 24).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
          }
        } else if (latestSlotSel?.timeSlot) {
          const [h, m] = latestSlotSel.timeSlot.split(':').map(Number);
          const endM = (h || 0) * 60 + (m || 0) + slotDuration * slotCount;
          calculatedEndTimeSlot = `${String(Math.floor(endM / 60) % 24).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
        }

        const distinctResourceNames = Array.from(
          new Set(
            (latestSlotSel?.slots || [])
              .map((s) => {
                const r = resources.find((item) => item.id === s.resourceId);
                return s.resourceName || s.staffName || r?.name;
              })
              .filter(Boolean),
          ),
        );
        const combinedResourceName =
          distinctResourceNames.length > 0
            ? distinctResourceNames.join(', ')
            : resource?.name;

        const enrichedSlots = latestSlotSel?.slots?.map((s, idx) => {
          const r = resources.find((item) => item.id === s.resourceId);
          const stName =
            s.staffName || s.resourceName || r?.name || resource?.name;
          return {
            resourceId: s.resourceId,
            resourceName: stName,
            date: s.date,
            timeSlot: s.timeSlot,
            serviceId: s.serviceId ?? serviceIds?.[idx] ?? primaryServiceId,
            serviceName:
              s.serviceName ?? serviceNames?.[idx] ?? primaryServiceName,
            staffName: stName,
          };
        });

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
          resourceName: combinedResourceName,
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

      const isSalon = templateId === 'salon';
      const bookingTypeOpt = userMessages
        .map((t) => parseBookingOptionSelection(t))
        .filter((o) => o?.action === 'select_booking_type')
        .pop();
      const partySizeOpt = userMessages
        .map((t) => parseBookingOptionSelection(t))
        .filter((o) => o?.action === 'select_party_size')
        .pop();

      const partySizeFromText = userMessages
        .map((t) => {
          const trimmed = t.trim();
          if (/^\d+$/.test(trimmed)) {
            const num = parseInt(trimmed, 10);
            if (num >= 1 && num <= 50) return num;
          }
          const m = trimmed.match(
            /(\d+)\s*(?:người|nguoi|people|名|khách|khach)/i,
          );
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(Boolean)
        .pop();

      const partySize =
        (partySizeOpt?.value ? parseInt(partySizeOpt.value, 10) : null) ||
        partySizeFromText ||
        (isSalon && bookingTypeOpt?.value === 'multiple' ? 2 : 1);

      const isSingleBooking = isSalon && bookingTypeOpt?.value === 'single';
      const isGroupBooking =
        isSalon && (bookingTypeOpt?.value === 'multiple' || partySize > 1);

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

      // Single booking in Salon: 1 customer can choose multiple services, but must match exactly serviceCount slots (1-to-1)
      if (isSingleBooking && serviceCount > 0 && slotCount !== serviceCount) {
        let mismatchPrompt = '';
        if (lang === 'vi') {
          mismatchPrompt = `Bạn đang đặt lịch cho 1 người với ${serviceCount} dịch vụ. Vui lòng chọn đúng ${serviceCount} khung giờ nối tiếp nhau (mỗi dịch vụ tương ứng 1 khung giờ).`;
        } else if (lang === 'ja') {
          mismatchPrompt = `1名様で${serviceCount}つのサービスをご予約中です。連続する${serviceCount}つの時間枠（1サービスにつき1枠）を選択してください。`;
        } else {
          mismatchPrompt = `You are booking for 1 person with ${serviceCount} service(s). Please select exactly ${serviceCount} consecutive time slot(s) (1 slot per service).`;
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

      // Single booking in Salon: validate that slots do not share the exact same time
      if (
        isSingleBooking &&
        slotSelection.slots &&
        slotSelection.slots.length > 1
      ) {
        const timeKeys = slotSelection.slots.map(
          (s) => `${s.date || ''}_${s.timeSlot || ''}`,
        );
        if (new Set(timeKeys).size !== slotSelection.slots.length) {
          let dupTimePrompt = '';
          if (lang === 'vi') {
            dupTimePrompt = `Đặt lịch cho 1 người với nhiều dịch vụ yêu cầu các khung giờ nối tiếp nhau (không thể trùng cùng 1 khung giờ). Vui lòng chọn các khung giờ khác nhau.`;
          } else if (lang === 'ja') {
            dupTimePrompt = `1名様での複数サービスのご予約は、連続する異なる時間枠をご指定ください（同じ時間枠を重複して選択することはできません）。`;
          } else {
            dupTimePrompt = `Booking multiple services for 1 person requires sequential time slots. You cannot select the same time slot simultaneously. Please choose different consecutive slots.`;
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
          } catch {
            // Ignore slot fetch error
          }
          return {
            messages: [new AIMessage(dupTimePrompt)],
          };
        }
      }

      // Group booking in Salon: validate partySize match and enrich slots
      let effectiveSlots = slotSelection.slots;
      if (
        isGroupBooking &&
        (!effectiveSlots || effectiveSlots.length < partySize)
      ) {
        let groupMismatchPrompt = '';
        if (lang === 'vi') {
          groupMismatchPrompt = `Bạn đang đặt lịch cho nhóm ${partySize} người. Vui lòng chọn đúng ${partySize} thợ/khung giờ.`;
        } else if (lang === 'ja') {
          groupMismatchPrompt = `${partySize} 名様のご予約です。${partySize} つの時間枠/スタッフを選択してください。`;
        } else {
          groupMismatchPrompt = `You are booking for a group of ${partySize} people. Please select exactly ${partySize} staff/slots.`;
        }
        try {
          const result = await toolProvider.execute({
            name: 'getAvailableSlots',
            arguments: {
              date: slotSelection.date,
              serviceId: serviceOpt?.value,
            },
          });
          chatGateway.emitBookingSlots(conversationId, result.output);
        } catch (err) {
          logger.error(
            '[Structured Step] Failed to re-fetch slots on group mismatch',
            err,
          );
        }
        return {
          messages: [new AIMessage(groupMismatchPrompt)],
        };
      }

      if (effectiveSlots && effectiveSlots.length > 0) {
        effectiveSlots = effectiveSlots.map((st, idx) => {
          const resId = st.resourceId || slotSelection.resourceId || '';
          const foundRes = resources.find((r) => r.id === resId);
          const srvId =
            st.serviceId ??
            (isSingleBooking && selectedServiceIds[idx]
              ? selectedServiceIds[idx]
              : (serviceOpt?.value ?? services[0]?.id));
          const foundSrv = services.find((s) => s.id === srvId);
          return {
            ...st,
            resourceId: resId,
            resourceName: st.resourceName || st.staffName || foundRes?.name,
            staffName: st.staffName || st.resourceName || foundRes?.name,
            serviceId: srvId,
            serviceName: st.serviceName || foundSrv?.name,
          };
        });
      }

      const finalSlotCount =
        effectiveSlots && effectiveSlots.length > 0
          ? effectiveSlots.length
          : slotCount;

      try {
        logger.log(
          `[Structured Step] Calling holdSlot directly: date=${slotSelection.date}, timeSlot=${slotSelection.timeSlot}, resourceId=${slotSelection.resourceId}, slotCount=${finalSlotCount}`,
        );
        await toolProvider.execute({
          name: 'holdSlot',
          arguments: {
            date: slotSelection.date,
            timeSlot: slotSelection.timeSlot,
            resourceId: slotSelection.resourceId,
            slotCount: finalSlotCount,
            slots: effectiveSlots ?? slotSelection.slots,
            sessionId: conversationId,
          },
        });
      } catch (err) {
        logger.error('[Structured Step] Failed to hold slot', err);
      }

      const visitorName = options.visitorContext?.name?.trim();
      const isKnownName =
        Boolean(visitorName) &&
        visitorName?.toLowerCase() !== 'guest' &&
        visitorName?.toLowerCase() !== '[none]';
      // If multiple services and more slots than services, or group booking with multiple services:
      // Prompt visitor to assign services to slots with slot breakdown
      if (
        (serviceCount >= 2 && slotCount > serviceCount) ||
        (isGroupBooking && serviceCount >= 2)
      ) {
        const selectedServices = selectedServiceIds
          .map((id) => services.find((s) => s.id === id || s.name === id))
          .filter((s): s is NonNullable<typeof s> => Boolean(s));
        const selectedServiceNames = selectedServices.map((s) => s.name);
        const prompt = getBookingOptionPrompt(
          locale,
          'assign_slot_services',
          templateId,
          {
            serviceCount,
            serviceNames: selectedServiceNames,
            slotCount,
          },
        );
        return {
          messages: [
            new AIMessage(
              `${prompt}\n\n<booking-step>assign_slot_services</booking-step>`,
            ),
          ],
        };
      }

      const prompt = getBookingOptionPrompt(locale, 'name');
      const marker = isKnownName ? '\n\n<booking-step>name</booking-step>' : '';
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
              onCreatedBookingCode(bookingCode, {
                customerName:
                  typeof p?.customerName === 'string'
                    ? p.customerName
                    : undefined,
                customerEmail:
                  typeof p?.customerEmail === 'string'
                    ? p.customerEmail
                    : undefined,
              });
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

        const templateId = options.siteContext?.industryTemplateId;
        const isSalon = templateId === 'salon';

        if (isSalon) {
          const userMessages = state.messages
            .filter((m) => m.constructor?.name?.includes('HumanMessage'))
            .map(messageText);

          const hasBookingType = userMessages.some((text) => {
            const opt = parseBookingOptionSelection(text);
            return (
              opt?.action === 'select_booking_type' ||
              opt?.action === 'select_party_size' ||
              /(?:1\s*người|đặt\s*cho\s*1\s*người|đi\s*1\s*mình|cá\s*nhân|single|1\s*person|one\s*person|nhóm|nhiều\s*người|group|multiple|\b\d+\s*người\b|\b\d+\s*people\b|\b\d+\s*persons\b)/i.test(
                text,
              )
            );
          });

          if (!hasBookingType) {
            return 'init_booking';
          }
        }

        const userText = getLatestUserText(state).trim();
        const lastBotMessage = state.messages
          .slice()
          .reverse()
          .find((m) => m.constructor?.name?.includes('AIMessage'));
        const lastBotText = lastBotMessage ? messageText(lastBotMessage) : '';

        const isNameStep =
          /<booking-step>\s*name\s*<\/booking-step>/i.test(lastBotText) ||
          /(?:provide your name|cho biết tên|tên của bạn|お名前|enter your name|your name)/i.test(
            lastBotText,
          );

        const isTypedName =
          isNameStep &&
          userText.length > 0 &&
          !userText.startsWith('/') &&
          !/^[+0-9\s().-]{7,25}$/.test(userText) &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userText);

        const isTypedEmail =
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userText) &&
          !userText.startsWith('/');

        if (isTypedName || isTypedEmail) {
          return 'structured_booking_step';
        }

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
