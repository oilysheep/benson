import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Reuse unchanged, accepted JS payload fixtures against emitted candidate owners.
// This hook runs only in the test process; it is never runtime composition.
const root = pathToFileURL(resolve(process.cwd()) + '/');
const routing = new URL('integrations/openclaw/benson-routing/', root);
const candidate = new URL('output/typescript/integrations/openclaw/benson-routing/', root);
const replacements = new Map([
  [new URL('envelope.mjs', routing).href, new URL('core/envelope.js', candidate).href],
  [new URL('request-control.mjs', routing).href, new URL('core/request-control.js', candidate).href],
  [new URL('completion-control.mjs', routing).href, new URL('core/completion-control.js', candidate).href],
  [new URL('response-control.mjs', routing).href, new URL('tests/fixtures/response-composition.js', candidate).href],
  [new URL('shared/benson-datetime.mjs', root).href, new URL('output/typescript/shared/benson-datetime.js', root).href],
]);
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  return { ...result, url: replacements.get(result.url) ?? result.url };
} });
