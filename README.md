# econet-api-client

> ⚠️ **Unofficial library** — for ecoNET / Plum devices.

TypeScript client for the [ecoNET Cloud](https://econetcloud.eu) platform:
- Log in with your ecoNET username and password
- Fetch installations and their details
- Receive real-time data via MQTT over WebSocket
- Enrich MQTT messages with labels from device profiles

## Installation

```bash
npm install econet-api-client
```

## Quick start

```ts
import { EcoNetAPIClient } from 'econet-api-client';

const client = await EcoNetAPIClient({
  username: '<username>',
  password: '<password>',

  region: 'eu-central-1',
  userPoolId: '<user-pool-id>',
  clientId: '<app-client-id>',
  identityPoolId: '<identity-pool-id>',
  iotEndpoint: 'wss://<endpoint>-ats.iot.eu-central-1.amazonaws.com/mqtt',

  appBaseUrl: 'https://<api-id>.execute-api.eu-central-1.amazonaws.com/prod',
  econetBaseUrl: 'https://api.econetcloud.eu/api',

  // optional
  siteBaseUrl: 'https://econetcloud.eu',
});

// REST — list installations
const installations = await client.getInstallations();
const id = installations[0]?.id;
const details = await client.getInstallationDetails(id);

// MQTT — real-time notification stream (RxJS)
client.installationNotifications$(id).subscribe((msg) => {
  console.log(msg.topic, msg.labeled ?? msg.json ?? msg.text);
});

// Request all current parameter values
await client.requestAllValues(id);
```

## Configuration (`EcoNetInit`)

| Field | Required | Description |
|-------|----------|-------------|
| `username` | ✅ | ecoNET username |
| `password` | ✅ | ecoNET password |
| `region` | ✅ | AWS region (e.g. `eu-central-1`) |
| `userPoolId` | ✅ | Cognito User Pool ID |
| `clientId` | ✅ | Cognito App Client ID |
| `identityPoolId` | ✅ | Cognito Identity Pool ID |
| `iotEndpoint` | ✅ | WebSocket MQTT endpoint (`wss://...`) |
| `appBaseUrl` | ✅ | App API base URL |
| `econetBaseUrl` | ✅ | ecoNET Cloud API base URL |
| `siteBaseUrl` | ➖ | Site base URL (used for profile fetching) |
| `lang` | ➖ | Language code for parameter labels, e.g. `'pl'`, `'en'` (default: `'en'`, falls back to `'en'` if file not found) |
| `debug` | ➖ | Enable diagnostic logging |
| `defaultValuesChunkSize` | ➖ | Chunk size for `requestAllValues` (default: 100) |
| `fetcher` | ➖ | Custom `fetch` implementation |

## Client methods

| Method | Description |
|--------|-------------|
| `getInstallations()` | List installations linked to the account |
| `getInstallationDetails(id)` | Installation details and components |
| `getInstallationParameters(id)` | Available parameters (from device profiles) |
| `getNotifications()` | User notifications |
| `requestAllValues(id)` | Request all parameter values via MQTT |
| `requestValues(id, componentId, params[])` | Request specific parameter values |
| `setValues(id, componentId, values)` | **Set** parameter values via MQTT (PARAMS_MODIFICATION) |
| `requestComponentsOnBus(id)` | Request bus component list |
| `primeInstallation(id)` | Initialise installation (components + initial values) |
| `installationNotifications$(id)` | RxJS stream — installation notifications |
| `installationResponse$(id)` | RxJS stream — responses to requests |
| `postRegisteredDataValues(id, body)` | Store historical parameter values |
| `getProfile({ producerCode, deviceName, firmware, schema })` | Fetch device profile (`profile.json`) |
| `getTranslations({ producerCode, deviceName, firmware, schema, lang })` | Fetch raw translations for a profile |
| `sendInstallationRequest(id, body)` | Low-level MQTT publish helper |

## Setting parameter values

The ecoNET MQTT protocol uses a `PARAMS_MODIFICATION` operation to write values to a device.  
`setValues()` wraps this and sends values as **strings** (the protocol requirement).

```ts
const details = await client.getInstallationDetails(installationId);
const componentId = details.components?.[0]?.componentFn!; // serial / bus address

// Set a single parameter
await client.setValues(installationId, componentId, { '<paramKey>': '<value>' });
```

The device confirms success via the `installationResponse$` stream — response targets
contain `parameters` entries where status `"0"` or `"16"` means accepted.

### Discovering parameter keys (Unit mode / Unit state / Bypass)

Parameter names like "Unit mode", "Unit state" or "Bypass" come from the device's
translation file and vary by model and firmware. Use `getInstallationParameters()` to
list all available keys with their human-readable labels:

```ts
const params = await client.getInstallationParameters(installationId);
// [ { key: 'u6342', title: 'Unit state', unit: undefined }, ... ]

const unitState  = params.find(p => p.title === 'Unit state');
const unitMode   = params.find(p => p.title === 'Unit mode');
const bypass     = params.find(p => p.title === 'Bypass');

console.log(unitState?.key);  // e.g. "u6342"
console.log(unitMode?.key);   // e.g. "u6338"
console.log(bypass?.key);     // e.g. "u6341"
```

> **Note:** Exact parameter keys depend on the device model, hardware version and
> firmware. Always discover them at runtime via `getInstallationParameters()` rather
> than hard-coding.

### Examples

```ts
// Turn unit ON (Unit state = 1)
await client.setValues(installationId, componentId, { [unitState!.key]: '1' });

// Turn unit OFF
await client.setValues(installationId, componentId, { [unitState!.key]: '0' });

// Change Unit mode (values depend on the profile's options list)
// 0 = schedule, 1 = manual, 2 = away — check profile for exact mapping
await client.setValues(installationId, componentId, { [unitMode!.key]: '1' });

// Enable bypass
await client.setValues(installationId, componentId, { [bypass!.key]: '1' });

// Disable bypass
await client.setValues(installationId, componentId, { [bypass!.key]: '0' });

// Set multiple values atomically
await client.setValues(installationId, componentId, {
  [unitState!.key]: '1',
  [unitMode!.key]: '1',
});
```

### Listening for the confirmation

```ts
client.installationResponse$(installationId).subscribe((msg) => {
  const targets = (msg.json as any)?.messages?.[0]?.targets ?? [];
  for (const t of targets) {
    const statuses: Record<string, string> = t?.parameters ?? {};
    for (const [key, status] of Object.entries(statuses)) {
      const ok = status === '0' || status === '16';
      console.log(key, ok ? 'accepted' : `rejected (${status})`);
    }
  }
});
```

## Notes

- ESM-only package (Node.js ≥ 18). TypeScript types included (`.d.ts`).
- `client.idToken`, `client.accessToken` — raw session tokens available if needed.
- `client.raw` — low-level access to the underlying REST clients.
