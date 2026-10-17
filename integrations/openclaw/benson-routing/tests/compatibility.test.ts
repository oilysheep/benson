import './fixtures/core-compatibility-hooks.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// Import in-process: every retained node:test case must actually execute.
for (const path of [
  'integrations/openclaw/benson-routing/tests/contracts.test.mjs',
  'integrations/openclaw/benson-routing/tests/completion-v5.test.mjs',
  'integrations/openclaw/benson-routing/tests/completion-control.test.mjs',
  'integrations/openclaw/benson-routing/tests/response-envelope.test.mjs',
  'integrations/openclaw/benson-routing/tests/source-contracts.test.mjs',
  'integrations/openclaw/benson-routing/tests/response-control.test.mjs',
  'shared/benson-datetime.test.mjs',
]) await import(pathToFileURL(resolve(path)).href);
