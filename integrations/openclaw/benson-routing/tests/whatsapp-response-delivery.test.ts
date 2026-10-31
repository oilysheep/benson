import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolatedFixture } from './fixtures/native-isolation.js';
import { plain } from '../core/value.js';

test('pinned WhatsApp patch enforces the Controller before native in-memory delivery', { timeout: 180_000 }, () => {
  const result = runIsolatedFixture('whatsapp-response-delivery');
  assert(plain(result)); assert.equal(result.probe, 'PASS'); assert.equal(result.whatsappPlugin, '2026.10.4');
  assert.deepEqual(result.isolation, { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false });
  assert(Array.isArray(result.cases)); assert.equal(result.cases.length, 21);
  const negativeHandoffs = result.cases.filter((item: unknown) => plain(item) && item.injectedHandoffFault === true);
  assert.equal(negativeHandoffs.length, 4);
  for (const item of negativeHandoffs) { assert(plain(item)); assert.equal(item.deliveries, 0); }
  console.log(JSON.stringify(result));
});

test('pinned WhatsApp monitor uses native registration, identity, ingress and delivery lifecycle', { timeout: 180_000 }, () => {
  const result = runIsolatedFixture('whatsapp-response-delivery', false, false, false, false, true);
  assert(plain(result)); assert.equal(result.probe, 'PASS'); assert.equal(result.monitorAssembly, true);
  assert(Array.isArray(result.cases)); assert.equal(result.cases.length, 8);
  assert.equal(result.providerRequests, 6, JSON.stringify(result)); assert.deepEqual(result.fallbackModels, ['correlation', 'secondary']);
  assert.deepEqual(result.isolation, { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false });
  console.log(JSON.stringify(result));
});

test('native npm installation establishes current WhatsApp authority and native disable retires it', { timeout: 300_000 }, () => {
  const result = runIsolatedFixture('whatsapp-response-delivery', false, false, false, false, 'installed');
  assert(plain(result)); assert.equal(result.probe, 'PASS'); assert.equal(result.monitorAssembly, true);
  assert.equal(result.trustedReadOwner, true); assert.equal(result.authorityRetired, true);
  assert(plain(result.nativeInstall)); assert.equal(result.nativeInstall.trustedOfficialInstall, true);
  assert.equal(result.nativeInstall.version, '2026.10.4');
  assert(Array.isArray(result.cases)); assert.equal(result.cases.length, 18);
  assert.equal(result.providerRequests, 8); assert.deepEqual(result.fallbackModels, ['correlation', 'secondary']);
  const business = result.cases.find((item: unknown) => plain(item) && item.name === 'main-domain-read');
  assert(plain(business)); assert(plain(business.business)); assert.equal(business.business.reads, 1);
  assert.equal(business.business.expiredInvocationBlocked, true);
  assert.deepEqual(business.business.terminalOutcomes, ['completed']);
  assert(Array.isArray(business.sends)); assert.equal(business.sends.length, 1);
  assert.equal(business.nativeHandoffReceived, true);
  assert(Array.isArray(result.mainReadCarriers)); assert.equal(result.mainReadCarriers.length, 1);
  assert(plain(result.mainReadCarriers[0]));
  assert.deepEqual(business.business.results, [result.mainReadCarriers[0].value]);
  const directCases = result.cases.filter((item: unknown) => plain(item) && typeof item.name === 'string' && item.name.startsWith('direct-'));
  assert.equal(directCases.length, 9);
  for (const item of directCases) {
    assert(plain(item) && plain(item.direct) && Array.isArray(item.sends));
    assert.equal(item.runId, ''); assert.equal(item.nativeHandoffReceived, true);
    const delivered = item.name === 'direct-read' || item.name === 'direct-read-failure' || item.name === 'direct-duplicate';
    assert.equal(item.sends.length, delivered ? 1 : 0, String(item.name));
    assert.equal(item.direct.reads, item.name === 'direct-denied' || item.name === 'direct-missing-authority' ? 0 : 1);
    if (item.name === 'direct-revoked-read') {
      assert.equal(item.direct.revocationInstalled, true);
      assert.equal(item.direct.rejected, true);
      assert.deepEqual(item.direct.failure, { code: 'NOT_AUTHORIZED', stage: 'authorization' });
    }
    if (delivered) { assert.equal(item.direct.originalResolverCalls, 0); assert.equal(item.direct.readScopeRetired, true);
      const domain = item.direct.result; assert(plain(domain)); assert.equal(domain.schemaVersion, 2); assert.equal(domain.executionMode, 'deterministic');
      assert(plain(domain.outcome)); assert(plain(domain.facts)); assert(plain(domain.effects)); assert.equal(domain.effects.status, 'none');
      assert.equal(domain.outcome.status, item.name === 'direct-read-failure' ? 'failure' : 'success');
      assert.equal(domain.facts.verified, item.name !== 'direct-read-failure'); }
  }
  assert.deepEqual(result.isolation, { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false });
  console.log(JSON.stringify(result));
});
