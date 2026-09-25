import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPluginStateSyncKeyedStore } from '/home/oa/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/plugin-state-store-runtime.js';
import { createJessicaExecutor } from '../dist/executor.js';
import { JESSICA_STATE_OPTIONS } from '../dist/operation-state.js';
import { createSocketDriver } from './fake-ha.mjs';

const [socketPath, stateRoot, epoch, mode = 'normal', requestJson] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const registry = JSON.parse(readFileSync(join(root, 'agents/jessica-vacuum/config/registry.v1.json'), 'utf8'));
delete registry.underTest;
delete registry.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings;
const policy = JSON.parse(readFileSync(join(root, 'agents/jessica-vacuum/config/policy.v1.json'), 'utf8'));
const cleanCapability = registry.capabilities.find((cap) => cap.name === 'clean_single_room');
if (!cleanCapability.verifiedRooms.some((item) => item.room === 'living_room')) {
  cleanCapability.verifiedRooms.push({
    room: 'living_room', observedAt: '2026-09-19T11:36:20Z', provenance: 'Deterministic test fixture',
  });
}
registry.capabilities.find((cap) => cap.name === 'clean_settings').support = 'verified';
const store = createPluginStateSyncKeyedStore('benson-jessica-tool', {
  ...JESSICA_STATE_OPTIONS, env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot },
});
const crash = () => process.exit(71);
const hooks = {
  ...(mode === 'crash-before' ? { afterIntent: crash } : {}),
  ...(mode === 'crash-after-marker' ? { afterDispatchMarker: crash } : {}),
  ...(mode === 'crash-after-post' ? { afterPost: crash } : {}),
  ...(mode === 'crash-after-ack' ? { afterAcceptedState: crash } : {}),
};
const engine = createJessicaExecutor({ registryConfig: registry, policyConfig: policy, store,
  driver: createSocketDriver(socketPath), wait: () => Promise.resolve(), pollCounts: { clean: 3, setting: 2 }, hooks });
const request = requestJson ? JSON.parse(requestJson) : { operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } };
const context = { identity: { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true },
  requestEpoch: epoch };
const result = await engine.execute(request, context);
process.stdout.write(JSON.stringify({ status: result.status, code: result.error?.code ?? null,
  outcome: result.data?.outcome ?? null, operationId: result.data?.operationId ?? null }) + '\n');
