#!/usr/bin/env node
import { runControlCanaryCli } from './check-fc1-pause-canary.mjs';

await runControlCanaryCli('pause', process.argv[2],
  'check-fc2-hallway-pause-canary.mjs', { expectedRoom: 'hallway', label: 'fc2-hallway' });
