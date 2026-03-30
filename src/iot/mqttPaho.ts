import type { AwsCredentials } from './sigv4.js';
import { createPresignedUrl } from './sigv4.js';
import type { MqttLikeConnection, QoS } from './streams.js';

type ConnectParams = {
  endpoint: string; // wss://<endpoint>/mqtt
  region: string;
  clientId: string;
  credentials: AwsCredentials;
  origin?: string;  // optional Origin header for Node ws
};

export async function connectAwsIotPaho(params: ConnectParams): Promise<MqttLikeConnection> {
  const { endpoint, region, clientId, credentials } = params;
  const originHeader = params.origin ?? 'https://econetcloud.eu';

  // Ensure a WebSocket implementation is available in Node and attach diagnostics
  try {
    const { default: NodeWebSocket } = await import('ws');
    const DebugWebSocket = class extends (NodeWebSocket as any) {
      constructor(url: string, protocols?: any) {
        super(url, protocols, { origin: originHeader });
        try {
          this.on('unexpected-response', (_req: any, res: any) => {
            const chunks: any[] = [];
            res.on('data', (c: any) => chunks.push(c));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              // eslint-disable-next-line no-console
              console.warn('[PAHO][WS] unexpected-response', {
                status: res?.statusCode,
                statusMessage: res?.statusMessage,
                headers: res?.headers,
                body: body?.slice(0, 1024),
              });
            });
          });
          this.on('error', (err: any) => {
            // eslint-disable-next-line no-console
            console.warn('[PAHO][WS] error', err?.message || err);
          });
        } catch {}
      }
    } as any;
    (globalThis as any).WebSocket = DebugWebSocket;
  } catch {
    // If ws is not available, rely on global WebSocket (Node >= 22). No-op.
  }

  // Import Paho (ESM default export contains Client/Message)
  const paho = await import('paho-mqtt');
  const mod = (paho as any)?.default ? (paho as any).default : (paho as any);
  const { Client, Message } = mod as any;

  // X-Amz-ClientId is NOT in the URL — it goes only to the Paho constructor (matches Amplify AWSIoTProvider).
  // X-Amz-Expires is omitted entirely (Amplify signUrl for IoT doesn't pass expiration).
  const url = await createPresignedUrl({ endpoint, region, credentials });

  const client = new Client(url, clientId);

  const handlers = new Map<string, Set<(t: string, p: ArrayBuffer | Buffer) => void>>();

  await new Promise<void>((resolve, reject) => {
    client.onConnectionLost = (responseObject: any) => {
      const code = responseObject?.errorCode;
      const msg = responseObject?.errorMessage || responseObject?.error || 'connection lost';
      // eslint-disable-next-line no-console
      console.warn('[PAHO] connection lost', { code, msg });
    };

    client.onMessageArrived = (message: any) => {
      const topic: string = message.destinationName;
      const payloadStr: string = typeof message.payloadString === 'string' ? message.payloadString : '';
      const payload = Buffer.from(payloadStr, 'utf8');
      const set = handlers.get(topic);
      if (set) for (const h of Array.from(set)) { try { h(topic, payload); } catch {} }
    };

    client.connect({
      useSSL: true,
      cleanSession: true,
      mqttVersion: 3,  // Amplify AWSIoTProvider uses mqttVersion:3 (MQTT 3.1)
      keepAliveInterval: 60,
      timeout: 15,
      onSuccess: () => resolve(),
      onFailure: (err: any) => reject(new Error(err?.errorMessage || err?.message || String(err))),
    } as any);
  });

  const connection: MqttLikeConnection = {
    async subscribe(topic: string, qos: QoS, handler: (t: string, p: ArrayBuffer | Buffer) => void) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(handler);
      await new Promise<void>((resolve, reject) =>
        client.subscribe(topic, {
          qos: Number(qos) as any,
          onSuccess: () => resolve(),
          onFailure: (e: any) => reject(new Error(e?.errorMessage || e?.message || String(e))),
        })
      );
    },
    async unsubscribe(topic: string) {
      await new Promise<void>((resolve, reject) =>
        client.unsubscribe(topic, {
          onSuccess: () => resolve(),
          onFailure: (e: any) => reject(new Error(e?.errorMessage || e?.message || String(e))),
        })
      );
      const set = handlers.get(topic);
      if (set) { set.clear(); handlers.delete(topic); }
    },
    async publish(topic: string, payload: string, qos: QoS) {
      const msg = new Message(payload);
      msg.destinationName = topic;
      msg.qos = Number(qos) as any;
      msg.retained = false as any;
      client.send(msg);
    },
  };

  return connection;
}
