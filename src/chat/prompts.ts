export const getIntentClassifierPrompt = (
  bookingEnabled: boolean,
): string => `You are an intent classifier for a customer support chatbot. Determine the user's intent from the following message.
Analyze the message enclosed in <user_input> tags.

- Use "request_human" if they ask for an agent, human, support rep, or to talk to someone.
- Use "question" if they ask about the business, products, pricing, mention a service name casually without an explicit booking request (e.g., just saying "gội đầu", "cắt tóc", "haircut"), or need general information.
- Use "small_talk" if they are just saying hello, thanks, goodbye, or casual chit-chat.${
  bookingEnabled
    ? `
- Use 'book_appointment' if the user explicitly wants to book, make a reservation, or schedule a service (e.g., "tôi muốn đặt lịch", "book appointment", "đặt lịch gội đầu", "book a haircut", "hẹn lịch", "lên lịch").
- Use 'check_booking' if the user wants to check the status or details of their existing appointment.
- Use 'cancel_booking' if the user wants to cancel or delete an appointment.`
    : ''
}

You must also detect the overall sentiment of the user's message.
- Use "positive" if the user is happy, satisfied, or expressing gratitude.
- Use "negative" if the user is angry, frustrated, complaining, or using aggressive language.
- Use "neutral" for everything else, including normal questions.`;

export type CancelStep = 'ask_code' | 'verify_phone' | 'await_confirm' | null;

export interface CancelState {
  step: CancelStep;
  bookingCode: string | null;
  phoneVerified: boolean;
}

export interface CancelPrompts {
  askCode: string;
  verifyPhone: string;
  phoneWrong: string;
  confirmCancel: string;
  keepConfirmed: string;
  cancelSuccess: string;
  cancelFail: string;
  alreadyCancelled: string;
  notFound: string;
}

export const getCancelPrompts = (isVietnamese: boolean): CancelPrompts => ({
  askCode: isVietnamese
    ? 'Để hủy lịch, vui lòng cung cấp mã đặt lịch của bạn.'
    : 'To cancel your booking, please provide your booking code.',

  verifyPhone: isVietnamese
    ? 'Để xác nhận danh tính, vui lòng cho biết số điện thoại bạn đã đăng ký khi đặt lịch.'
    : 'To verify your identity, please provide the phone number you used when booking.',

  phoneWrong: isVietnamese
    ? 'Số điện thoại không khớp với lịch đặt. Vui lòng kiểm tra và thử lại.'
    : 'The phone number does not match this booking. Please check and try again.',

  confirmCancel: isVietnamese
    ? 'Vui lòng xem lại thông tin lịch đặt ở thẻ bên trên và xác nhận nếu bạn muốn hủy.'
    : 'Please review the booking details in the card above and confirm if you want to cancel.',

  keepConfirmed: isVietnamese
    ? 'Lịch đặt của bạn được giữ nguyên. Có điều gì khác tôi có thể giúp bạn không?'
    : 'Your booking has been kept. Is there anything else I can help you with?',

  cancelSuccess: isVietnamese
    ? 'Lịch đặt của bạn đã được hủy thành công.'
    : 'Your booking has been successfully cancelled.',

  cancelFail: isVietnamese
    ? 'Không thể hủy lịch này. Vui lòng liên hệ nhân viên để được hỗ trợ.'
    : 'Unable to cancel this booking. Please contact staff for assistance.',

  alreadyCancelled: isVietnamese
    ? 'Lịch đặt này đã được hủy trước đó rồi.'
    : 'This booking has already been cancelled.',

  notFound: isVietnamese
    ? 'Không tìm thấy lịch đặt với mã này. Vui lòng kiểm tra lại.'
    : 'No booking found with this code. Please check and try again.',
});
