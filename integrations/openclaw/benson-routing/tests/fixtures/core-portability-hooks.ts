import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = pathToFileURL(resolve(process.cwd()) + '/');
const emitted = new URL('output/typescript/', root).href;
const schema = new URL('node_modules/typebox/', root).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const local = specifier.startsWith('.') || specifier.startsWith('file:') || specifier.startsWith('/');
  if (!local && !specifier.startsWith('node:') && specifier !== 'typebox' && !specifier.startsWith('typebox/')) {
    throw new Error(`portability_dependency_forbidden:${specifier}`);
  }
  const result = nextResolve(specifier, context);
  if (!result.url.startsWith('node:') && !result.url.startsWith(emitted) && !result.url.startsWith(schema)) {
    throw new Error(`portability_native_import_forbidden:${specifier}`);
  }
  return result;
} });
