import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type SigV4FetcherConfig = {
  region: string;
  service: string; // e.g., 'execute-api'
  credentials: AwsCredentials;
  // Sign only when hostname matches any of these; otherwise pass-through to global fetch.
  signHosts: string[];
};

export function createSigv4Fetcher(cfg: SigV4FetcherConfig) {
  const signer = new SignatureV4({
    region: cfg.region,
    service: cfg.service,
    sha256: Sha256,
    credentials: cfg.credentials,
  });

  return async function sigv4Fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : (input as any).url ?? String(input));
    const shouldSign = cfg.signHosts.includes(url.hostname);
    if (!shouldSign) {
      return fetch(input as any, init);
    }

    const method = (init?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    // Merge provided headers into a simple record, excluding any existing Authorization
    if (init?.headers) {
      const h = init.headers as any;
      if (typeof h.forEach === 'function') {
        h.forEach((v: string, k: string) => {
          if (k.toLowerCase() !== 'authorization') headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) if (String(k).toLowerCase() !== 'authorization') headers[String(k)] = String(v);
      } else {
        for (const k of Object.keys(h)) if (k.toLowerCase() !== 'authorization') headers[k] = (h as any)[k];
      }
    }
    headers.host = url.host;

    const body = init?.body as any;
    const httpReq = new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      method,
      path: url.pathname + url.search,
      headers,
      body,
    });

  const signed = await signer.sign(httpReq, { unsignableHeaders: new Set<string>() });

    const signedHeaders = signed.headers as Record<string, string>;

    const fetchInit: RequestInit = {
      ...init,
      method,
      headers: signedHeaders,
    };
    return fetch(url.toString(), fetchInit);
  };
}
