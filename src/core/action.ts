import { z } from 'zod';

export const AgentActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('navigate'),
    url: z.string().url('Must be a valid URL'),
  }),
  z.object({
    type: z.literal('click'),
    elementId: z.string().min(1, 'Element ID cannot be empty (e.g., "e1")'),
  }),
  z.object({
    type: z.literal('type'),
    elementId: z.string().min(1, 'Element ID cannot be empty (e.g., "e1")'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().positive().default(3),
  }),
  z.object({
    type: z.literal('extract'),
    elementId: z.string().optional().describe('Optional element ID to extract from specific element'),
  }),
  z.object({
    type: z.literal('finish'),
    result: z.string(),
  }),
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;
