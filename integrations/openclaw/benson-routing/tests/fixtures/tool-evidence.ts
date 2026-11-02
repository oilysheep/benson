import { retainToolExecutionEvidence, type ToolExecutionCoverage } from '../../core/tool-execution-evidence.js';
function receiptArgs(name: string): unknown {
  const input = { requesterId: 'reader', sourceConversation: { type: 'private', id: 'source' }, recipientIds: ['recipient'],
    content: 'fixture', schedule: { type: 'one-shot', resolvedTime: '2026-11-03T10:00:00Z', timezone: 'UTC' }, calendar: { requested: false } };
  switch (name) {
    case 'jessica_execute': return { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room'] } };
    case 'jessica_read': return { operation: 'status' };
    case 'benson_reminder_create': return { input };
    case 'benson_reminder_create_plan': {
      const item = { ...input, calendar: { requested: true, durationMinutes: 30, eventSchedule: input.schedule },
        provenance: { schemaVersion: 1, contextId: 'conversation', revision: 1, createdAt: '2026-11-02T08:00:00Z',
          expiresAt: '2026-11-02T08:05:00Z', sourceConversation: input.sourceConversation, requesterId: input.requesterId,
          currentEvidenceId: 'original-input', evidence: [{ id: 'original-input', text: 'fixture' }],
          fieldEvidence: [{ field: 'content', evidenceId: 'original-input', quote: 'fixture' }] } };
      return { input: { items: [structuredClone(item), structuredClone(item)] } };
    }
    case 'benson_reminder_find': case 'benson_reminder_list': return { requesterId: 'reader' };
    default: return { requesterId: 'reader', reminderId: 'existing', ...name === 'benson_reminder_update' ? { input: { content: 'fixture' } } : {} };
  }
}
/** Unit-only host provider. Snapshot once, before injecting evidence faults. */
export function unitToolEvidence(input: { binding: ToolExecutionCoverage['identity'];
  preceding?: readonly { tool: { callId: string; name: string }; after: { value: unknown } }[];
  tool?: { callId: string; name: string }; after?: { value: unknown } }, args: (name: string) => unknown = receiptArgs) {
  const items = [...input.preceding ?? [], ...input.tool && input.after ? [{ tool: input.tool, after: input.after }] : []];
  const value: ToolExecutionCoverage = { version: 1, identity: structuredClone({ runId: input.binding.runId,
    sessionKey: input.binding.sessionKey, sessionId: input.binding.sessionId, agentId: input.binding.agentId }),
    receipts: items.map(({ tool, after }, ordinal) => ({ ordinal, attempt: 1, callId: tool.callId, name: tool.name,
      originalArgs: structuredClone(args(tool.name)), validatedArgs: structuredClone(args(tool.name)), executionArgs: structuredClone(args(tool.name)),
      executionStarted: true, originalIsError: false, originalResult: structuredClone(after.value), isError: false, result: structuredClone(after.value) })),
    seal: { complete: true, count: items.length, attempts: 1 } };
  return retainToolExecutionEvidence(() => value, () => {});
}
