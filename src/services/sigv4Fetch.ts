import { sha256hex, hmac, signingKey, pct, SHA256_EMPTY, type AwsCredentials } from '../iot/sigv4.js';
export type { AwsCredentials } from '../iot/sigv4.js';

export type SigV4FetcherConfig = {
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Sign requests whose hostname is in this list; others pass through as-is. */
  signHosts: string[];
};

export function createSigv4Fetcher(cfg: SigV4FetcherConfig) {
  return async function sigv4Fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    if (!cfg.signHosts.includes(url.hostname)) return fetch(input as any, init);

    const method = (init?.method ?? 'GET').toUpperCase();
    const now = new Date();
    const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const date = datetime.slice(0, 8);

    // Normalise caller headers to lowercase keys
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as any;
      if (typeof h.forEach === 'function') {
        h.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[(k as string).toLowerCase()] = v as string;
      } else {
        for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
      }
    }
    headers['host'] = url.host;
    headers['x-amz-date'] = datetime;
    if (cfg.credentials.sessionToken) headers['x-amz-security-token'] = cfg.credentials.sessionToken;

    const bodyHash = init?.body != null ? sha256hex(Buffer.from(init.body as string)) : SHA256_EMPTY;

    const canonicalUri   = url.pathname || '/';
    const canonicalQuery = Array.from(url.searchParams.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${pct(k)}=${pct(v)}`)
      .join('&');
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders  = signedHeaderNames.map(k => `${k}:${headers[k].trim()}`).join('\n') + '\n';
    const signedHeaders     = signedHeaderNames.join(';');
    const canonicalRequest  = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, bodyHash].join('\n');

    const credentialScope = `${date}/${cfg.region}/${cfg.service}/aws4_request`;
    const stringToSign    = ['AWS4-HMAC-SHA256', datetime, credentialScope, sha256hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(cfg.credentials.secretAccessKey, date, cfg.region, cfg.service), stringToSign).toString('hex');

    headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${cfg.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers['host'];

    return fetch(url.toString(), { ...init, method, headers });
  };
}
