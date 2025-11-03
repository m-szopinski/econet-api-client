// Dynamic CRT transport: import aws-iot-device-sdk-v2 only when actually used,
// because some runtimes (e.g., Homey) cannot load the native aws-crt binary.

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

export async function connectAwsIotCrt(params: CrtConnectParams): Promise<any> {
  // Lazily import CRT to avoid crashing environments without native binary
  let mqtt: any, iot: any, io: any, auth: any;
  try {
    const mod: any = await import('aws-iot-device-sdk-v2');
    mqtt = mod.mqtt; iot = mod.iot; io = mod.io; auth = mod.auth;
  } catch (e: any) {
    const msg = e?.message || String(e);
    throw new Error(`AWS CRT not available: ${msg}`);
  }

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
