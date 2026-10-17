import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = pathToFileURL(resolve('output/typescript') + '/').href;
const schemas = pathToFileURL(resolve('node_modules/typebox') + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(root) && /\/agents\/(?:jessica-vacuum|reminder-service)\/lib\//u.test(context.parentURL) && !context.parentURL.includes('/adapters/') &&
    specifier.startsWith('node:') && !['node:crypto', 'node:util'].includes(specifier)) throw new Error(`domain_io_import_forbidden:${specifier}`);
  const result = nextResolve(specifier, context);
  if (!result.url.startsWith('node:') && !result.url.startsWith(root) && !result.url.startsWith(schemas)) throw new Error(`domain_native_dependency_forbidden:${specifier}`);
  if (context.parentURL?.includes('/agents/') && !context.parentURL.includes('/adapters/') && result.url.includes('/adapters/')) throw new Error('domain_adapter_import_forbidden');
  return result;
} });
