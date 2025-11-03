# EcoNet TypeScript client

TypeScript client for ecoNET that:
- Logs in with Cognito SRP and exchanges tokens for temporary AWS credentials
- Signs API Gateway requests with SigV4 (execute-api)
- Calls econetcloud.eu using Bearer IdToken
- Connects to AWS IoT over WebSocket (CRT) and exposes RxJS streams
- Enriches incoming MQTT messages with labels from profile.json

## Install

```bash
npm install econet-api-client
```

### Troubleshooting 403 on WebSocket upgrade

- A 403 before MQTT CONNACK typically means authorization failed at the IoT HTTP/auth layer.
- Ensure the temporary credentials have an attached role/policy allowing `iot:Connect` to your endpoint and `clientId` (many policies constrain `iot:ClientId` to the Cognito Identity ID).
	If your Identity Pool uses role mapping, make sure your user is mapped to a role that allows iot:Connect for your clientId.

## Programmatic usage

EcoNet API Client (recommended):

```ts
import { EcoNetAPIClient } from 'econet-api-client';

const client = await EcoNetAPIClient({
	// Credentials
	username: '<your-username>',
	password: '<your-password>',

	// AWS/Cognito
	region: 'eu-central-1',
	userPoolId: '<your-user-pool-id>',
	clientId: '<your-user-pool-web-client-id>',
	identityPoolId: '<your-identity-pool-id>',
	iotEndpoint: 'wss://<your-endpoint>-ats.iot.eu-central-1.amazonaws.com/mqtt',

	// API bases
	appBaseUrl: 'https://<api-id>.execute-api.eu-central-1.amazonaws.com/prod',
	econetBaseUrl: 'https://api.econetcloud.eu',

	// Optional
	siteBaseUrl: 'https://econetcloud.eu',
});

// REST (SigV4 for app; Bearer for econet)
const installations = await client.getInstallations();
const id = installations[0]?.id;
const details = await client.getInstallationDetails(id);

// MQTT streams (RxJS)
const notifSub = client.installationNotifications$(id).subscribe((msg) => {
	console.log('notif', msg.topic, msg.labeled ?? msg.json ?? msg.text);
});

// Convenience: discover available parameters and request their values (chunked automatically)
await client.requestAllValues(id);
```

Low-level REST wrapper (if you only need REST):

```ts
import { createApiClients } from 'econet-api-client';
```

## API surface

### Config (EcoNetInit)

| Field            | Type                                                    | Required | Description |
|------------------|---------------------------------------------------------|----------|-------------|
| username         | string                                                  | yes      | ecoNET username used for Cognito SRP login |
| password         | string                                                  | yes      | ecoNET password used for Cognito SRP login |
| region           | string                                                  | yes      | AWS region (e.g. `eu-central-1`) |
| userPoolId       | string                                                  | yes      | Cognito User Pool ID |
| clientId         | string                                                  | yes      | Cognito User Pool App Client ID (web client) |
| identityPoolId   | string                                                  | yes      | Cognito Identity Pool ID for exchanging IdToken to AWS creds |
| iotEndpoint      | string (wss URL ending with `/mqtt`)                    | yes      | AWS IoT Core endpoint (WSS) |
| appBaseUrl       | string (URL)                                            | yes      | App API base (API Gateway; SigV4) |
| econetBaseUrl    | string (URL)                                            | yes      | econetcloud API base (Bearer IdToken) |
| siteBaseUrl      | string (URL)                                            | no       | Optional website base for profile/doc lookups |
| debug            | boolean                                                 | no       | Enables debug logging (e.g., logs attempted profile.json URLs and outcomes) |
| defaultValuesChunkSize | number                                            | no       | Default chunk size for batched GET_VALUES in `requestAllValues` (default: 100) |
| fetcher          | (input: RequestInfo, init?: RequestInit) => Promise<Response> | no  | Custom fetch used by REST layer (defaults to SigV4 fetcher) |

### Client methods

| Method | Parameters | Returns | Notes |
|-------|------------|---------|-------|
| getNotifications | – | Promise([UserNotificationsResponse](#usernotificationsresponse)) | App API (SigV4) |
| getInstallations | – | Promise([GetInstallationsResponse](#getinstallationsresponse)) | App API (SigV4); returns an array of installations |
| getInstallationDetails | (installationId: string) | Promise([InstallationDetailsResponse](#installationdetailsresponse)) | App API (SigV4) |
| getInstallationParameters | (installationId: string, opts?) | Promise<{ key, title, unit? }[]> | Derived from component profiles for this installation |
| requestComponentsOnBus | (installationId: string, transactionId = '1', clientIdOverride?) | Promise<void> | Publishes GET_COMPONENTS_ON_BUS over MQTT |
| requestValues | (installationId: string, componentId: string, parameters: string[], transactionId = '2', clientIdOverride?) | Promise<void> | Publishes GET_VALUES for a component/parameter list |
| requestAllValues | (installationId: string, opts?: { componentId?, chunkSize?, transactionStart?, profile?, clientIdOverride? }) | Promise<number> | Resolves available parameters via profiles and requests their values in chunks; returns count |
| primeInstallation | (installationId: string, opts?: { componentId?, parameters?, transactionIds?, clientIdOverride? }) | Promise<void> | Sends GET_COMPONENTS_ON_BUS and a small initial GET_VALUES request |
| getProfile | ({ producerCode, deviceName, firmware, schema }) | Promise([ProfileJson](#profilejson)) | App API (SigV4); profile.json for a device/firmware/schema |
| getTranslations | ({ producerCode, deviceName, firmware, schema, lang }) | Promise([TranslationsJson](#translationsjson)) | App API (SigV4); translations map for a profile and language |
| postRegisteredDataValues | (installationId: string, body: [RegisteredDataValuesRequest](#registereddatavaluesrequest)) | Promise([RegisteredDataValuesResponse](#registereddatavaluesresponse)) | econetcloud API (Bearer) |
| installationNotifications$ | (installationId: string, opts?: { profile?: ProfileSelector }) | Observable<TopicMessage> | AWS IoT (CRT); emits topic + parsed JSON + labeled view |
| installationResponse$ | (installationId: string, clientId?: string, opts?: { profile?: ProfileSelector }) | Observable<TopicMessage> | Uses provided clientId or the one from the CRT connection |
| sendInstallationRequest | (installationId: string, body: unknown, clientIdOverride?: string) | Promise<void> | Low-level publish helper if you need full control over payload |

### Response types (summary)

#### GetInstallationsResponse
Array of installations with fields like: id, name, factoryNumber, customName?, hardwareVersion?, softVersion?, hasAccess?, isConnected?, hasAlarms?, producerCode?, protocol?.

#### InstallationDetailsResponse
Object with installationInfo? and components?:
- installationInfo?: { id?, name?, isConnected?, hasAlarms?, softVersion?, hardwareVersion?, factoryNumber?, producerCode?, producerName?, ... }
- components?: Array<{ componentFn?, componentType?, softVersion?, hardwareVersion?, producerCode?, producerName?, protocol?, isHidden?, typeId?, hasRadioModule? }>

#### UserNotificationsResponse
{ success: boolean, data?: { maintenance?: { fromDate?, toDate? }, invitations?: unknown | null, accessRequests?: unknown[] } }

#### RegisteredDataValuesRequest
{ range?: [fromISO, toISO], targets?: Array<{ factoryNumber?: string, parameters?: string[] }> }

#### RegisteredDataValuesResponse
{ installation?: string, components?: Array<{ factoryNumber?: string, parameters?: Array<{ key?: string, timestamps?: number[], values?: number[], isDownsampled?: boolean }> }> }

#### ProfileJson
Large schema describing UI and parameters; includes tiles, barParams, editionScreens, schedules, schemas, charts, alarms, advancedParameters, notifications, wizards, profileColor.

#### TranslationsJson
Record<string, string> mapping translation keys to localized strings.

Notes:
- Public tokens are available on the client for advanced scenarios: `client.accessToken`, `client.idToken`.
- A low-level REST handle is exposed for power users: `client.raw` (same shape as `createApiClients`).
- ESM-only package (type: module). Types included via .d.ts.
