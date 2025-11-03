import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Hash } from '@aws-sdk/hash-node';

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export async function createPresignedUrl(params: {
  endpoint: string; // wss://<endpoint>/mqtt
  region: string;
  credentials: AwsCredentials;
  clientId?: string; // optional: X-Amz-ClientId
  expiresIn?: number; // seconds, default 900 (15min)
}): Promise<string> {
  const { endpoint, region, credentials, clientId } = params;
  const expiresIn = params.expiresIn ?? 900;
  const service = 'iotdevicegateway';

  const url = new URL(endpoint);
  const host = url.host;
  const path = '/mqtt';

  const signer = new SignatureV4({
    credentials,
    region,
    service,
    sha256: Hash.bind(null, 'sha256') as any,
    uriEscapePath: true,
  });

  // Build a request object compatible with signer
  const request = {
    method: 'GET',
    protocol: 'wss:',
    hostname: host,
    path,
    headers: { host },
    query: {
      'X-Amz-Expires': String(expiresIn),
      ...(clientId ? { 'X-Amz-ClientId': clientId } : {}),
    } as Record<string, string>,
  } as any;

  // The signer will add X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date,
  // X-Amz-SignedHeaders, and X-Amz-Security-Token when credentials include it.
  const signed = await signer.presign(request);
  const q = new URLSearchParams((signed as any).query || {}).toString();
  return `wss://${host}${path}?${q}`;
}
