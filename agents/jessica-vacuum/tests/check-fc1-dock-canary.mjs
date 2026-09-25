import { fileURLToPath } from 'node:url';
import { runControlCanaryCli } from './check-fc1-pause-canary.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runControlCanaryCli('dock', process.argv[2], 'check-fc1-dock-canary.mjs');
}
