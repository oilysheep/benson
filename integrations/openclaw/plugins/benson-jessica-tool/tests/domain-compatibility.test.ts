import './fixtures/candidate-hooks.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const fixture: string = pathToFileURL(resolve('agents/jessica-vacuum/tests/domain-core.test.mjs')).href;
await import(fixture);
