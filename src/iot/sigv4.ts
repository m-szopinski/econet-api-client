import { Sha256 } from '@aws-crypto/sha256-js';

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

// SHA-256 of empty string (required payload hash for iotdevicegateway presigning)
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function sha256hex(data: string): Promise<string> {
  const h = new Sha256();
  h.update(data);
  return Buffer.from(await h.digest()).toString('hex');
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const h = new Sha256(key);
  h.update(data);
  return h.digest();
}

async function signingKey(secret: string, date: string, region: string, service: string): Promise<Uint8Array> {
  const kDate    = await hmac('AWS4' + secret, date);
  const kRegion  = await hmac(kDate,           region);
  const kService = await hmac(kRegion,         service);
  return           hmac(kService,        'aws4_request');
}

/** RFC-3986 percent-encode (leaves A–Z a–z 0–9 - _ . ~ unencoded). */
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build a SigV4 presigned MQTT-over-WebSocket URL for AWS IoT.
 *
 * Follows the exact Amplify PubSub / AWSIoTProvider signing logic from
 * main.e2b05146.js:
 *
 *   aa.signUrl(endpoint, {access_key, secret_key, session_token}, {service, region})
 *
 *   ca = (e) => e !== "iotdevicegateway"   // false for IoT
 *
 *   - session_token is NOT included in the signed credentials for iotdevicegateway
 *     → therefore NOT part of the canonical query string / signature
 *   - session_token IS appended AFTER X-Amz-Signature as an unsigned parameter
 *     (because: t.session_token && !ca("iotdevicegateway") → true)
 *   - X-Amz-Expires is NOT added (no expiration arg is passed for IoT calls)
 *   - X-Amz-ClientId is NEVER in the URL — it goes only to the Paho constructor
 */
export async function createPresignedUrl(params: {
  endpoint: string;   // wss://<host>/mqtt
  region: string;
  credentials: AwsCredentials;
  /** When omitted, X-Amz-Expires is not included in the signed URL (matches Amplify IoT behaviour). */
  expiresIn?: number;
}): Promise<string> {
  const { credentials } = params;
  const service = 'iotdevicegateway';

  const { hostname: host, pathname: path } = new URL(params.endpoint);

  const now      = new Date();
  const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const date     = datetime.slice(0, 8);

  const credentialScope = `${date}/${params.region}/${service}/aws4_request`;

  // Signed query params — session token and X-Amz-Expires intentionally excluded
  // (matches Amplify signUrl behaviour for iotdevicegateway)
  const qp: [string, string][] = [
    ['X-Amz-Algorithm',    'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential',   `${credentials.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date',         datetime],
    ...(params.expiresIn !== undefined ? [['X-Amz-Expires', String(params.expiresIn)] as [string, string]] : []),
    ['X-Amz-SignedHeaders', 'host'],
  ];
  qp.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalQuery   = qp.map(([k, v]) => `${pct(k)}=${pct(v)}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['GET', path, canonicalQuery, canonicalHeaders, 'host', SHA256_EMPTY].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    await sha256hex(canonicalRequest),
  ].join('\n');

  const key       = await signingKey(credentials.secretAccessKey, date, params.region, service);
  const signature = Buffer.from(await hmac(key, stringToSign)).toString('hex');

  // Session token appended UNSIGNED after X-Amz-Signature (Amplify pattern for iotdevicegateway)
  const secToken = credentials.sessionToken
    ? `&X-Amz-Security-Token=${encodeURIComponent(credentials.sessionToken)}`
    : '';

  return `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}${secToken}`;
}
