import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createResponseEnvelope,
  normalizeLegacyTaskResult,
} from '../envelope.mjs';
import { controlResponse } from '../response-control.mjs';
import { createSourceAdmissionController } from '../request-control.mjs';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/presentation-cases.json', import.meta.url)));
const fixture = (id) => structuredClone(corpus.cases.find((item) => item.id === id));

const control = (raw, options = {}) => controlResponse(raw, {
  language: 'en', timezone: corpus.fixedClock.timezone, now: corpus.fixedClock.now, ...options,
});

// An unrelated future domain proves that no controller switch/registry edit is
// needed. Authority is a host-context fixture, not native security evidence.
function readFixture(disposition = 'handled') {
  let live = true;
  const controller = createSourceAdmissionController({
    invocation: { callId: 'read-call', domain: 'future-domain', subject: 'reader' },
    now: () => Date.parse('2026-10-10T10:00:00Z'),
    assertCurrent() { assert.equal(live, true, 'invocation closed'); },
    assertDomainOutcome(outcome) { assert.deepEqual(JSON.parse(JSON.stringify(outcome.evidence.facts)), { value: 7 }); },
  });
  const admission = controller.admit({ schemaVersion: 2, kind: 'benson.source-input',
    domain: 'future-domain', scope: 'read', request: '{"operation":"read"}' });
  const outcome = { schemaVersion: 2, kind: 'benson.no-run',
    admission: { authorityKind: 'native-invocation', callId: 'read-call', domain: 'future-domain', subject: 'reader' },
    disposition, evidence: { ref: 'read-call', observedAt: '2026-10-10T10:00:00Z', freshness: 'fresh', facts: { value: 7 } },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null,
    error: ['failed', 'unresolved', 'rejected'].includes(disposition)
      ? { code: 'READ_DENIED', message: 'read unavailable', retryable: false } : null };
  return { controller, admission, outcome, close() { live = false; },
    renderOutcome: value => ({ schemaVersion: 2, message: `Verified: ${value.evidence.facts.value}` }) };
}

test('generic read response preserves no-Run identity without a fake task or Run', () => {
  const f = readFixture();
  const result = controlResponse(f.outcome, f);
  assert.deepEqual(JSON.parse(JSON.stringify(result.outcome)), f.outcome);
  assert.equal(result.rendered.message, 'Verified: 7');
  assert.equal(result.mode, 'deterministic');
  assert.equal(result.outcome.runId, undefined);
  assert.equal(result.outcome.taskId, undefined);
  assert.throws(() => f.controller.admit({ schemaVersion: 2, kind: 'benson.source-input',
    domain: 'foreign-domain', scope: 'read', request: 'read' }), /input_invalid/);
});

test('no-Run dispositions retain their semantics and never launch a Run or model', () => {
  for (const disposition of ['handled', 'no-change', 'failed', 'rejected', 'unresolved', 'suppressed', 'reasoning-required']) {
    const f = readFixture(disposition);
    let renders = 0;
    const result = controlResponse(f.outcome, { ...f, renderOutcome(value) { renders++; return f.renderOutcome(value); } });
    assert.equal(result.outcome.disposition, disposition);
    assert.equal(renders, ['suppressed', 'reasoning-required'].includes(disposition) ? 0 : 1);
    assert.equal(result.rendered === null, renders === 0);
  }
});

test('read response rejects missing authority, foreign correlation, malformed facts and effects', () => {
  const f = readFixture();
  assert.throws(() => controlResponse(f.outcome), /dependencies_unavailable/);
  for (const change of [value => value.schemaVersion = 99,
    value => value.admission.callId = 'other-call', value => value.evidence.facts.value = 8,
    value => value.effects = { status: 'known', refs: ['effect'] },
    value => value.notification = { unexpected: true }]) {
    const raw = structuredClone(f.outcome); change(raw);
    assert.throws(() => controlResponse(raw, f));
  }
});

test('rendering remains bounded, synchronous and fenced before disclosure', () => {
  const f = readFixture();
  for (const renderOutcome of [() => ({ schemaVersion: 2, message: '' }),
    () => ({ schemaVersion: 2, message: 'x'.repeat(100000) }),
    async () => ({ schemaVersion: 2, message: 'unexpected async renderer' })]) {
    assert.throws(() => controlResponse(f.outcome, { ...f, renderOutcome }));
  }
  assert.throws(() => controlResponse(f.outcome, { ...f, renderOutcome() {
    f.close(); return { schemaVersion: 2, message: 'late disclosure' };
  } }), /invocation closed/);
});

function direct(item, { candidate = null, modes = ['deterministic', 'safe_failure'],
  preferredMode = modes[0] } = {}) {
  const result = normalizeLegacyTaskResult(item.result, {
    taskId: `task-${item.id}`, pendingBinding: null, pendingExpiresAt: null,
  }, candidate);
  return createResponseEnvelope({ messageCandidate: candidate }, {
    requestId: `request-${item.id}`,
    source: { type: 'direct', agentId: item.result.domain === 'reminder'
      ? 'reminder-service' : 'jessica-vacuum', runId: `run-${item.id}` },
    status: result.status, results: [result], pendingContext: result.pendingContext,
    responsePolicy: { allowedModes: modes, preferredMode },
    provenance: { executionVerified: result.verified, completionCorrelated: true },
    lifecycle: { domainExecution: 'attempted', failure: null },
  });
}

test('reviewed deterministic results use exact facts and the shared date clock', () => {
  for (const id of ['jessica-status-read-en', 'jessica-maintenance-warning-en',
    'reminder-create-verified-he']) {
    const item = fixture(id);
    const answer = control(direct(item), {
      language: item.language, now: corpus.fixedClock.now,
    });
    assert.equal(answer.mode, 'deterministic', id);
    assert.equal(answer.rendered.message, item.expected.exactText, id);
  }
});

test('agent prose cannot authorize domain pass-through or hide a warning', () => {
  const item = fixture('jessica-maintenance-warning-en');
  const candidate = { text: 'The brush is fine.', language: 'en' };
  const result = control(direct(item, {
    candidate, modes: ['pass_through', 'deterministic', 'safe_failure'],
  }), { language: 'en' });
  assert.equal(result.mode, 'deterministic');
  assert.match(result.rendered.message, /Warning: dustbin sensor data is unavailable/u);
  const matching = control(direct(item, {
    candidate: { text: item.expected.exactText, language: 'en' },
    modes: ['pass_through', 'deterministic'],
  }), { language: 'en' });
  assert.equal(matching.mode, 'pass_through');
});

test('unknown domain shape uses a truthful bounded fallback and reports unsummarized warnings', () => {
  const item = fixture('jessica-status-read-en');
  item.result.operation = 'future-operation';
  item.result.warnings = [{ code: 'PARTIAL_DATA', message: 'One sensor was unavailable' }];
  const answer = control(direct(item), { language: 'en' });
  assert.equal(answer.mode, 'safe_failure');
  assert.match(answer.rendered.message, /reported successful/u);
  assert.match(answer.rendered.message, /cannot safely summarize their details/u);
  assert.doesNotMatch(answer.rendered.message, /One sensor was unavailable/u);
  assert.match(answer.rendered.message, /will not repeat/u);
  assert.doesNotMatch(answer.rendered.message, /\{/u);
});

test('unreviewed warning prose is never echoed by fallback and unsupported modes fail closed', () => {
  const item = fixture('jessica-status-read-en');
  item.result.operation = 'future-operation';
  item.result.warnings = [{ code: 'PARTIAL_DATA', message: 'bad\ntext' }];
  const answer = control(direct(item), { language: 'en' });
  assert.equal(answer.mode, 'safe_failure');
  assert.doesNotMatch(answer.rendered.message, /bad\ntext/u);
  const normal = fixture('jessica-status-read-en');
  assert.throws(() => control(direct(normal, { modes: ['response_model'] }),
    { language: 'en' }), /response_mode_unavailable/u);
});

test('a later infrastructure failure cannot render one successful result as a complete success', () => {
  const item = fixture('jessica-status-read-en');
  const response = direct(item);
  const partial = { ...response, status: 'partial', lifecycle: {
    domainExecution: 'uncertain', failure: { code: 'LATER_COMPLETION_UNAVAILABLE' },
  } };
  const answer = control(partial, { language: 'en' });
  assert.equal(answer.mode, 'safe_failure');
  assert.match(answer.rendered.message, /cannot verify a complete response/u);
  assert.doesNotMatch(answer.rendered.message, /docked/u);
});

test('no-result uncertain execution warns about effects without inventing a domain result', () => {
  const envelope = createResponseEnvelope({ messageCandidate: null }, {
    requestId: 'request-uncertain',
    source: { type: 'direct', agentId: 'jessica-vacuum', runId: 'child-uncertain' },
    results: [], status: 'failure', pendingContext: null,
    responsePolicy: { allowedModes: ['safe_failure'], preferredMode: 'safe_failure' },
    provenance: { executionVerified: false, completionCorrelated: false },
    lifecycle: { domainExecution: 'uncertain', failure: { code: 'RESULT_UNAVAILABLE' } },
  });
  const answer = control(envelope, { language: 'en' });
  assert.match(answer.rendered.message, /may have had effects/u);
  assert.match(answer.rendered.message, /will not repeat it automatically/u);
});

test('ordinary Main-only conversation uses the reviewed no-domain pass-through contract', () => {
  const candidate = { text: 'Hello.', language: 'en' };
  const envelope = createResponseEnvelope({ messageCandidate: candidate }, {
    requestId: 'request-main', source: { type: 'main', agentId: 'main', runId: 'run-main' },
    results: [], status: 'success', pendingContext: null,
    responsePolicy: { allowedModes: ['pass_through', 'safe_failure'], preferredMode: 'pass_through' },
    provenance: { executionVerified: 'not_applicable', completionCorrelated: false },
    lifecycle: { domainExecution: 'none', failure: null },
  });
  assert.deepEqual(control(envelope, { language: 'en' }), {
    mode: 'pass_through', rendered: { schemaVersion: 2, message: 'Hello.' },
  });
});
