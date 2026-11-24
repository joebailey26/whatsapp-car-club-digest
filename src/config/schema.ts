import { z } from 'zod';

/**
 * Runtime-validated configuration, stored in Durable Object storage and edited
 * through the admin API. Group names live here, not in the repository.
 */

export const GroupSchema = z.object({
  /** Stable slug used in R2 keys, e.g. "group-a". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'id must be a lowercase slug'),
  /** Exact display name in WhatsApp. Used to find and verify the chat. */
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
});
export type Group = z.infer<typeof GroupSchema>;

export const GroupsConfigSchema = z
  .object({ groups: z.array(GroupSchema).max(10) })
  .refine((c) => new Set(c.groups.map((g) => g.id)).size === c.groups.length, 'group ids must be unique');
export type GroupsConfig = z.infer<typeof GroupsConfigSchema>;

const selector = z.string().min(1).max(500);
const timeoutMs = z.number().int().min(100).max(180_000).optional();

/** One browser step. Mirrors browser/src/driver.ts (which validates again). */
export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('click'), selector, timeoutMs, optional: z.boolean().optional() }),
  z.object({ op: z.literal('type'), selector, text: z.string().min(1).max(200), timeoutMs, clear: z.boolean().optional() }),
  z.object({ op: z.literal('press'), key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace']), times: z.number().int().min(1).max(5).optional() }),
  z.object({ op: z.literal('waitFor'), selector, timeoutMs, optional: z.boolean().optional() }),
  z.object({ op: z.literal('waitGone'), selector, timeoutMs }),
  z.object({ op: z.literal('sleep'), ms: z.number().int().min(0).max(30_000) }),
  z.object({ op: z.literal('exists'), selector, as: z.string().min(1).max(40) }),
  z.object({ op: z.literal('inspect'), as: z.string().min(1).max(40) }),
  z.object({ op: z.literal('expectDownload'), timeoutMs, maxBytes: z.number().int().min(1).max(200 * 1024 * 1024).optional() }),
]);
export type Step = z.infer<typeof StepSchema>;

export const StepsSchema = z.array(StepSchema).min(1).max(80);

/**
 * The export flow: steps run once per group, with {{placeholders}}.
 *  - openChat: find and open the group; must end with the chat open
 *  - verifyChat: `exists` checks proving the right chat is open (fact names must start with "chat_")
 *  - export: open the menu, choose Export chat, options, trigger, then expectDownload
 *  - reset: return to a neutral state (e.g. Escape); failures here are ignored
 */
export const FlowSchema = z.object({
  version: z.number().int().min(1),
  openChat: StepsSchema,
  verifyChat: StepsSchema,
  export: StepsSchema,
  reset: z.array(StepSchema).max(10),
  notes: z.string().max(2000).optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

export const InspectRequestSchema = z.object({
  /** Optional steps to run before the final inspection (may use {{groupName}} etc. with groupId). */
  steps: z.array(StepSchema).max(40).optional(),
  groupId: z.string().optional(),
});
export type InspectRequest = z.infer<typeof InspectRequestSchema>;

/** Short, safe summary of a Zod error for API responses. */
export function zodMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
