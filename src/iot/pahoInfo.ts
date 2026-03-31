import type { AwsCredentials } from './sigv4.js';
import { createPresignedUrl } from './sigv4.js';

export type PahoConnectionInfo = {
  endpoint: string;
  host: string;
  region: string;
  clientId: string;
  presignedUrl: string;
  presignedUrlRedacted: string;
  recommended: { origin?: string };
};

export function buildPahoConnectionInfo(params: {
  endpoint: string;
  region: string;
  credentials: AwsCredentials;
  clientId: string;
  origin?: string;
}): PahoConnectionInfo {
  const { hostname: host } = new URL(params.endpoint);

  const presignedUrl = createPresignedUrl({
    endpoint: params.endpoint,
    region: params.region,
    credentials: params.credentials,
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
