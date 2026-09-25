#!/usr/bin/env node
import { runHomeCanary } from './check-stage6-canary.mjs';

runHomeCanary({ mode: process.argv[2] }).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(JSON.stringify({
    check: 'fc2-home-canary',
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'Unknown error',
  }));
  process.exitCode = 1;
});
