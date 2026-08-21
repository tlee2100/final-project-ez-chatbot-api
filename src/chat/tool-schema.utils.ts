import { z } from 'zod';

export const buildToolSchema = (schema: Record<string, unknown>) =>
  z.fromJSONSchema(schema) as z.ZodType<Record<string, unknown>>;
