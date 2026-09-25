#!/usr/bin/env node
import { runRoomCanary } from './check-stage6-canary.mjs';

const CANARY = {
  id: 'fc2-single-living-room-20260923',
  room: 'living_room',
  subject: 'oren',
};

runRoomCanary({
  canary: CANARY,
  label: 'fc2-living-room',
  mode: process.argv[2],
  requireLiveAfter: true,
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-living-room-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
