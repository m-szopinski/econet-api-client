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

  const installations = await client.getInstallations();
  if (!installations.length) {
    console.log('No installations available.');
    return;
  }
  const first = installations[0];
  console.log('First installation:', { id: first.id, name: first.name });
}

run().catch((err) => {
  console.error('Client demo error:', err.message || err);
  process.exit(1);
});
