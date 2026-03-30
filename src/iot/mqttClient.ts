import mqtt, { MqttClient } from 'mqtt';
import { createPresignedUrl } from './sigv4.js';

export type ConnectParams = {
  endpoint: string; // wss://.../mqtt
  region: string;
  clientId: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
};

export async function connectAwsIot(params: ConnectParams): Promise<MqttClient> {
  const { endpoint, region, clientId, credentials } = params;
  const url = await createPresignedUrl({
    endpoint,
    region,
    credentials,
    // X-Amz-Expires omitted — Amplify AWSIoTProvider never passes expiration for IoT
    // X-Amz-ClientId not in URL — goes only to MQTT client constructor
  });

  // Redact signature for debug
  const dbgUrl = url
    .replace(/(X-Amz-Signature=)[0-9a-f]+/i, '$1<redacted>')
    .replace(/(X-Amz-Security-Token=)[^&]+/i, '$1<redacted>')
    .replace(/(X-Amz-Credential=)[^&]+/i, '$1<redacted>');
  // eslint-disable-next-line no-console
  console.log('[MQTT] Presigned WSS URL:', dbgUrl);

  const tryConnect = (label: string, opts: mqtt.IClientOptions) =>
    new Promise<MqttClient>((resolve, reject) => {
      const client = mqtt.connect(url, opts);

      // Try to surface HTTP status from underlying ws if possible
      const stream: any = (client as any).stream;
      if (stream && stream.socket && stream.socket.on) {
        stream.socket.once('upgrade', (res: any) => {
          // eslint-disable-next-line no-console
          console.log(`[MQTT] WS upgrade status: ${res.statusCode}`);
        });
        stream.socket.once('unexpected-response', (_req: any, res: any) => {
          // eslint-disable-next-line no-console
          console.warn('[MQTT] Unexpected WS response:', res.statusCode);
        });
      }

      const onConnect = () => {
        client.off('error', onError);
        client.off('close', onClose);
        clearTimeout(timer);
        // eslint-disable-next-line no-console
        console.log(`[MQTT] Connected using variant: ${label}`);
        resolve(client);
      };
      const onError = (err: Error) => {
        client.off('close', onClose);
        clearTimeout(timer);
        client.end(true);
        reject(err);
      };
      const onClose = () => {
        client.off('error', onError);
        clearTimeout(timer);
        reject(new Error(`MQTT connection closed before CONNECT ack (variant: ${label})`));
      };

      const timer = setTimeout(() => {
        client.off('error', onError);
        client.off('close', onClose);
        client.end(true);
        reject(new Error(`MQTT connect timeout (10s) [variant: ${label}]`));
      }, 10_000);

      client.once('connect', onConnect);
      client.once('error', onError);
      client.once('close', onClose);
    });

  const signedHost = new URL(endpoint).host;

  // Variant A: minimal options, let mqtt.js set WS subprotocol automatically
  const base: mqtt.IClientOptions = {
    protocolVersion: 4,
    protocolId: 'MQTT',
    clean: true,
    keepalive: 60,
    clientId,
    reconnectPeriod: 0,
    wsOptions: {} as any,
  };

  // Variant B: explicitly set Sec-WebSocket-Protocol: mqtt
  const withSubproto: mqtt.IClientOptions = {
    ...base,
    wsOptions: {
      // This is forwarded to 'ws' client options; many setups accept 'protocol' here
      // mqtt.js should already set it, but we force it in case of environment differences.
      protocol: 'mqtt',
      origin: 'https://econetcloud.eu',
    } as any,
  } as any;

  // Variant C: explicitly use legacy 'mqttv3.1' subprotocol
  const withLegacySubproto: mqtt.IClientOptions = {
    ...base,
    wsOptions: {
      protocol: 'mqttv3.1',
      origin: 'https://econetcloud.eu',
    } as any,
  } as any;

  try {
    return await tryConnect('base', base);
  } catch (eA) {
    const msgA = (eA as Error).message || '';
    if (!/closed before CONNECT ack|timeout/i.test(msgA)) throw eA;
    try {
      return await tryConnect('wsOptions.protocol=mqtt', withSubproto);
    } catch (eB) {
      const msgB = (eB as Error).message || '';
      if (!/closed before CONNECT ack|timeout/i.test(msgB)) throw eB;
      return await tryConnect('wsOptions.protocol=mqttv3.1', withLegacySubproto);
    }
  }
}
