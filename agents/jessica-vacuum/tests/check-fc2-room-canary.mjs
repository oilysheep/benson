#!/usr/bin/env node
import { runRoomCanary } from './check-stage6-canary.mjs';

const CANARY = {
  id: 'fc2-single-hallway-20260923',
  room: 'hallway',
  subject: 'oren',
};

runRoomCanary({
  canary: CANARY,
  label: 'fc2-room',
  mode: process.argv[2],
  requireLiveAfter: true,
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-room-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
