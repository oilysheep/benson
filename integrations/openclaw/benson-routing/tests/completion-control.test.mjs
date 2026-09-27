import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeCompletion, validateNativeCompletion } from '../completion-control.mjs';

const parentSessionKey = 'agent:main:whatsapp:direct:oren';
const parentSessionId = 'native-parent-session';
const parentRunId = 'native-parent-turn';
const childRunId = 'native-child-run';
const childSessionKey = 'agent:jessica-vacuum:subagent:native-child';
const requestId = 'channel-user:v1:canonical-source';
const commitment = { requestId, sessionId: parentSessionId, owner: 'main', phase: 'committed' };
const bindingInput = { commitment, sourceTurnId: requestId, parentSessionKey,
  parentSessionId, parentRunId, childRunId, childSessionKey,
  executionOwner: 'jessica-vacuum', completionTarget: 'CALLER' };
const result = { schemaVersion: 1, domainSchemaVersion: '1', taskId: 'native-task',
  status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
  data: { observedAt: '2026-09-27T07:00:00Z' }, warnings: [], error: null,
  pendingContext: null, messageCandidate: null };
const native = (binding, overrides = {}) => ({ binding, commitment,
  parentSession: { sessionKey: parentSessionKey, sessionId: parentSessionId },
  child: { runId: childRunId, childSessionKey, requesterSessionKey: parentSessionKey,
    requesterTurnRunId: parentRunId, agentId: 'jessica-vacuum',
    execution: { status: 'terminal', outcome: { status: 'ok' } } },
  task: { taskId: 'native-task', runId: childRunId, childSessionKey,
    agentId: 'jessica-vacuum', runtime: 'subagent', status: 'succeeded' },
  result, ...overrides });

test('CALLER receives only its bound child as a structured result', () => {
  const binding = bindNativeCompletion(bindingInput);
  const admission = validateNativeCompletion(native(binding));
  assert.equal(admission.destination, 'CALLER');
  assert.equal(admission.callerRunId, parentRunId);
  assert.deepEqual(JSON.parse(JSON.stringify(admission.result)), result);
  assert.equal(Object.hasOwn(admission, 'recipient'), false);
  assert.equal(validateNativeCompletion(native(binding, {
    task: { ...native(binding).task, status: 'running' },
  })).taskId, 'native-task');
});

test('direct result stays in RESPONSE_CONTROLLER handoff without Main wrapper', () => {
  const directCommitment = { ...commitment, owner: 'jessica-vacuum' };
  const binding = bindNativeCompletion({ ...bindingInput, commitment: directCommitment,
    completionTarget: 'RESPONSE_CONTROLLER', parentRunId: null });
  const admission = validateNativeCompletion(native(binding, { commitment: directCommitment,
    child: { ...native(binding).child, requesterTurnRunId: null } }));
  assert.equal(admission.destination, 'RESPONSE_CONTROLLER');
  assert.equal(binding.parentRunId, null);
  assert.throws(() => bindNativeCompletion({ ...bindingInput, commitment: directCommitment,
    completionTarget: 'RESPONSE_CONTROLLER' }), /binding_unavailable/);
  assert.equal(admission.callerRunId, null);
  assert.equal(admission.result.taskId, 'native-task');
});

test('foreign, stale, contradictory and unverified facts cannot enter completion', () => {
  assert.throws(() => bindNativeCompletion({ ...bindingInput, sourceTurnId: 'another' }),
    /binding_unavailable/);
  assert.throws(() => bindNativeCompletion({ ...bindingInput, commitment: { ...commitment,
    sessionId: 'replaced' } }), /binding_unavailable/);
  const binding = bindNativeCompletion(bindingInput);
  for (const sample of [
    { parentSession: { sessionKey: parentSessionKey, sessionId: 'replaced' } },
    { child: { ...native(binding).child, requesterTurnRunId: 'other-turn' } },
    { child: { ...native(binding).child, requesterSessionKey: 'agent:other:main' } },
    { task: { ...native(binding).task, status: 'queued' } },
    { result: { ...result, taskId: 'other-task' } },
    { result: { ...result, verified: false } },
  ]) assert.throws(() => validateNativeCompletion(native(binding, sample)));
});

import { normalizeReminderCompletion, normalizeReminderServiceResult,
  REMINDER_TOOL_DEFINITIONS } from '../../plugins/benson-reminder-tool/dist/contracts.js';

const reminderDefinition = REMINDER_TOOL_DEFINITIONS.find((item) => item.name === 'benson_reminder_list');
const reminderService = { status: 'success', operation: 'list', verified: true,
  matchCount: 2, matches: [{ reminderId: 'one' }, { reminderId: 'two' }], warnings: [] };
const reminderTrusted = { taskId: 'reminder-task', pendingBinding: null, pendingExpiresAt: null };
const reminderResult = normalizeReminderServiceResult(reminderDefinition, reminderService, reminderTrusted);
const reminderFinal = Object.fromEntries(['status', 'domain', 'operation', 'verified', 'data',
  'warnings', 'error', 'pendingContext'].map((key) => [key, reminderResult[key]]));
const at = Date.parse('2026-09-27T07:00:00Z');
const reminderTask = { runId: 'reminder-child-run', runtime: 'subagent', agentId: 'reminder-service',
  status: 'succeeded', childSessionKey: 'agent:reminder-service:subagent:native-child',
  createdAt: at, endedAt: at + 2000 };
const reminderParent = [{ seq: 1, role: 'user', message: { role: 'user', timestamp: at - 1000,
  __openclaw: { senderId: 'trusted-requester' } } }];
function reminderChild(service = reminderService, final = reminderFinal) {
  return [
    { seq: 1, role: 'assistant', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'native-call', name: 'benson_reminder_list' }] } },
    { seq: 2, role: 'toolResult', message: { role: 'toolResult', toolName: 'benson_reminder_list',
      toolCallId: 'native-call', isError: false, content: [{ type: 'text', text: JSON.stringify(service) }],
      details: service } },
    { seq: 3, role: 'assistant', message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: JSON.stringify(final) }] } },
  ];
}
function reminderArgs(parent = reminderParent, child = reminderChild()) {
  return { runId: reminderTask.runId, parentSessionKey, runs: [reminderTask],
    readMessages: async ({ agentId }) => agentId === 'main' ? parent : child,
    now: new Date(at + 3000) };
}

test('Reminder completion derives full-list truth from one native service call', async () => {
  const normalized = await normalizeReminderCompletion(reminderArgs(), reminderTrusted);
  assert.equal(normalized.status, 'success');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.data.matches)), reminderService.matches);
});

test('Reminder running task needs its exact completed native run and one service call', async () => {
  const running = { ...reminderTask, status: 'running', endedAt: undefined };
  const completedRun = { runId: running.runId, childSessionKey: running.childSessionKey,
    execution: { status: 'terminal', outcome: { status: 'ok' }, endedAt: at + 2000 } };
  const args = { ...reminderArgs(), runs: [running], completedRun };
  assert.equal((await normalizeReminderCompletion(args, reminderTrusted)).status, 'success');
  await assert.rejects(normalizeReminderCompletion({ ...args,
    completedRun: { ...completedRun, runId: 'foreign-run' } }, reminderTrusted));
  const extraCall = { seq: 4, role: 'assistant', message: { role: 'assistant',
    content: [{ type: 'toolCall', id: 'extra', name: 'benson_reminder_list' }] } };
  const child = reminderChild();
  child.splice(2, 0, extraCall);
  child[3] = { ...child[3], seq: 5 };
  await assert.rejects(normalizeReminderCompletion({ ...args,
    readMessages: async ({ agentId }) => agentId === 'main' ? reminderParent : child },
  reminderTrusted), /provenance/);
});

test('Reminder completion rejects fabricated final, missing provenance, and stale request', async () => {
  await assert.rejects(normalizeReminderCompletion(reminderArgs(reminderParent,
    reminderChild(reminderService, { ...reminderFinal, verified: false })), reminderTrusted));
  await assert.rejects(normalizeReminderCompletion(reminderArgs(reminderParent,
    reminderChild().slice(1)), reminderTrusted), /provenance/);
  const stale = [...reminderParent, { seq: 4, role: 'user', message: { role: 'user',
    timestamp: at + 1000, __openclaw: { senderId: 'another-request' } } }];
  await assert.rejects(normalizeReminderCompletion(reminderArgs(stale), reminderTrusted), /earlier request/);
});
