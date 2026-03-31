import { randomUUID } from 'crypto';

/**
 * Generates a clientId matching the format from main.e2b05146.js:
 *   <identityId>-<timestamp>      (when identityId is available)
 *   <region>:<uuidv4>-<timestamp> (fallback)
 */
export function generateClientId(region = 'eu-central-1', identityId?: string): string {
  const ts = Date.now();
  return identityId ? `${identityId}-${ts}` : `${region}:${randomUUID()}-${ts}`;
}
