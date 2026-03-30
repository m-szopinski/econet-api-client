import 'dotenv/config';
import { EcoNetAPIClient } from '../lib/econetClient.js';

async function run() {
  const client = await EcoNetAPIClient({
    username: process.env.ECONET_USERNAME!,
    password: process.env.ECONET_PASSWORD!,
    region: process.env.AWS_REGION!,
    userPoolId: process.env.USER_POOL_ID!,
    clientId: process.env.USER_POOL_WEB_CLIENT_ID!,
    identityPoolId: process.env.USER_IDENTITY_POOL_ID!,
    iotEndpoint: process.env.AWS_IOT_ENDPOINT!,
    appBaseUrl: process.env.AWS_API_ENDPOINT!,
    econetBaseUrl: process.env.ECONET_API_ENDPOINT!,
    siteBaseUrl: process.env.ECONET_SITE,
  });

  // Fetch installations and pick the first
  const installations = await client.getInstallations();
  if (!installations.length) {
    console.error('No installations available.');
    return;
  }
  const { id: installationId, name } = installations[0];
  console.log('Subscribing to', { installationId, name });

  const logMsg = (label: string) => (msg: any) => {
    const payload = msg.labeled ?? msg.json ?? msg.text;
    console.log(label, msg.topic, typeof payload === 'string' ? payload : JSON.stringify(payload));
  };

  const onStreamError = (label: string) => (err: any) => {
    console.warn(`${label} stream error (MQTT may be unavailable): ${err?.message ?? err}`);
  };

  const notifSub = client.installationNotifications$(installationId).subscribe({
    next: logMsg('[notifications]'),
    error: onStreamError('[notifications]'),
  });
  const respSub = client.installationResponse$(installationId).subscribe({
    next: logMsg('[response]'),
    error: onStreamError('[response]'),
  });

  // Request all known parameters for the installation with library defaults
  try {
    const total = await client.requestAllValues(installationId);
    console.log(`Requested ${total} parameters in total`);
  } catch (e) {
    console.warn('Failed to request all parameters:', (e as Error).message);
  }

  console.log('Press Ctrl+C to exit...');
  await new Promise<void>((resolve) => {
    const onSig = () => { process.removeListener('SIGINT', onSig); resolve(); };
    process.once('SIGINT', onSig);
  });

  notifSub.unsubscribe();
  respSub.unsubscribe();
}

run().catch((err) => {
  console.error('MQTT demo error:', err.message || err);
  process.exit(1);
});
