import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolatedFixture } from './fixtures/native-isolation.js';
import { plain } from '../core/value.js';
import { validateDomainResultEnvelope } from '../core/domain-result.js';

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
  // Preserve completed native evidence even if a host-side assertion fails.
  console.log(JSON.stringify(result));
  assert(plain(result)); assert.equal(result.probe, 'PASS'); assert.equal(result.monitorAssembly, true);
  assert.equal(result.trustedReadOwner, true); assert.equal(result.authorityRetired, true);
  assert(plain(result.nativeInstall)); assert.equal(result.nativeInstall.trustedOfficialInstall, true);
  assert.equal(result.nativeInstall.version, '2026.10.4');
  assert(Array.isArray(result.cases)); assert.equal(result.cases.length, 25);
  assert.equal(result.providerRequests, 30); assert.deepEqual(result.fallbackModels, ['correlation', 'secondary']);
  const business = result.cases.find((item: unknown) => plain(item) && item.name === 'main-domain-read');
  assert(plain(business)); assert(plain(business.business)); assert.equal(business.business.reads, 1);
  assert.equal(business.business.expiredInvocationBlocked, true);
  assert.deepEqual(business.business.terminalOutcomes, ['completed']);
  assert(Array.isArray(business.sends)); assert.equal(business.sends.length, 1);
  assert.equal(business.nativeHandoffReceived, true);
  assert(Array.isArray(result.mainReadCarriers)); assert.equal(result.mainReadCarriers.length, 6);
  assert(plain(result.mainReadCarriers[0]));
  assert.deepEqual(business.business.results, [result.mainReadCarriers[0].value]);
  assert(plain(business.business.requestDecision));
  const decision = business.business.requestDecision;
  assert.equal(decision.requestId, 'native-monitor-main-domain-read'); assert.equal(decision.calls, 1);
  assert(plain(decision.classification)); assert.equal(decision.classification.kind, 'unavailable');
  assert(plain(decision.nativeDecision)); assert.equal(decision.nativeDecision.status, 'unavailable');
  assert(['disabled', 'not-configured'].includes(String(decision.nativeDecision.reason)));
  assert(plain(decision.routing)); assert.equal(decision.routing.route, 'main');
  assert.equal(decision.routing.reason, 'classifier_unavailable'); assert.equal(decision.routing.eligible, false);
  assert(Array.isArray(business.phases));
  assert(business.phases.indexOf('decision-settled') < business.phases.indexOf('main-started'));
  const agentic = result.cases.find((item: unknown) => plain(item) && item.name === 'main-domain-agentic');
  assert(plain(agentic) && plain(agentic.business) && plain(agentic.business.completion));
  const completion = agentic.business.completion;
  assert(plain(completion.binding) && plain(completion.binding.caller));
  assert.equal(completion.binding.inputId, 'native-monitor-main-domain-agentic');
  assert.equal(completion.binding.caller.runId, agentic.runId);
  assert.equal(completion.binding.agentId, 'jessica-vacuum');
  assert.notEqual(completion.binding.runId, agentic.runId);
  assert.equal(completion.backendReads, 1); assert.equal(completion.negativeEvidenceCases, 4);
  assert.equal(agentic.business.expiredInvocationBlocked, true);
  assert.deepEqual(agentic.business.terminalOutcomes, ['completed']);
  assert(Array.isArray(agentic.sends)); assert.equal(agentic.sends.length, 1);
  assert(Array.isArray(agentic.business.results)); assert.equal(agentic.business.results.length, 1);
  assert(plain(agentic.business.results[0])); assert.equal(agentic.business.results[0].schemaVersion, 3); assert.equal(agentic.business.responseSchemaVersion, 4); assert.equal(agentic.business.results[0].executionMode, 'agentic');
  assert(plain(result.mainReadCarriers[1])); assert.deepEqual(agentic.business.results, [result.mainReadCarriers[1].value]);
  const reminder = result.cases.find((item: unknown) => plain(item) && item.name === 'main-reminder-read');
  assert(plain(reminder) && plain(reminder.business)); assert.equal(reminder.business.reads, 1);
  assert.equal(reminder.business.expiredInvocationBlocked, true);
  assert.deepEqual(reminder.business.terminalOutcomes, ['completed']);
  assert(Array.isArray(reminder.sends)); assert.equal(reminder.sends.length, 1);
  assert(plain(result.mainReadCarriers[2]));
  assert.deepEqual(reminder.business.results, [result.mainReadCarriers[2].value]);
  const reminderResult = validateDomainResultEnvelope(result.mainReadCarriers[2].value);
  assert.equal(reminderResult.domain, 'reminder'); assert.equal(reminderResult.executionMode, 'deterministic');
  assert(plain(reminderResult.facts) && plain(reminderResult.facts.data));
  assert(Array.isArray(reminderResult.facts.data.matches)); assert.equal(reminderResult.facts.data.matches.length, 3);
  assert(plain(reminder.sends[0])); for (const index of [1, 2, 3]) assert(String(reminder.sends[0].text).includes(`Native reminder ${index}`));
  const created = result.cases.find((item: unknown) => plain(item) && item.name === 'main-reminder-create');
  assert(plain(created) && plain(created.business) && plain(created.business.completion));
  assert.equal(created.business.reads, 1); assert.equal(created.business.expiredInvocationBlocked, true);
  assert(Array.isArray(created.sends)); assert.equal(created.sends.length, 1); assert(plain(created.sends[0])); assert(String(created.sends[0].text).includes('drink water'));
  assert(plain(result.mainReadCarriers[3])); assert.deepEqual(created.business.results, [result.mainReadCarriers[3].value]);
  const createResult = validateDomainResultEnvelope(result.mainReadCarriers[3].value); assert.equal(createResult.domain, 'reminder');
  assert.equal(createResult.schemaVersion, 3); assert.equal(created.business.responseSchemaVersion, 4); assert.equal(createResult.operation, 'create'); assert.equal(createResult.executionMode, 'agentic'); assert.equal(createResult.effects.status, 'known');
  assert.deepEqual(createResult.effects.refs, ['isolated-created']);
  const createCompletion = created.business.completion; assert(plain(createCompletion.binding) && plain(createCompletion.binding.caller));
  assert.equal(createCompletion.binding.inputId, 'native-monitor-main-reminder-create');
  assert.equal(createCompletion.binding.caller.runId, created.runId); assert.notEqual(createCompletion.binding.runId, created.runId);
  assert.equal(createCompletion.binding.agentId, 'reminder-service'); assert.equal(createCompletion.binding.completionTarget, 'CALLER');
  for (const [name, index, operation, domain] of [
    ['main-jessica-mutation', 4, 'clean', 'jessica-vacuum'], ['main-reminder-delete', 5, 'delete', 'reminder'],
  ] as const) {
    const item: unknown = result.cases.find((entry: unknown) => plain(entry) && entry.name === name);
    assert(plain(item) && plain(item.business) && plain(item.business.completion) && Array.isArray(item.sends));
    assert.equal(item.business.reads, 1); assert.equal(item.sends.length, 1); assert.equal(item.business.expiredInvocationBlocked, true);
    assert.deepEqual(item.business.terminalOutcomes, ['completed']);
    const carrier: unknown = result.mainReadCarriers[index]; assert(plain(carrier));
    const value = validateDomainResultEnvelope(carrier.value); assert.equal(value.domain, domain); assert.equal(value.operation, operation);
    assert.equal(item.business.responseSchemaVersion, 4); assert.equal(value.schemaVersion, 3); assert.equal(value.executionMode, 'agentic'); assert.equal(value.facts.verified, true); assert.equal(value.effects.status, 'known');
    assert.deepEqual(item.business.results, [carrier.value]);
    if (name === 'main-reminder-delete') {
      assert.equal(value.outcome.status, 'success');
      assert(plain(value.facts.data));
      assert(plain(value.facts.data.data));
      assert.deepEqual(value.facts.data.data.padding, ['א'.repeat(10000), 'x'.repeat(10000)]);
    }
    assert(plain(item.business.completion.binding) && plain(item.business.completion.binding.caller));
    assert.equal(item.business.completion.binding.inputId, `native-monitor-${name}`);
    assert.equal(item.business.completion.binding.caller.runId, item.runId);
    assert.equal(item.business.completion.binding.completionTarget, 'CALLER');
    assert(plain(item.sends[0])); assert(String(item.sends[0].text).includes(operation === 'clean' ? 'הניקוי' : 'נמחקה'));
  }
  const agenticDirectCases = result.cases.filter((item: unknown) => plain(item) && typeof item.name === 'string' && item.name.startsWith('direct-agentic-'));
  assert.equal(agenticDirectCases.length, 2);
  for (const item of agenticDirectCases) {
    assert(plain(item) && plain(item.direct) && Array.isArray(item.sends));
    assert.equal(item.runId, ''); assert.equal(item.nativeHandoffReceived, true);
    assert.equal(item.sends.length, item.name === 'direct-agentic-read' ? 1 : 0);
    assert.equal(item.direct.originalResolverCalls, 0); assert.equal(item.direct.runScopeRetired, true); assert.equal(item.direct.responseSchemaVersion, 4);
    assert(plain(item.direct.admission)); assert.equal(item.direct.admission.schemaVersion, 4);
    assert(plain(item.direct.completion) && plain(item.direct.completion.binding));
    assert.equal(item.direct.completion.backendReads, 1); assert.equal(item.direct.completion.negativeEvidenceCases, 4);
    assert.equal(item.direct.completion.binding.caller, null);
    assert.equal(item.direct.completion.binding.completionTarget, 'RESPONSE_CONTROLLER');
    assert.equal(item.direct.completion.binding.inputId, `native-monitor-${item.name}`);
    assert.equal(item.direct.completion.binding.admissionId, item.direct.admission.requestId);
    assert.equal(validateDomainResultEnvelope(item.direct.result).executionMode, 'agentic');
    assert.equal(validateDomainResultEnvelope(item.direct.result).effects.status, 'none');
    if (item.name === 'direct-agentic-cancel') assert.equal(item.direct.rejected, true);
  }
  const directCases = result.cases.filter((item: unknown) => plain(item) && typeof item.name === 'string' && item.name.startsWith('direct-') && !item.name.startsWith('direct-agentic-'));
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
});
