import { mqtt, iot, io, auth } from 'aws-iot-device-sdk-v2';

export type CrtConnectParams = {
  endpoint: string; // a24t7r3f2r1nrr-ats.iot.eu-central-1.amazonaws.com
  region: string;
  clientId: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
};

export async function connectAwsIotCrt(params: CrtConnectParams): Promise<mqtt.MqttClientConnection> {
  const { endpoint, region, clientId, credentials } = params;

  const host = new URL(endpoint).host; // normalize

  const credentialsProvider = auth.AwsCredentialsProvider.newStatic(
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken
  );

  const wsConfig = iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
    credentials_provider: credentialsProvider,
    region,
  });
  wsConfig.with_clean_session(true);
  wsConfig.with_client_id(clientId);
  wsConfig.with_endpoint(host);
  wsConfig.with_keep_alive_seconds(60);

  const config = wsConfig.build();
  const client = new mqtt.MqttClient(new io.ClientBootstrap());
  const connection = client.new_connection(config);

  await connection.connect();
  return connection;
}
