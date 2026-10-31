import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolatedFixture } from './fixtures/native-isolation.js';
import { plain } from '../core/value.js';

test('isolated Main hook surface does not expose the original dispatcher delivery gate', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('main-interception', false, false, true);
  assert(plain(raw));
  assert.equal(raw.probe, 'PASS'); assert.equal(raw.G3, 'BLOCKED');
  assert.equal(raw.mainHookSurfaceOnly, true);
  assert.equal(raw.originalAppendBeforeDeliver, true); assert.equal(raw.hookAppendBeforeDeliver, false);
  assert.equal(raw.hookCalls, 1); assert.equal(raw.resolverCalls, 0); assert.equal(raw.runStarts, 0);
  assert.equal(raw.providerRequests, 0); assert.equal(raw.sinkCalls, 0);
  assert.deepEqual(raw.isolation, { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false });
  console.log(JSON.stringify(raw));
});

function assertRetiredReadInvocations(raw: Record<string, unknown>) {
  assert(Array.isArray(raw.readAdmissionCases));
  for (const item of raw.readAdmissionCases) {
    assert(item && typeof item === 'object' && Array.isArray(item.values) && Array.isArray(item.retiredInvocations));
    assert.equal(item.retiredInvocations.length, item.values.length);
    assert('currentRequestContext' in item);
    assert.deepEqual(item.currentRequestContext, { count: item.values.length, scope: 'current-request-only',
      history: 'not_acquired', revalidatedBeforeReturn: true, retiredProjectionRejected: true });
    for (const invocation of item.retiredInvocations) {
      assert.equal(invocation.guardRejected, true);
      assert.equal(invocation.replayRejected, true);
    }
  }
}

function assertReadFailureCoverage(raw: Record<string, unknown>) {
  assert(Array.isArray(raw.readAdmissionCases));
  const cases: unknown[] = raw.readAdmissionCases;
  for (const profile of ['jessica-failure', 'reminder-failure', 'qualified']) {
    const item = cases.find(value => plain(value) && value.profile === profile);
    assert(plain(item) && Array.isArray(item.values) && Array.isArray(item.sink) && plain(item.delivery));
    assert.equal(item.values.length, 2);
    assert.deepEqual(item.values.map((value: unknown) => { assert(plain(value) && plain(value.outcome)); return value.outcome.status; }),
      profile === 'jessica-failure' ? ['failure', 'success'] : profile === 'reminder-failure' ? ['success', 'failure'] : ['success', 'success']);
    assert.equal(item.sink.length, profile === 'qualified' ? 0 : 1);
    assert.equal(item.delivery.outcome, profile === 'qualified' ? 'blocked' : 'delivered');
  }
}

test('isolated Main probe distinguishes native generation from blocked universal interception', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('main-interception');
  assert(raw && typeof raw === 'object' && 'probe' in raw && 'G3' in raw);
  assert.equal(raw.probe, 'PASS');
  assert.equal(raw.G3, 'BLOCKED');
  assert('providerScenarios' in raw && Array.isArray(raw.providerScenarios));
  for (const scenario of ['provider-error', 'native-timeout', 'partial-abort', 'native-fallback']) {
    assert(raw.providerScenarios.includes(scenario), `Native provider path not reached: ${scenario}`);
  }
  assert('fallbackModels' in raw && Array.isArray(raw.fallbackModels));
  assert(raw.fallbackModels.indexOf('correlation') >= 0);
  assert(raw.fallbackModels.indexOf('secondary') > raw.fallbackModels.indexOf('correlation'));
  assertRetiredReadInvocations(raw);
  assertReadFailureCoverage(raw);
  console.log(JSON.stringify(raw));
});

test('isolated native Code Mode preserves full domain values and enforces final authorization', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('main-interception', true);
  assert(raw && typeof raw === 'object' && 'probe' in raw && 'G3' in raw && 'codeModeOnly' in raw);
  assert.equal(raw.probe, 'PASS'); assert.equal(raw.G3, 'BLOCKED'); assert.equal(raw.codeModeOnly, true);
  assert('readAdmissionCases' in raw && Array.isArray(raw.readAdmissionCases)); assert.equal(raw.readAdmissionCases.length, 5);
  for (const item of raw.readAdmissionCases) {
    assert(item && typeof item === 'object' && 'codeMode' in item && item.codeMode === true);
  }
  assertRetiredReadInvocations(raw);
  assertReadFailureCoverage(raw);
  console.log(JSON.stringify(raw));
});

test('supported native resolver preserves admission, Controller gating and native delivery custody', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('main-interception', false, false, false, true);
  assert(plain(raw)); assert.equal(raw.probe, 'PASS'); assert.equal(raw.G3, 'BLOCKED');
  assert.equal(raw.supportedNativeOnly, true);
  assert.deepEqual(raw.isolation, { externalInterfaces: 0, externalRoutes: 0, hostHomeVisible: false });
  assertRetiredReadInvocations(raw);
  assert(Array.isArray(raw.readAdmissionCases)); assert.equal(raw.readAdmissionCases.length, 7);
  assert(Array.isArray(raw.supportedTerminalCases)); assert.equal(raw.supportedTerminalCases.length, 13);
  assert(Array.isArray(raw.fallbackModels));
  assert(raw.fallbackModels.indexOf('secondary') > raw.fallbackModels.indexOf('correlation'));
  console.log(JSON.stringify(raw));
});
