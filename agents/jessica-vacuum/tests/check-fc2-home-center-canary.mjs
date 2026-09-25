#!/usr/bin/env node
import { runRoomCanary } from './check-stage6-canary.mjs';

const CANARY = {
  id: 'fc2-single-home-center-20260923',
  room: 'home_center',
  subject: 'oren',
};

runRoomCanary({
  canary: CANARY,
  label: 'fc2-home-center',
  mode: process.argv[2],
  requireLiveAfter: true,
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-home-center-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
