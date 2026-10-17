import { readFileSync } from 'node:fs';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
/** Configuration I/O stays in the integration; it introduces no second roster. */
export function loadCanonicalIdentityContract() {
  const raw: unknown = JSON.parse(readFileSync(new URL('../../../../../agents/reminder-service/config/recipients.json', import.meta.url), 'utf8'));
  return loadIdentityContract(raw);
}
