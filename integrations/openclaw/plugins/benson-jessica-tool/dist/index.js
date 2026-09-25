import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult } from 'openclaw/plugin-sdk/tool-results';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';
import { createPluginStateSyncKeyedStore } from 'openclaw/plugin-sdk/plugin-state-store-runtime';
import { createJessicaReadToolFactory } from './tool.js';
import { createJessicaExecuteToolFactory } from './execute-tool.js';
import { createJessicaCompletionToolFactory, createNativeTranscriptReader } from './completion.js';
import { JESSICA_STATE_OPTIONS } from './operation-state.js';

export default definePluginEntry({
  id: 'benson-jessica-tool',
  name: 'Benson Jessica Tool',
  description: 'Jessica read tool, scoped room execution, and native-completion integrity validator.',
  register(api) {
    api.registerTool(createJessicaReadToolFactory({ jsonResult,
      createStore: () => createPluginStateSyncKeyedStore('benson-jessica-tool', JESSICA_STATE_OPTIONS) }),
      { name: 'jessica_read', optional: true });
    api.registerTool(createJessicaExecuteToolFactory({ jsonResult,
      createStore: () => createPluginStateSyncKeyedStore('benson-jessica-tool', JESSICA_STATE_OPTIONS) }),
      { name: 'jessica_execute', optional: true });
    api.registerTool(createJessicaCompletionToolFactory({ jsonResult, tasks: api.runtime.tasks, logger: api.logger,
      readMessages: createNativeTranscriptReader({ getSessionEntry,
        readVisibleMessages: readVisibleSessionTranscriptMessageEntries }) }),
      { name: 'jessica_validate_completion', optional: true });
  },
});
