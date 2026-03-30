import type { AwsCredentials } from './sigv4.js';
import { createPresignedUrl } from './sigv4.js';

export type PahoConnectionInfo = {
  endpoint: string;
  host: string;
  region: string;
  clientId: string;
  presignedUrl: string;         // SigV4 presigned WSS URL (session token unsigned, per Amplify)
  presignedUrlRedacted: string; // same with sensitive params redacted (safe for logging)
  recommended: { origin?: string };
};

export async function buildPahoConnectionInfo(params: {
  endpoint: string;
  region: string;
  credentials: AwsCredentials;
  clientId: string;
  expiresIn?: number;
  origin?: string;
}): Promise<PahoConnectionInfo> {
  const { hostname: host } = new URL(params.endpoint);

  const presignedUrl = await createPresignedUrl({
    endpoint: params.endpoint,
    region: params.region,
    credentials: params.credentials,
    // X-Amz-Expires omitted — Amplify AWSIoTProvider never passes expiration for IoT
    // X-Amz-ClientId NOT in URL — goes only to Paho constructor
  });

  const presignedUrlRedacted = presignedUrl
    .replace(/(X-Amz-Signature=)[0-9a-f]+/i, '$1<redacted>')
    .replace(/(X-Amz-Security-Token=)[^&]+/i, '$1<redacted>')
    .replace(/(X-Amz-Credential=)[^&]+/i, '$1<redacted>');

  return {
    endpoint: params.endpoint,
    host,
    region: params.region,
    clientId: params.clientId,
    presignedUrl,
    presignedUrlRedacted,
    recommended: { origin: params.origin },
  };
}
