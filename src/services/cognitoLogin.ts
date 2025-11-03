import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from 'amazon-cognito-identity-js';

export type LoginParams = {
  username: string;
  password: string;
  userPoolId: string;
  clientId: string;
  region: string;
};

export type LoginTokens = {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
};

export function loginWithCognitoSRP(params: LoginParams): Promise<LoginTokens> {
  const { username, password, userPoolId, clientId } = params;

  const userPool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
  const user = new CognitoUser({ Username: username, Pool: userPool });
  const authDetails = new AuthenticationDetails({ Username: username, Password: password });

  return new Promise((resolve, reject) => {
    user.authenticateUser(authDetails, {
      onSuccess: (session: any) => {
        resolve({
          idToken: session.getIdToken().getJwtToken(),
          accessToken: session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken()?.getToken(),
        });
      },
      onFailure: (err: any) => reject(err),
      mfaRequired: (_challengeName: any, _challengeParameters: any) => {
        reject(new Error('MFA is required but not implemented in this CLI'));
      },
      newPasswordRequired: () => {
        reject(new Error('New password challenge not implemented in this CLI'));
      },
    });
  });
}
