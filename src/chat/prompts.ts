export const getIntentClassifierPrompt = (
  bookingEnabled: boolean,
) => `You are an intent classifier for a customer support chatbot. Determine the user's intent from the following message.
Analyze the message enclosed in <user_input> tags.

- Use "request_human" if they ask for an agent, human, support rep, or to talk to someone.
- Use "question" if they ask about the business, products, pricing, or need factual help.
- Use "small_talk" if they are just saying hello, thanks, goodbye, or casual chat.${
  bookingEnabled
    ? `
- Use 'book_appointment' if the user wants to book, make a reservation, or schedule a service.
- Use 'check_booking' if the user wants to check the status or details of their existing appointment.
- Use 'cancel_booking' if the user wants to cancel or delete an appointment.`
    : ''
}

You must also detect the overall sentiment of the user's message.
- Use "positive" if the user is happy, satisfied, or expressing gratitude.
- Use "negative" if the user is angry, frustrated, complaining, or using aggressive language.
- Use "neutral" for everything else, including normal questions.`;
