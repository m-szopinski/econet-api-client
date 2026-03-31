export type IdentityParams = {
  idToken: string;
  identityPoolId: string;
  userPoolId: string;
  region: string;
  customRoleArn?: string | null;
};

export type IdentityResult = {
  identityId: string;
  credentials: {
    AccessKeyId: string;
    SecretKey: string;
    SessionToken: string;
    Expiration: Date;
  };
};

// Correct target prefix per the botocore service definition (targetPrefix: AWSCognitoIdentityService)
async function callCognitoIdentity<T>(region: string, target: string, body: unknown): Promise<T> {
  const resp = await fetch(`https://cognito-identity.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityService.${target}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail: string;
    try {
      const err: any = await resp.json();
      detail = err?.message ?? err?.Message ?? err?.['__type'] ?? JSON.stringify(err);
    } catch {
      detail = await resp.text().catch(() => resp.statusText);
    }
    throw new Error(`Cognito Identity ${target} failed (${resp.status}): ${detail}`);
  }
  return resp.json() as Promise<T>;
}

export async function getCognitoIdentityCredentials(params: IdentityParams): Promise<IdentityResult> {
  const { idToken, identityPoolId, userPoolId, region, customRoleArn } = params;
  const logins = { [`cognito-idp.${region}.amazonaws.com/${userPoolId}`]: idToken };

  const { IdentityId } = await callCognitoIdentity<{ IdentityId: string }>(
    region, 'GetId', { IdentityPoolId: identityPoolId, Logins: logins }
  );
  if (!IdentityId) throw new Error('Failed to obtain IdentityId');

  const { Credentials } = await callCognitoIdentity<{
    Credentials: { AccessKeyId: string; SecretKey: string; SessionToken: string; Expiration: number };
  }>(region, 'GetCredentialsForIdentity', {
    IdentityId,
    Logins: logins,
    ...(customRoleArn ? { CustomRoleArn: customRoleArn } : {}),
  });
  if (!Credentials) throw new Error('Failed to obtain temporary AWS credentials');

  return {
    identityId: IdentityId,
    credentials: {
      AccessKeyId: Credentials.AccessKeyId,
      SecretKey: Credentials.SecretKey,
      SessionToken: Credentials.SessionToken,
      Expiration: new Date(Credentials.Expiration * 1000),
    },
  };
}
