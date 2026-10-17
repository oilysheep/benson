import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures/domain-state.js';
import { createJessicaReader } from '../../../../../agents/jessica-vacuum/lib/read-service.js';
import { executeJessicaStatusTask } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { renderJessicaPresentation } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { renderReminderPresentation } from '../../../../../agents/reminder-service/lib/presentation.js';
import { plain } from '../../../benson-routing/core/value.js';
test('domain-owned presentation preserves every retained golden and unsupported disposition', () => {
  const corpus: unknown = JSON.parse(readFileSync('integrations/openclaw/benson-routing/tests/fixtures/presentation-cases.json', 'utf8'));
  assert.ok(plain(corpus) && Array.isArray(corpus.cases) && plain(corpus.fixedClock));
  assert.equal(typeof corpus.fixedClock.now, 'string'); assert.equal(typeof corpus.fixedClock.timezone, 'string');
  const now = String(corpus.fixedClock.now), zone = String(corpus.fixedClock.timezone);
  let count = 0;
  for (const item of corpus.cases) {
    assert.ok(plain(item) && plain(item.expected) && (item.language === 'en' || item.language === 'he'));
    const result = item.domain === 'jessica' ? renderJessicaPresentation(item.result, item.language) : renderReminderPresentation(item.result, item.language, zone, now);
    if (item.expected.disposition === 'render_candidate') { assert.equal(result.kind, 'rendered', String(item.id)); if (result.kind === 'rendered') { assert.equal(result.text, item.expected.exactText); assert.deepEqual(result.pendingContext, item.expected.exactPendingContext ?? null); } }
    else { assert.equal(result.kind, 'unsupported', String(item.id)); }
    assert.ok(Object.isFrozen(result)); count++;
  }
  assert.equal(count, 15);
});
test('Jessica status task composes portable domain read, complete facts, cached-source wording and no effects', async () => {
  const f = fixture(), at = f.clock().toISOString(); let reads = 0;
  const reader = createJessicaReader({ registryConfig: f.registry, policyConfig: f.policy, clock: f.clock,
    source: { async readState() { reads++; return { state: { entity_id: 'vacuum.jesica_jesica', state: 'docked', last_updated: at, attributes: { battery: 97, active_segments: null, current_segment: 8 } }, observedAt: at }; }, async readSensors() { return new Map(); } } });
  const result = await executeJessicaStatusTask('status-call', { operation: 'status' }, { identity: f.identity, authority: f.authority, read: reader, clock: f.clock });
  assert.equal(result.facts.verified, true); assert.equal(result.executionMode, 'deterministic'); assert.equal(result.effects.status, 'none');
  assert.equal(reads, 1); assert.ok(result.content?.state === 'usable'); assert.match(result.content.text, /Home Assistant/u); assert.match(result.content.text, /97%/u);
  assert.equal(Object.hasOwn(result, 'runId'), false);
});
test('read awaits cannot disclose after retirement; forged status intent and asynchronous currentness fail closed', async () => {
  const f = fixture(), at = f.clock().toISOString(); let reads = 0;
  const reader = createJessicaReader({ registryConfig: f.registry, policyConfig: f.policy, clock: f.clock, source: {
    async readState() { reads++; f.retire(); return { state: { entity_id: 'vacuum.jesica_jesica', state: 'docked', last_updated: at, attributes: {} }, observedAt: at }; }, async readSensors() { return new Map(); } } });
  await assert.rejects(executeJessicaStatusTask('stale', { operation: 'status' }, { identity: f.identity, authority: f.authority, read: reader, clock: f.clock })); assert.equal(reads, 1);
  const g = fixture();
  await assert.rejects(executeJessicaStatusTask('forged', { operation: 'status', requesterId: 'oren' }, { identity: g.identity, authority: g.authority, read: reader }));
  await assert.rejects(executeJessicaStatusTask('async', { operation: 'status' }, { identity: g.identity, authority: { signal: g.abort.signal, async assertCurrent() {} }, read: reader }), /synchronous/);
});
