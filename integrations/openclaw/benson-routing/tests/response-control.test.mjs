import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createResponseEnvelope,
  normalizeLegacyTaskResult,
} from '../envelope.mjs';
import { controlResponse } from '../response-control.mjs';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/presentation-cases.json', import.meta.url)));
const fixture = (id) => structuredClone(corpus.cases.find((item) => item.id === id));

const control = (raw, options = {}) => controlResponse(raw, {
  language: 'en', timezone: corpus.fixedClock.timezone, now: corpus.fixedClock.now, ...options,
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
