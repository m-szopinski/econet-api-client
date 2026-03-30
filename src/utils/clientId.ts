import { v4 as uuidv4 } from 'uuid';

/**
 * Generuje clientId w formacie zgodnym z main.e2b05146.js:
 *   <identityId>-<timestamp>   (when identityId provided)
 *   <region>:<uuidv4>-<timestamp>  (fallback when no identityId)
 *
 * Przykład:
 *   eu-central-1:8056ee7d-3465-cd5c-8c0b-adbd2bb00b97-1761385132771
 */
export function generateClientId(region: string = "eu-central-1", identityId?: string): string {
  const timestamp = Date.now();
  if (identityId) {
    return `${identityId}-${timestamp}`;
  }
  return `${region}:${uuidv4()}-${timestamp}`;
}
