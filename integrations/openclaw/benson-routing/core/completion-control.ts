import Type from 'typebox';
import { CompletionBindingSchema, ParentSessionSchema, DestinationSchema } from './contracts.js';
import { IdentifierSchema as Id } from './value.js';
import { decode, fail, freeze, identifier, nullable, plain } from './value.js';
import { validateTaskResultEnvelope } from './legacy-response.js';
// S07 v1 accepts host records with additional fields. It is separate from v3–v5.
const host = Type.Object;
const CommitmentSchema = host({ requestId: Id, sessionId: Id, phase: Type.Literal('committed'), owner: Id });
const ChildSchema = host({ runId: Id, childSessionKey: Id, requesterSessionKey: Id,
  requesterTurnRunId: Type.Optional(nullable(Id)), agentId: Id,
  execution: host({ status: Type.Literal('terminal'), outcome: host({ status: Type.Literal('ok') }) }) });
const TaskSchema = host({ runId: Id, childSessionKey: Id, agentId: Id, runtime: Type.Literal('subagent'),
  status: Type.Enum(['running', 'succeeded']), taskId: Id });
const BindInputSchema = host({ commitment: CommitmentSchema, sourceTurnId: Id, parentSessionKey: Id,
  parentSessionId: Id, parentRunId: nullable(Id), childRunId: Id, childSessionKey: Id,
  executionOwner: Type.Enum(['jessica-vacuum', 'reminder-service']), completionTarget: DestinationSchema });
const HostBindingSchema = host(CompletionBindingSchema.properties);
const ValidateInputSchema = host({ binding: HostBindingSchema, commitment: CommitmentSchema,
  parentSession: host(ParentSessionSchema.properties), child: ChildSchema, task: TaskSchema, result: Type.Unknown() });
function same(a: unknown, b: unknown): boolean { return identifier(a) && a === b; }
export function bindNativeCompletion(raw: unknown) {
  if (!plain(raw) || !plain(raw.commitment)) fail('completion_binding_unavailable');
  const value = decode(BindInputSchema, raw, 'completion_binding_unavailable');
  const { commitment: c, sourceTurnId, parentSessionKey, parentSessionId, parentRunId, childRunId,
    childSessionKey, executionOwner, completionTarget } = value;
  if (!same(c.requestId, sourceTurnId) || !same(c.sessionId, parentSessionId) || !identifier(parentSessionKey) ||
    (completionTarget === 'CALLER' ? !identifier(parentRunId) : parentRunId !== null) || !identifier(childRunId) || !identifier(childSessionKey) ||
    !childSessionKey.startsWith(`agent:${executionOwner}:subagent:`) || c.owner !== (completionTarget === 'CALLER' ? 'main' : executionOwner)) fail('completion_binding_unavailable');
  return freeze({ schemaVersion: 1 as const, requestId: sourceTurnId, parentSessionKey, parentSessionId, parentRunId,
    childRunId, childSessionKey, executionOwner, completionTarget, callerRunId: completionTarget === 'CALLER' ? parentRunId : null });
}
export function validateNativeCompletion(raw: unknown) {
  if (!plain(raw) || ![raw.binding, raw.commitment, raw.parentSession, raw.child, raw.task].every(plain)) fail('completion_owner_mismatch');
  const { binding: b, commitment: c, parentSession: p, child, task, result } = decode(ValidateInputSchema, raw, 'completion_owner_mismatch');
  if (![b.requestId, b.parentSessionKey, b.parentSessionId, b.childRunId, b.childSessionKey].every(identifier) ||
    !['jessica-vacuum', 'reminder-service'].includes(b.executionOwner) ||
    (b.completionTarget === 'CALLER' ? !identifier(b.parentRunId) : b.parentRunId !== null) ||
    !same(p.sessionKey, b.parentSessionKey) || !same(p.sessionId, b.parentSessionId) ||
    !same(child.runId, b.childRunId) || !same(child.childSessionKey, b.childSessionKey) ||
    !same(child.requesterSessionKey, b.parentSessionKey) ||
    (b.completionTarget === 'CALLER' ? !same(child.requesterTurnRunId, b.parentRunId) : child.requesterTurnRunId != null) ||
    !same(child.agentId, b.executionOwner) || !same(task.runId, b.childRunId) || !same(task.childSessionKey, b.childSessionKey) ||
    !same(task.agentId, b.executionOwner) || !identifier(task.taskId) || !same(c.requestId, b.requestId) ||
    !same(c.sessionId, b.parentSessionId) || c.owner !== (b.completionTarget === 'CALLER' ? 'main' : b.executionOwner)) fail('completion_owner_mismatch');
  if (b.completionTarget === 'CALLER' ? !same(b.callerRunId, b.parentRunId) : b.callerRunId !== null) fail('completion_caller_mismatch');
  const normalized = validateTaskResultEnvelope(result);
  if (!same(normalized.taskId, task.taskId) || normalized.domain !== (b.executionOwner === 'reminder-service' ? 'reminder' : b.executionOwner)) fail('completion_result_mismatch');
  return freeze({ schemaVersion: 1 as const, requestId: b.requestId, childRunId: b.childRunId, taskId: task.taskId,
    destination: b.completionTarget, callerRunId: b.callerRunId, result: normalized });
}
