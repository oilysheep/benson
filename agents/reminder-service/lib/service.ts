import { parseRequest, type ServiceRequest, type ToolName, type CreateInput, type PlanItem } from './schemas.js';
import { validateProvenance, validateCalendarMetadata, type ReminderEvidence } from './provenance.js';
import type { IdentityContract, RuntimeRoute } from './identity.js';
import { assertInvocationCurrent, type InvocationAuthority } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
export type { InvocationAuthority } from '../../../integrations/openclaw/benson-routing/core/invocation.js';

/** One complete deterministic Python transaction. There is no per-step service API. */
export interface ReminderTransaction { execute(request: ServiceRequest, authority: InvocationAuthority): Promise<unknown> }
export interface Dependencies {
  readonly identities: IdentityContract; readonly route: RuntimeRoute; readonly evidence: ReminderEvidence;
  readonly transaction: ReminderTransaction; readonly authority: InvocationAuthority; readonly clock?: () => Date;
}
const current = assertInvocationCurrent;
export async function executeReminderTool(name: ToolName, raw: unknown, deps: Dependencies): Promise<unknown> {
  current(deps.authority);
  const request = parseRequest(name, raw);
  const route = deps.route;
  if (!deps.identities.trustedRequesterIds.includes(route.requesterId)) throw new Error('Reminder requester is untrusted');
  const checkedEvidence: ReminderEvidence = {
    async readCurrentUserText() { current(deps.authority); const value = await deps.evidence.readCurrentUserText(); current(deps.authority); return value; },
    async readOriginalUserTurns() { current(deps.authority); const value = await deps.evidence.readOriginalUserTurns(); current(deps.authority); return value; } };
  async function create(input: CreateInput | PlanItem) {
    if (input.requesterId !== route.requesterId || input.sourceConversation.type !== route.sourceType || input.sourceConversation.id !== route.sourceId ||
      input.recipientIds.some(id => !deps.identities.recipientIds.includes(id))) throw new Error('Reminder create route or recipient mismatch');
    const verified = await validateProvenance(input, checkedEvidence, route, (deps.clock ?? (() => new Date()))());
    await validateCalendarMetadata(input.calendar, input.verbatimRequest, verified, checkedEvidence);
  }
  if (request.operation === 'create-intent') {
    if ('items' in request.input) { for (const item of request.input.items) await create(item); }
    else {
      if (Object.hasOwn(request.input, 'schedule') === Object.hasOwn(request.input, 'schedules')) throw new Error('Supply exactly one Reminder schedule or schedules');
      await create(request.input);
    }
  } else {
    if (request.requesterId !== route.requesterId) throw new Error('Reminder requester does not match trusted route');
    if ((request.operation === 'list-reminders' || request.operation === 'find-reminders') && request.recipient !== undefined && !deps.identities.recipientIds.includes(request.recipient)) throw new Error('Reminder recipient unknown');
    if (request.operation === 'update-reminder') {
      const input = request.input;
      if (input.recipientId !== undefined && !deps.identities.recipientIds.includes(input.recipientId)) throw new Error('Reminder update recipient invalid');
      if (!['content', 'schedule', 'calendar'].some(key => Object.hasOwn(input, key))) throw new Error('Reminder update patch must not be empty');
      if (input.calendar) await validateCalendarMetadata(input.calendar, input.verbatimRequest, null, checkedEvidence);
    }
  }
  current(deps.authority);
  const result = await deps.transaction.execute(request, deps.authority);
  current(deps.authority);
  return result;
}
