import { Observable, Subscriber } from 'rxjs';

// A minimal MQTT-like connection contract used by both CRT and potential fallbacks
export type QoS = 0 | 1 | 2;
export type MessageHandler = (topic: string, payload: ArrayBuffer | Buffer) => void;
export type MqttLikeConnection = {
  // Use permissive return types (any) to be structurally compatible with CRT (which returns Promise<MqttSubscribeRequest>)
  subscribe: (topic: string, qos: QoS, handler: MessageHandler) => any;
  unsubscribe: (topic: string) => any;
  publish: (topic: string, payload: string, qos: QoS) => any;
};

export type TopicMessage = {
  topic: string;
  text?: string;
  json?: unknown;
};

function parsePayload(payload: ArrayBuffer | Buffer): { text: string; json?: unknown } {
  try {
    let text: string;
    if (typeof (payload as any).byteLength === 'number' && !(payload as any).length) {
      text = new TextDecoder().decode(new Uint8Array(payload as ArrayBuffer));
    } else if (typeof (payload as any).length === 'number') {
      text = (payload as any as Buffer).toString('utf8');
    } else {
      text = String(payload as any);
    }
    try {
      const json = JSON.parse(text);
      return { text, json };
    } catch {
      return { text };
    }
  } catch {
    return { text: '<binary>' };
  }
}

function topic$(
  connection: MqttLikeConnection,
  topic: string,
  qos: QoS = 1
): Observable<TopicMessage> {
  return new Observable<TopicMessage>((subscriber: Subscriber<TopicMessage>) => {
    let unsubscribed = false;
    const onMessage = (t: string, p: ArrayBuffer | Buffer) => {
      const parsed = parsePayload(p);
      subscriber.next({ topic: t, ...parsed });
    };
    Promise.resolve(connection
      .subscribe(topic, qos, onMessage) as any)
      .then(() => {
        if (unsubscribed) {
          // If the subscriber already unsubscribed, immediately clean up
          return Promise.resolve(connection.unsubscribe(topic) as any).catch(() => {});
        }
      })
      .catch((err) => subscriber.error(err));

    return () => {
      unsubscribed = true;
      Promise.resolve(connection.unsubscribe(topic) as any).catch(() => {});
    };
  });
}

export function installationNotifications$(
  connection: MqttLikeConnection,
  installationId: string
): Observable<TopicMessage> {
  const topic = `${installationId}/installationNotifications`;
  return topic$(connection, topic);
}

export function installationResponse$(
  connection: MqttLikeConnection,
  installationId: string,
  clientId: string
): Observable<TopicMessage> {
  const topic = `${installationId}/${clientId}/installationResponse`;
  return topic$(connection, topic);
}

// --- Publishers ---

export async function publishJson(
  connection: MqttLikeConnection,
  topic: string,
  payload: unknown,
  qos: QoS = 1
): Promise<void> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  await Promise.resolve(connection.publish(topic, text, qos) as any);
}

export async function sendInstallationRequest(
  connection: MqttLikeConnection,
  installationId: string,
  clientId: string,
  body: unknown
): Promise<void> {
  const topic = `${installationId}/${clientId}/installationRequest`;
  await publishJson(connection, topic, body);
}
