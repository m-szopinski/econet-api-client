import { v4 as uuidv4 } from 'uuid';

// Generate a clientId like: <region>:<uuid-v4>-<timestamp-ms>
/**
 * Generuje clientId w formacie:
 *   <region>:<pseudo-uuid>-<timestamp>
 * zgodnie z implementacją w main.ae48acfa.js
 */

export function generateClientId(region: string = "eu-central-1"): string {
  const timestamp = Date.now();
  return `${region}:8056ee7d-3465-cd5c-8c0b-adbd2bb00b97-${timestamp}`;
}


/**
 * Generuje clientId w tym samym formacie, co w pliku main.ae48acfa.js:
 *   <region>:<uuidv4>-<timestamp>
 *
 * Przykład:
 *   eu-central-1:8056ee7d-3465-cd5c-8c0b-adbd2bb00b97-1761385132771
 */
