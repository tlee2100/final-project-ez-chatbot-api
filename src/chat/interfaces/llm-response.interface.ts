/**
 * Output contract for the AiService invoke() method.
 */
export interface LLMResponse {
  /** The full generated text from the model */
  content: string;
}
