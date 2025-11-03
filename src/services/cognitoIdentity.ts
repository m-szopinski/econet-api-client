import { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';

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

export async function getCognitoIdentityCredentials(params: IdentityParams): Promise<IdentityResult> {
  const { idToken, identityPoolId, userPoolId, region, customRoleArn } = params;

  const client = new CognitoIdentityClient({ region });
  const providerKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const logins = { [providerKey]: idToken } as Record<string, string>;

  const getId = await client.send(
    new GetIdCommand({ IdentityPoolId: identityPoolId, Logins: logins })
  );
  if (!getId.IdentityId) {
    throw new Error('Failed to obtain IdentityId');
  }

  const getCreds = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId: getId.IdentityId,
      Logins: logins,
      ...(customRoleArn ? { CustomRoleArn: customRoleArn } : {}),
    })
  );
  if (!getCreds.Credentials) {
    throw new Error('Failed to obtain temporary AWS credentials');
  }

  return {
    identityId: getId.IdentityId,
    credentials: {
      AccessKeyId: getCreds.Credentials.AccessKeyId!,
      SecretKey: getCreds.Credentials.SecretKey!,
      SessionToken: getCreds.Credentials.SessionToken!,
      Expiration: getCreds.Credentials.Expiration!,
    },
  };
}
