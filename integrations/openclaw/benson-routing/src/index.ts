import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerResponseController } from '../adapters/openclaw/response.js';
import { loadCanonicalIdentityContract } from '../../plugins/benson-reminder-tool/src/identity.js';

export default definePluginEntry({
  id: 'benson-routing', name: 'Benson Routing',
  description: 'Mandatory pre-Main Request admission, original input custody and Response control.',
  register(api) {
    if (api.registrationMode !== 'full') return;
    registerResponseController(api, loadCanonicalIdentityContract(api.resolvePath('../../../agents/reminder-service/config/recipients.json')));
  },
});
