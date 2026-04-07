# econet-api-client

> ⚠️ **Unofficial library** — for ecoNET / Plum devices.

TypeScript client for the [ecoNET Cloud](https://econetcloud.eu) platform:
- Log in with your ecoNET username and password (Cognito SRP, SigV4)
- Fetch installations, details, profiles and translations
- Receive real-time data via MQTT over WebSocket
- Automatically enrich MQTT messages and REST responses with human-readable labels

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
  lang: 'en', // default; falls back to 'en' if the requested language file is unavailable
});

// REST — list installations
const installations = await client.getInstallations();
const id = installations[0]?.id;

// MQTT — real-time notification stream (RxJS)
client.installationNotifications$(id).subscribe((msg) => {
  // msg.labeled  — enriched parameters (translated labels + extracted values)
  // msg.json     — raw parsed JSON
  console.log(msg.labeled ?? msg.json);
});

// Request all current parameter values from the device
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
| `iotEndpoint` | ✅ | WebSocket MQTT endpoint (`wss://…`) |
| `appBaseUrl` | ✅ | App API base URL |
| `econetBaseUrl` | ✅ | ecoNET Cloud API base URL |
| `siteBaseUrl` | ➖ | Site base URL used for profile / translation fetching |
| `lang` | ➖ | Language for parameter labels — `'pl'`, `'en'`, … (default `'en'`) |
| `debug` | ➖ | Enable diagnostic logging |
| `defaultValuesChunkSize` | ➖ | Chunk size for `requestAllValues` (default: `100`) |
| `fetcher` | ➖ | Custom `fetch` implementation |

## Client methods

| Method | Description |
|--------|-------------|
| `getInstallations()` | List installations linked to the account |
| `getInstallationDetails(id)` | Installation details and component list |
| `getInstallationParameters(id)` | All known parameters with translated labels (fetched once, then cached) |
| `getNotifications()` | User notifications |
| `postRegisteredDataValues(id, body)` | Historical time-series values — automatically enriched with `label` and `unit` |
| `requestAllValues(id)` | Request all current parameter values via MQTT |
| `requestValues(id, componentId, params[])` | Request specific parameter values |
| `setValues(id, componentId, values)` | Write parameter values via MQTT (`PARAMS_MODIFICATION`) |
| `requestComponentsOnBus(id)` | Request bus component list |
| `installationNotifications$(id)` | RxJS stream — installation push notifications |
| `installationResponse$(id)` | RxJS stream — responses to requests |
| `getProfile(params)` | Fetch raw device profile (`profile.json`) |
| `getTranslations(params)` | Fetch raw translation file for a profile |
| `sendInstallationRequest(id, body)` | Low-level MQTT publish |

## MQTT labeled output

On every push notification the library automatically:
1. loads the device profile and translations on the first message (then caches)
2. attaches `msg.labeled` — a copy of `messages[].targets[].parameters` with enriched values

Parameter keys are preserved exactly as sent by the device (`@u6204`, `@temperatura_pomieszczenia`, `0`, `1`, …). Each value object contains `value` and, when available, `label` and `unit`:

```jsonc
// msg.labeled.messages[0].targets[0].parameters
{
  "@u7271":               { "value": 24.97, "label": "Room temperature",       "unit": "°C" },
  "@u6204":               { "value": 11.61, "label": "Outside temperature",    "unit": "°C" },
  "@temperatura_nawiewu": { "value": 22.11, "label": "Supply air temperature", "unit": "°C" },
  "@aktualna_wilgotnosc": { "value": 35.28, "label": "Current humidity",       "unit": "%" },
  "0":                    { "value": 14.91, "label": "Program series" }
}
```

```ts
client.installationNotifications$(id).subscribe((msg) => {
  const params = msg.labeled?.messages?.[0]?.targets?.[0]?.parameters ?? {};
  for (const [key, p] of Object.entries(params)) {
    console.log(`${p.label ?? key}: ${p.value}${p.unit ? ' ' + p.unit : ''}`);
  }
});
```

## Historical data (`postRegisteredDataValues`)

Returns time-series data automatically enriched with `label` and `unit` per parameter:

```ts
const result = await client.postRegisteredDataValues(id, {
  range: ['2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'],
  targets: [{ parameters: ['u7271', 'u6204'] }],
});

for (const comp of result.components ?? []) {
  for (const p of comp.parameters ?? []) {
    console.log(`${p.label ?? p.key} [${p.unit ?? '—'}]`, p.values);
  }
}
```

## Setting parameter values

```ts
const details = await client.getInstallationDetails(id);
const componentId = details.components?.[0]?.componentFn!;

// Discover parameter keys at runtime (model/firmware-specific)
const params = await client.getInstallationParameters(id);
// [ { key: 'u6342', label: 'Unit state' }, { key: 'u6338', label: 'Unit mode' }, … ]

const unitState = params.find(p => p.label === 'Unit state');
const unitMode  = params.find(p => p.label === 'Unit mode');
const bypass    = params.find(p => p.label === 'Bypass');

// Write values — always pass strings
await client.setValues(id, componentId, { [unitState!.key]: '1' }); // ON
await client.setValues(id, componentId, { [unitState!.key]: '0' }); // OFF
await client.setValues(id, componentId, { [bypass!.key]:    '1' }); // bypass ON

// Set multiple values atomically
await client.setValues(id, componentId, {
  [unitState!.key]: '1',
  [unitMode!.key]:  '1', // 0 = schedule · 1 = manual · 2 = away (profile-dependent)
});
```

> **Tip:** Always discover keys via `getInstallationParameters()` — they vary by device
> model, hardware version and firmware.

### Listening for write confirmation

```ts
client.installationResponse$(id).subscribe((msg) => {
  const targets = (msg.json as any)?.messages?.[0]?.targets ?? [];
  for (const t of targets) {
    for (const [key, status] of Object.entries(t?.parameters ?? {})) {
      const ok = status === '0' || status === '16';
      console.log(key, ok ? 'accepted' : `rejected (${status})`);
    }
  }
});
```

## Notes

- ESM-only package (Node.js ≥ 18). TypeScript types included (`.d.ts`).
- Profile and translation files are fetched once per installation and cached in memory.
- `client.idToken`, `client.accessToken` — raw Cognito session tokens.
- `client.raw` — direct access to the underlying typed REST clients.
