import { Observable, Subscriber } from 'rxjs';
import { mqtt } from 'aws-iot-device-sdk-v2';

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
  connection: mqtt.MqttClientConnection,
  topic: string,
  qos: mqtt.QoS = mqtt.QoS.AtLeastOnce
): Observable<TopicMessage> {
  return new Observable<TopicMessage>((subscriber: Subscriber<TopicMessage>) => {
    let unsubscribed = false;
    const onMessage = (t: string, p: ArrayBuffer | Buffer) => {
      const parsed = parsePayload(p);
      subscriber.next({ topic: t, ...parsed });
    };
    connection
      .subscribe(topic, qos, onMessage)
      .then(() => {
        if (unsubscribed) {
          // If the subscriber already unsubscribed, immediately clean up
          return connection.unsubscribe(topic).catch(() => {});
        }
      })
      .catch((err) => subscriber.error(err));

    return () => {
      unsubscribed = true;
      connection.unsubscribe(topic).catch(() => {});
    };
  });
}

export function installationNotifications$(
  connection: mqtt.MqttClientConnection,
  installationId: string
): Observable<TopicMessage> {
  const topic = `${installationId}/installationNotifications`;
  return topic$(connection, topic);
}

export function installationResponse$(
  connection: mqtt.MqttClientConnection,
  installationId: string,
  clientId: string
): Observable<TopicMessage> {
  const topic = `${installationId}/${clientId}/installationResponse`;
  return topic$(connection, topic);
}

// --- Publishers ---

export async function publishJson(
  connection: mqtt.MqttClientConnection,
  topic: string,
  payload: unknown,
  qos: mqtt.QoS = mqtt.QoS.AtLeastOnce
): Promise<void> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  await connection.publish(topic, text, qos);
}

export async function sendInstallationRequest(
  connection: mqtt.MqttClientConnection,
  installationId: string,
  clientId: string,
  body: unknown
): Promise<void> {
  const topic = `${installationId}/${clientId}/installationRequest`;
  await publishJson(connection, topic, body);
}
