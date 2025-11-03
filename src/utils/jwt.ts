// Simple JWT payload decoder (no signature verification!)
// Use only for extracting non-sensitive claims client-side.

function base64UrlDecode(input: string): string {
  // Replace URL-safe chars and add padding
  const pad = input.length % 4 === 2 ? '==' : input.length % 4 === 3 ? '=' : input.length % 4 === 1 ? '===' : '';
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

export function decodeJwtPayload<T = any>(jwt: string): T | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const payloadJson = base64UrlDecode(parts[1]);
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}
