#!/usr/bin/env node
import { runRoomCanary } from './check-stage6-canary.mjs';

const CANARY = {
  id: 'fc2-single-kitchen-sitting-20260924',
  room: 'kitchen_sitting_area',
  subject: 'oren',
};

runRoomCanary({
  canary: CANARY,
  label: 'fc2-kitchen-sitting',
  mode: process.argv[2],
  requireLiveAfter: true,
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-kitchen-sitting-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
