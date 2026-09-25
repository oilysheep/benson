#!/usr/bin/env node
import { runRoomCanary } from './check-stage6-canary.mjs';

const CANARY = {
  id: 'fc2-single-kitchen-20260924',
  room: 'kitchen',
  subject: 'oren',
};

runRoomCanary({
  canary: CANARY,
  label: 'fc2-kitchen',
  mode: process.argv[2],
  requireLiveAfter: true,
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-kitchen-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
