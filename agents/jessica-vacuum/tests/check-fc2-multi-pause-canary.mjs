#!/usr/bin/env node
import { runControlCanaryCli } from './check-fc1-pause-canary.mjs';

await runControlCanaryCli('pause', process.argv[2],
  'check-fc2-multi-pause-canary.mjs', { expectedRoom: ['living_room', 'hallway'], label: 'fc2-multi' });
