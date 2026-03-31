import { createHmac, createHash } from 'crypto';

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/** SHA-256 of empty string. */
export const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

/** RFC-3986 percent-encode (leaves A–Z a–z 0–9 - _ . ~ unencoded). */
export function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * SigV4 presigned MQTT-over-WebSocket URL for AWS IoT.
 * Matches Amplify AWSIoTProvider: session_token unsigned, no X-Amz-Expires, no X-Amz-ClientId.
 */
export function createPresignedUrl(params: {
  endpoint: string;
  region: string;
  credentials: AwsCredentials;
  /** When omitted, X-Amz-Expires is not included in the signed URL (matches Amplify IoT behaviour). */
  expiresIn?: number;
}): string {
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
  const canonicalRequest = ['GET', path, canonicalQuery, `host:${host}\n`, 'host', SHA256_EMPTY].join('\n');
  const stringToSign     = ['AWS4-HMAC-SHA256', datetime, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const signature        = hmac(signingKey(credentials.secretAccessKey, date, params.region, service), stringToSign).toString('hex');

  // Session token appended UNSIGNED after X-Amz-Signature (Amplify pattern for iotdevicegateway)
  const secToken = credentials.sessionToken
    ? `&X-Amz-Security-Token=${encodeURIComponent(credentials.sessionToken)}`
    : '';

  return `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}${secToken}`;
}
