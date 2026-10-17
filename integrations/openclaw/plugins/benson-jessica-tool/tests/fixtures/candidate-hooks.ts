import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// Test-only composition of unchanged payload fixtures with emitted candidates.
const root = pathToFileURL(resolve(process.cwd()) + '/');
const names = ['errors', 'immutable', 'schemas', 'policy', 'registry', 'domain-core', 'results'];
const replacements = new Map(names.map(name => [new URL(`agents/jessica-vacuum/lib/${name}.mjs`, root).href,
  new URL(`output/typescript/agents/jessica-vacuum/lib/${name}.js`, root).href]));
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  return { ...result, url: replacements.get(result.url) ?? result.url };
} });
