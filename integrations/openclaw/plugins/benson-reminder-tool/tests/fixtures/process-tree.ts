import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Isolated stand-in for the retained Python wrapper -> core subprocess chain.
if (process.argv[2] === 'leaf') {
  process.on('SIGTERM', () => {});
  if (!process.send) throw new Error('Fixture leaf requires readiness IPC');
  process.send({ pid: process.pid }, () => process.disconnect());
  setInterval(() => {}, 1_000);
  setTimeout(() => process.exit(2), 15_000);
} else {
  process.on('SIGTERM', () => process.exit(0));
  process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], {
    stdio: ['ignore', process.argv[2] === 'ignore' ? 'ignore' : 'inherit', process.argv[2] === 'ignore' ? 'ignore' : 'inherit', 'ipc'] });
  child.on('message', (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n'));
  child.on('error', () => process.exit(2)); child.on('close', code => process.exit(code ?? 2));
}
