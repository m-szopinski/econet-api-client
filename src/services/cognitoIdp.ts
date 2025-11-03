import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";

export type CognitoUserAttributes = Record<string, string>;

export async function getUserAttributes(params: { accessToken: string; region: string }): Promise<CognitoUserAttributes> {
  const { accessToken, region } = params;
  const client = new CognitoIdentityProviderClient({ region });
  const cmd = new GetUserCommand({ AccessToken: accessToken });
  const out = await client.send(cmd);
  const attrs = Object.create(null) as CognitoUserAttributes;
  for (const a of out.UserAttributes || []) {
    if (a.Name && a.Value != null) attrs[a.Name] = a.Value;
  }
  return attrs;
}
