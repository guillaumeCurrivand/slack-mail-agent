import { z } from 'zod';
import { inventoryQuery } from './inventory-query.js';

export const questionPlan = z.strictObject({
  operation: z.enum(['hosting', 'technologies', 'inventory', 'mutation', 'clarify', 'unsupported']),
  selector: z.string().trim().min(1).max(120).nullable(),
  query: inventoryQuery.nullable().default(null),
  mutation: z.unknown().optional(), // Historical saved plans can include a proposed mutation.
});
export type QuestionPlan = z.infer<typeof questionPlan>;
export { readQuestionConfig as readDocumentationAIConfig, requestPlan, type QuestionAIConfig } from '../../core/question-ai.js';
