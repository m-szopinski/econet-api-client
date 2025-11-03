import type { AwsCredentials } from './sigv4.js';
import { createPresignedUrl } from './sigv4.js';

export type PahoConnectionInfo = {
  endpoint: string; // original endpoint e.g. wss://<host>/mqtt
  host: string; // <host>
  region: string;
  clientId: string;
  expiresIn: number;
  presignedUrl: string; // full URL including signature
  presignedUrlRedacted: string; // for logging (signature/security token redacted)
  recommended: {
    origin?: string; // e.g., 'https://econetcloud.eu'
  };
};

export async function buildPahoConnectionInfo(params: {
  endpoint: string;
  region: string;
  credentials: AwsCredentials;
  clientId: string;
  expiresIn?: number; // default 900
  origin?: string;
}): Promise<PahoConnectionInfo> {
  const { endpoint, region, credentials, clientId } = params;
  const expiresIn = params.expiresIn ?? 900;
  const origin = params.origin;
  const host = new URL(endpoint).host;

  const presignedUrl = await createPresignedUrl({ endpoint, region, credentials, clientId, expiresIn });
  const presignedUrlRedacted = presignedUrl
    .replace(/(X-Amz-Signature=)[0-9a-f]+/i, '$1<redacted>')
    .replace(/(X-Amz-Security-Token=)[^&]+/i, '$1<redacted>')
    .replace(/(X-Amz-Credential=)[^&]+/i, '$1<redacted>');

  return {
    endpoint,
    host,
    region,
    clientId,
    expiresIn,
    presignedUrl,
    presignedUrlRedacted,
    recommended: { origin },
  };
}
