import type { AwsCredentials } from './sigv4.js';
import { createPresignedUrl } from './sigv4.js';
import type { MqttLikeConnection, QoS } from './streams.js';

export type ConnectParams = {
  endpoint: string; // wss://<host>/mqtt
  region: string;
  clientId: string;
  credentials: AwsCredentials;
  origin?: string; // Origin header sent by the ws client in Node.js (default: https://econetcloud.eu)
};

export async function connectAwsIotPaho(params: ConnectParams): Promise<MqttLikeConnection> {
  const { endpoint, region, clientId, credentials } = params;
  const origin = params.origin ?? 'https://econetcloud.eu';

  // In Node.js environments, polyfill globalThis.WebSocket with the `ws` package.
  // We wrap it to pass the `origin` header, which browsers set automatically.
  try {
    const { default: WS } = await import('ws');
    (globalThis as any).WebSocket = class extends (WS as any) {
      constructor(url: string, protocols?: any) {
        super(url, protocols, { origin });
      }
    };
  } catch {
    // Node >= 22 exposes a native WebSocket — no polyfill needed.
  }

  // Import Paho (ESM default export contains Client/Message)
  const paho = await import('paho-mqtt');
  const mod: any = (paho as any)?.default ?? paho;
  const { Client, Message } = mod;

  // SigV4 presigned URL — no X-Amz-Expires, no X-Amz-ClientId in URL (matches Amplify AWSIoTProvider)
  const url = createPresignedUrl({ endpoint, region, credentials });

  const client = new Client(url, clientId);
  const handlers = new Map<string, Set<(topic: string, payload: Buffer) => void>>();

  await new Promise<void>((resolve, reject) => {
    client.onConnectionLost = (e: any) => {
      // eslint-disable-next-line no-console
      console.warn('[PAHO] connection lost', e?.errorCode, e?.errorMessage ?? e?.error ?? '');
    };

    client.onMessageArrived = (message: any) => {
      const topic: string = message.destinationName;
      const payload = Buffer.from(
        typeof message.payloadString === 'string' ? message.payloadString : '',
        'utf8'
      );
      handlers.get(topic)?.forEach((h) => { try { h(topic, payload); } catch {} });
    };

    client.connect({
      useSSL: true,
      cleanSession: true,
      mqttVersion: 3, // MQTT 3.1 — matches Amplify AWSIoTProvider
      keepAliveInterval: 60,
      timeout: 15,
      onSuccess: () => resolve(),
      onFailure: (err: any) => reject(new Error(err?.errorMessage ?? err?.message ?? String(err))),
    } as any);
  });

  return {
    async subscribe(topic: string, qos: QoS, handler: (t: string, p: Buffer) => void) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(handler);
      await new Promise<void>((resolve, reject) =>
        client.subscribe(topic, {
          qos: Number(qos) as any,
          onSuccess: () => resolve(),
          onFailure: (e: any) => reject(new Error(e?.errorMessage ?? e?.message ?? String(e))),
        })
      );
    },

    async unsubscribe(topic: string) {
      await new Promise<void>((resolve, reject) =>
        client.unsubscribe(topic, {
          onSuccess: () => resolve(),
          onFailure: (e: any) => reject(new Error(e?.errorMessage ?? e?.message ?? String(e))),
        })
      );
      handlers.delete(topic);
    },

    async publish(topic: string, payload: string, qos: QoS) {
      const msg = new Message(payload);
      msg.destinationName = topic;
      msg.qos = Number(qos) as any;
      msg.retained = false as any;
      client.send(msg);
    },
  };
}
