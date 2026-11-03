import { readFileSync } from 'node:fs';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { createJessicaReader } from '../../../../../agents/jessica-vacuum/lib/read-service.js';
import { createHaReader, createHaTransport } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { currentNativeTurn } from '../../../benson-routing/adapters/openclaw/response.js';
import { loadCanonicalIdentityContract } from '../../benson-reminder-tool/src/identity.js';
import { createJessicaTaskToolFactory } from './tool.js';

export default definePluginEntry({
  id: 'benson-jessica-tool', name: 'Benson Jessica Tool',
  description: 'Jessica deterministic status entry with trusted native Response custody.',
  register(api) {
    if (api.registrationMode !== 'full' && api.registrationMode !== 'tool-discovery') return;
    // Resolve against the selected package while registration owns that root;
    // native loading may later rebind its record to a captured module root.
    const identitiesPath = api.resolvePath('../../../../agents/reminder-service/config/recipients.json');
    const policyPath = api.resolvePath('../../../../agents/jessica-vacuum/config/policy.v1.json');
    const registryPath = api.resolvePath('../../../../agents/jessica-vacuum/config/registry.v1.json');
    // No child scope or sealed completion acquisition is assembled here. Keep
    // the existing optional registrations unavailable rather than granting raw
    // domain access without original-source and completion custody.
    for (const name of ['jessica_read', 'jessica_execute', 'jessica_validate_completion']) {
      api.registerTool({ contextVersion: 2, create() { return null; } }, { name, optional: true });
    }
    api.registerTool({ contextVersion: 2, create(context) {
      if (context.agentId !== 'main') return null;
      // Scoped native discovery needs the same tool schema. Canonical config
      // reads are deferred to construction; HA credentials/IO remain execute-only.
      const identities = loadCanonicalIdentityContract(identitiesPath);
      const policyConfig: unknown = JSON.parse(readFileSync(policyPath, 'utf8'));
      const registryConfig: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
      const roster = { accountId: identities.accountId, approvedIds: identities.trustedRequesterIds,
        subjectForRoute: (route: string) => identities.requesterForPrivateRoute(route) };
      const read = createJessicaReader({ registryConfig, policyConfig, source: createHaReader(createHaTransport()) });
      const tool = createJessicaTaskToolFactory({ roster, policy: loadPolicy(policyConfig), read, resultVersion: 3,
        jsonResult(value, callId, assertCompletion) {
          const turn = currentNativeTurn(api, context);
          turn.record(context, callId, value, () => { turn.assertCurrent(); assertCompletion?.(); });
          return jsonResult(value);
        },
      })(context);
      if (!tool || Array.isArray(tool)) return null;
      return { ...tool, async execute(callId, request, signal, onUpdate) {
        currentNativeTurn(api, context).caller(context, callId);
        return tool.execute(callId, request, signal, onUpdate);
      } };
    } }, { name: 'jessica_task', optional: true });
  },
});
