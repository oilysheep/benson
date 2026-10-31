import assert from 'node:assert/strict';
import test from 'node:test';
import { runIsolatedFixture } from './fixtures/native-isolation.js';

// The fixture has no host home, writable repository, external interface or route.
// Do not fall back to running the worker outside this namespace.
test('isolated native correlation maps host calls without manufacturing Completion authority', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('native-correlation');
  assert(raw && typeof raw === 'object' && 'mapping' in raw && 'completion' in raw);
  assert.equal(raw.mapping, 'PASS');
  assert.equal(raw.completion, 'BLOCKED');
  console.log(JSON.stringify(raw));
});

test('isolated Completion v6 retains original Main source custody through a real Domain Run', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('native-correlation', false, true);
  assert(raw && typeof raw === 'object' && 'completion' in raw && 'G3' in raw);
  assert.equal(raw.completion, 'PASS'); assert.equal(raw.G3, 'BLOCKED');
  console.log(JSON.stringify(raw));
});

test('isolated Completion v6 blocks source cancellation across await before any domain read or Completion', { timeout: 180_000 }, () => {
  const raw = runIsolatedFixture('native-correlation', false, 'cancel');
  assert(raw && typeof raw === 'object' && 'completion' in raw && 'backendReads' in raw && 'sink' in raw);
  assert.equal(raw.completion, 'PASS'); assert.equal(raw.backendReads, 0); assert.deepEqual(raw.sink, []);
  console.log(JSON.stringify(raw));
});
