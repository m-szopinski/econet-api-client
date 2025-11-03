import { createApiClients, ApiClients } from '../services/api.js';
import { loginWithCognitoSRP } from '../services/cognitoLogin.js';
import { getCognitoIdentityCredentials } from '../services/cognitoIdentity.js';
import { createSigv4Fetcher } from '../services/sigv4Fetch.js';
import { connectAwsIotCrt } from '../iot/mqttCrt.js';
import { installationNotifications$ as streamInstallationNotifications$, installationResponse$ as streamInstallationResponse$, TopicMessage, sendInstallationRequest as publishInstallationRequest } from '../iot/streams.js';
import type { MqttLikeConnection } from '../iot/streams.js';
import { buildPahoConnectionInfo, type PahoConnectionInfo } from '../iot/pahoInfo.js';
import { defer, switchMap, Observable, map } from 'rxjs';
import { generateClientId } from '../utils/clientId.js';
import type { ProfileJson } from '../services/api.js';

export type ProfileSelector = {
  producerCode?: string;
  deviceName?: string;
  firmware?: string;
  schema?: string;
};

export type MqttStreamOptions = {
  profile?: ProfileSelector; // per-installation profile override
};

export type EcoNetInit = {
  // All values must be provided by the caller; library code must not read process.env directly.
  username: string;
  password: string;
  region: string;
  userPoolId: string;
  clientId: string;
  identityPoolId: string;
  iotEndpoint: string; // wss://.../mqtt
  appBaseUrl: string;
  econetBaseUrl: string;
  siteBaseUrl?: string;
  debug?: boolean; // enable debug logging (e.g., profile URL tracing)
  fetcher?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /** Default chunk size for batched GET_VALUES in requestAllValues (fallback 100) */
  defaultValuesChunkSize?: number;
};

export type EcoNetAPIClient = {
  getNotifications: ApiClients['app']['getNotifications'];
  getInstallations: ApiClients['app']['getInstallations'];
  getInstallationDetails: ApiClients['app']['getInstallationDetails'];
  /**
   * Returns all known parameter descriptors for the installation by inspecting component-derived profiles.
   * Each entry contains the raw parameter key plus a human title/unit when available.
   */
  getInstallationParameters: (
    installationId: string,
    opts?: MqttStreamOptions
  ) => Promise<Array<{ key: string; title: string; unit?: string }>>;
  getProfile: ApiClients['app']['getProfile'];
  postRegisteredDataValues: ApiClients['econet']['postRegisteredDataValues'];
  /** Compute Paho WebSocket connection info (presigned URL, host, clientId) without attempting CRT. */
  getPahoConnectionInfo: (clientIdOverride?: string, expiresInSeconds?: number) => Promise<PahoConnectionInfo>;
  installationNotifications$: (installationId: string, opts?: MqttStreamOptions) => Observable<TopicMessage>;
  installationResponse$: (installationId: string, clientId?: string, opts?: MqttStreamOptions) => Observable<TopicMessage>;
  sendInstallationRequest: (installationId: string, body: unknown, clientIdOverride?: string) => Promise<void>;
  requestComponentsOnBus: (installationId: string, transactionId?: string, clientIdOverride?: string) => Promise<void>;
  requestValues: (
    installationId: string,
    componentId: string,
    parameters: string[],
    transactionId?: string,
    clientIdOverride?: string
  ) => Promise<void>;
  /**
   * Convenience orchestration: resolve available parameters via profiles and request their values via MQTT.
   * Returns the total number of parameters requested.
   */
  requestAllValues: (
    installationId: string,
    opts?: {
      componentId?: string;
      chunkSize?: number; // defaults to 100
      transactionStart?: number; // defaults to 1000
      profile?: ProfileSelector;
      clientIdOverride?: string;
    }
  ) => Promise<number>;
  primeInstallation: (
    installationId: string,
    opts?: {
      componentId?: string;
      parameters?: string[];
      transactionIds?: { discover?: string; values?: string };
      clientIdOverride?: string;
    }
  ) => Promise<void>;
  raw: ApiClients;
  accessToken: string;
  idToken: string;
};

export class EcoNetClient {
  private region!: string;
  private appBaseUrl!: string;
  private api!: ApiClients;
  private mqttConnPromise: Promise<{ connection: MqttLikeConnection; clientId: string }> | null = null;
  private labelsCache = new Map<string, Record<string, { title: string; unit?: string }>>();
  private awsCredentials!: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  private iotEndpoint!: string;
  private defaultChunkSize = 100;

  accessToken!: string;
  idToken!: string;
  raw!: ApiClients;

  private debug = false;
  private constructor() {}

  static async create(init: EcoNetInit): Promise<EcoNetClient> {
    const self = new EcoNetClient();
    // Node-only (Homey) hardening: ensure HOME exists and avoid reading shared AWS config
    if (typeof window === 'undefined') {
      try {
        if (!process.env.HOME && !process.env.USERPROFILE) process.env.HOME = '/tmp';
        if (!process.env.AWS_SDK_LOAD_CONFIG) process.env.AWS_SDK_LOAD_CONFIG = '0';
      } catch {}
    }
    const { username, password, region, userPoolId, clientId, identityPoolId, iotEndpoint, appBaseUrl, econetBaseUrl, siteBaseUrl, debug } = init;
    if (!username) throw new Error('username is required');
    if (!password) throw new Error('password is required');
    if (!region) throw new Error('region is required');
    if (!userPoolId) throw new Error('userPoolId is required');
    if (!clientId) throw new Error('clientId is required');
    if (!identityPoolId) throw new Error('identityPoolId is required');
    if (!iotEndpoint) throw new Error('iotEndpoint is required');
    if (!appBaseUrl) throw new Error('appBaseUrl is required');
    if (!econetBaseUrl) throw new Error('econetBaseUrl is required');
    self.region = region;
    self.debug = !!debug;
    self.iotEndpoint = iotEndpoint;
    if (Number.isFinite(init.defaultValuesChunkSize as number) && (init.defaultValuesChunkSize as number) > 0) {
      self.defaultChunkSize = Math.trunc(init.defaultValuesChunkSize as number);
    }

    const tokens = await loginWithCognitoSRP({ username, password, userPoolId, clientId, region: self.region });
    self.accessToken = tokens.accessToken;
    self.idToken = tokens.idToken;

    const identity = await getCognitoIdentityCredentials({
      idToken: tokens.idToken,
      identityPoolId,
      userPoolId,
      region: self.region,
    });
    self.awsCredentials = {
      accessKeyId: identity.credentials.AccessKeyId,
      secretAccessKey: identity.credentials.SecretKey,
      sessionToken: identity.credentials.SessionToken,
    };

    self.appBaseUrl = appBaseUrl;
    const appBaseHost = new URL(self.appBaseUrl).hostname;

    const sigv4Fetcher = createSigv4Fetcher({
      region: self.region,
      service: 'execute-api',
      credentials: {
        accessKeyId: identity.credentials.AccessKeyId,
        secretAccessKey: identity.credentials.SecretKey,
        sessionToken: identity.credentials.SessionToken,
      },
      signHosts: [appBaseHost],
    });

    self.api = createApiClients({
      fetcher: init?.fetcher ?? sigv4Fetcher,
      appBaseUrl: self.appBaseUrl,
      econetBaseUrl,
      siteBaseUrl,
      defaultHeaders: () => ({ Authorization: `Bearer ${tokens.idToken}` }),
    });
    self.raw = self.api;

    return self;
  }

  private async ensureMqtt(): Promise<{ connection: MqttLikeConnection; clientId: string }> {
    if (!this.mqttConnPromise) {
      // Compute the clientId and presigned URL upfront so both CRT and Paho share the same clientId
      const prelim = await this.getPahoConnectionInfo(undefined, 900);
      const clientId = prelim.clientId;
      // Node/Homey default: CRT first, then automatic fallback to Paho (no control params)
      const loadPaho = async (): Promise<any> => {
        const inSrc = /\/(src|source)\//.test(import.meta.url);
        const primary = inSrc ? '../iot/mqttPaho.ts' : '../iot/mqttPaho.js';
        const fallback = inSrc ? '../iot/mqttPaho.js' : '../iot/mqttPaho.ts';
        const tryImport = async (spec: string) => {
          try {
            const resolver: any = (import.meta as any).resolve;
            const resolved = typeof resolver === 'function' ? await resolver(spec) : spec;
            return await import(resolved);
          } catch (e) {
            return await import(spec); // final attempt without resolve
          }
        };
        try {
          return await tryImport(primary);
        } catch (e1) {
          try {
            return await tryImport(fallback);
          } catch (e2: any) {
            const msg = e2?.message || (e1 as any)?.message || String(e2 || e1);
            throw new Error(`Cannot resolve mqttPaho module: ${msg}`);
          }
        }
      };
      this.mqttConnPromise = (async () => {
        try {
          const crt = await connectAwsIotCrt({
            endpoint: this.iotEndpoint,
            region: this.region,
            clientId,
            credentials: this.awsCredentials,
          });
          const wrapper: MqttLikeConnection = {
            async subscribe(topic: string, qos: number, handler: (t: string, p: ArrayBuffer | Buffer) => void) {
              await crt.subscribe(topic, qos as any, (t: string, payload: ArrayBuffer) => handler(t, Buffer.from(payload as any)));
            },
            async unsubscribe(topic: string) { await crt.unsubscribe(topic); },
            async publish(topic: string, payload: string, qos: number) { await crt.publish(topic, payload, qos as any, false); },
          };
          if (this.debug) console.log('[MQTT] using CRT transport');
          return { connection: wrapper, clientId };
        } catch (e: any) {
          const reason = e?.message || e?.name || String(e);
          console.warn('[MQTT] CRT unavailable, falling back to Paho:', reason);
          const pahoMod: any = await loadPaho();
          const info = await this.getPahoConnectionInfo(clientId, 900);
          const connection: MqttLikeConnection = await pahoMod.connectAwsIotPaho({
            endpoint: this.iotEndpoint,
            region: this.region,
            clientId,
            credentials: this.awsCredentials,
            origin: info.recommended.origin,
          });
          if (this.debug) console.log('[MQTT] using Paho transport (fallback)');
          return { connection, clientId };
        }
      })();
    }
    return this.mqttConnPromise!;
  }

  /**
   * Compute Paho-compatible connection info (host, presigned WSS URL, clientId) using current credentials,
   * without touching the CRT. Safe to call for diagnostics/logging. The URL contains sensitive parameters —
   * use the redacted version for logs.
   */
  getPahoConnectionInfo = async (
    clientIdOverride?: string,
    expiresInSeconds = 900
  ): Promise<PahoConnectionInfo> => {
    const clientId = clientIdOverride ?? generateClientId(this.region);
    const info = await buildPahoConnectionInfo({
      endpoint: this.iotEndpoint,
      region: this.region,
      credentials: this.awsCredentials,
      clientId,
      expiresIn: expiresInSeconds,
      origin: 'https://econetcloud.eu',
    });
    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log('[PAHO][info]', {
        host: info.host,
        region: info.region,
        clientId: info.clientId,
        url: info.presignedUrlRedacted,
      });
    }
    return info;
  };

  private buildLabels(profile: ProfileJson): Record<string, { title: string; unit?: string }> {
    const labels: Record<string, { title: string; unit?: string }> = Object.create(null);
    const record = (key: string, node: any) => {
      const title = typeof node.title === 'string' ? node.title : labels[key]?.title ?? key;
      const unit = typeof node.unit === 'string' ? node.unit : labels[key]?.unit;
      labels[key] = { title, unit };
    };
    const visit = (n: any): void => {
      if (!n) return;
      if (Array.isArray(n)) { for (const it of n) visit(it); return; }
      if (typeof n === 'object') {
        if (typeof n.parameterName === 'string') record(n.parameterName, n);
        if (typeof n.parameter === 'string') record(n.parameter, n);
        for (const k in n) visit(n[k]);
      }
    };
    try { visit(profile); } catch {}
    return labels;
  }

  private async ensureLabels(installationId: string, selector?: ProfileSelector): Promise<Record<string, { title: string; unit?: string }>> {
    const cacheKey = JSON.stringify({ installationId, selector: selector ?? {} });
    const cached = this.labelsCache.get(cacheKey);
    if (cached) return cached;

    const details = await this.api.app.getInstallationDetails(installationId);
    const components = Array.isArray(details.components) ? details.components : [];

    type Attempt = { producerCode: string; deviceName: string; firmware: string; schema: string };
    const attempts: Attempt[] = [];

    // User-specified full selector first
    if (selector?.producerCode && selector?.deviceName && selector?.firmware && selector?.schema) {
      attempts.push({
        producerCode: String(selector.producerCode),
        deviceName: selector.deviceName,
        firmware: selector.firmware,
        schema: selector.schema,
      });
    }

    // One attempt per component
    for (const c of components as any[]) {
      const pc = c?.producerCode, dn = c?.componentType, fw = c?.hardwareVersion, sc = c?.softVersion;
      if (pc != null && dn && fw && sc) attempts.push({ producerCode: String(pc), deviceName: dn, firmware: fw, schema: sc });
    }
    if (!attempts.length) throw new Error('Cannot resolve any profile descriptor from installation components');

    // Deduplicate
    const uniq = new Map<string, Attempt>();
    for (const a of attempts) uniq.set(`${a.producerCode}\u0001${a.deviceName}\u0001${a.firmware}\u0001${a.schema}`, a);
    const plan = Array.from(uniq.values());

    const profiles: ProfileJson[] = [];
    let lastErr: any = null;
    for (const a of plan) {
      const url = `${this.appBaseUrl}/profiles/${encodeURIComponent(String(a.producerCode))}/${encodeURIComponent(a.deviceName)}/${encodeURIComponent(a.firmware)}/${encodeURIComponent(a.schema)}/web/profile.json`;
      if (this.debug) console.log('[profile:url] try', url);
      try {
        const p = await this.api.app.getProfile(a);
        if (this.debug) console.log('[profile:url] ok ', url);
        profiles.push(p);
      } catch (e) {
        lastErr = e;
        const msg = (e as Error)?.message ?? '';
        if (/404/i.test(msg)) { if (this.debug) console.log('[profile:url] 404', url); continue; }
        if (this.debug) console.log('[profile:url] err', url, msg);
        throw e;
      }
    }
    if (!profiles.length) throw lastErr || new Error('Failed to fetch profile.json for any component-derived descriptor');

    // Merge labels: prefer earlier profile entries; fill gaps or defaults (title===key)
    const merged = profiles.reduce<Record<string, { title: string; unit?: string }>>((acc, p) => {
      const map = this.buildLabels(p);
      for (const k of Object.keys(map)) {
        if (!acc[k] || acc[k].title === k) acc[k] = map[k];
      }
      return acc;
    }, Object.create(null));

    this.labelsCache.set(cacheKey, merged);
    return merged;
  }

  private enrichMessageWithLabels(
    msg: TopicMessage,
    labels: Record<string, { title: string; unit?: string }>
  ): TopicMessage & { labels: typeof labels; labeled?: any } {
    const enriched: any = { ...msg, labels };
    if (msg.json && typeof msg.json === 'object') {
      const js: any = msg.json as any;
      if (Array.isArray(js.messages)) {
        enriched.labeled = {
          messages: js.messages.map((m: any) => {
            if (!m || !Array.isArray(m.targets)) return m;
            return {
              ...m,
              targets: m.targets.map((t: any) => {
                const params = t?.parameters && typeof t.parameters === 'object' ? t.parameters : {};
                const labeledParams: Record<string, any> = {};
                for (const key of Object.keys(params)) {
                  const info = labels[key];
                  const labelKey = info?.title ?? key;
                  labeledParams[labelKey] = params[key];
                }
                return { ...t, parameters: labeledParams };
              }),
            };
          }),
        };
      }
    }
    return enriched;
  }

  // Public API methods
  getNotifications: ApiClients['app']['getNotifications'] = (opts) => this.api.app.getNotifications(opts);
  getInstallations: ApiClients['app']['getInstallations'] = (opts) => this.api.app.getInstallations(opts);
  getInstallationDetails: ApiClients['app']['getInstallationDetails'] = (id, opts) => this.api.app.getInstallationDetails(id, opts);
  getProfile: ApiClients['app']['getProfile'] = (params, opts) => this.api.app.getProfile(params, opts);
  postRegisteredDataValues: ApiClients['econet']['postRegisteredDataValues'] = (id, body, opts) => this.api.econet.postRegisteredDataValues(id, body, opts);

  getInstallationParameters = async (
    installationId: string,
    opts?: MqttStreamOptions
  ): Promise<Array<{ key: string; title: string; unit?: string }>> => {
    const labels = await this.ensureLabels(installationId, opts?.profile);
    return Object.keys(labels)
      .sort()
      .map((key) => ({ key, title: labels[key]?.title ?? key, unit: labels[key]?.unit }));
  };

  installationNotifications$ = (installationId: string, opts?: MqttStreamOptions) =>
    defer(() => Promise.all([this.ensureMqtt(), this.ensureLabels(installationId, opts?.profile)])).pipe(
      switchMap(([{ connection }, labels]) =>
        streamInstallationNotifications$(connection, installationId).pipe(
          map((msg) => this.enrichMessageWithLabels(msg, labels))
        )
      )
    );

  installationResponse$ = (installationId: string, customClientId?: string, opts?: MqttStreamOptions) =>
    defer(() => Promise.all([this.ensureMqtt(), this.ensureLabels(installationId, opts?.profile)])).pipe(
      switchMap(([{ connection, clientId }, labels]) =>
        streamInstallationResponse$(connection, installationId, customClientId ?? clientId).pipe(
          map((msg) => this.enrichMessageWithLabels(msg, labels))
        )
      )
    );

  /**
   * Publish an installationRequest message to ask the device/cloud for data.
   * Note: The exact payload structure depends on the device/profile. Provide a body matching your target.
   */
  sendInstallationRequest = async (installationId: string, body: unknown, clientIdOverride?: string): Promise<void> => {
    const { connection, clientId } = await this.ensureMqtt();
    await publishInstallationRequest(connection, installationId, clientIdOverride ?? clientId, body);
  };

  /** Resolve all parameters for installation and request their values in chunks. */
  requestAllValues = async (
    installationId: string,
    opts?: {
      componentId?: string;
      chunkSize?: number;
      transactionStart?: number;
      profile?: ProfileSelector;
      clientIdOverride?: string;
    }
  ): Promise<number> => {
    const labels = await this.ensureLabels(installationId, opts?.profile);
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return 0;

    let component = opts?.componentId;
    if (!component) {
      const details = await this.getInstallationDetails(installationId);
      component = (details.components || []).find((c: any) => !!c?.componentFn)?.componentFn as string | undefined;
    }
    if (!component) throw new Error('Cannot determine componentId to request values for');

  const chunkSize = Math.max(1, Math.trunc(opts?.chunkSize ?? this.defaultChunkSize));
    let tx = Math.trunc(opts?.transactionStart ?? 1000);
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await this.requestValues(installationId, component, chunk, String(tx++), opts?.clientIdOverride);
    }
    return keys.length;
  };

  /** Convenience: publish GET_COMPONENTS_ON_BUS */
  requestComponentsOnBus = async (
    installationId: string,
    transactionId = '1',
    clientIdOverride?: string
  ): Promise<void> => {
    await this.sendInstallationRequest(installationId, { transactionId, operations: [{ name: 'GET_COMPONENTS_ON_BUS' }] }, clientIdOverride);
  };

  /** Convenience: publish GET_VALUES for selected component and parameters */
  requestValues = async (
    installationId: string,
    componentId: string,
    parameters: string[],
    transactionId = '2',
    clientIdOverride?: string
  ): Promise<void> => {
    const body = {
      transactionId,
      operations: [
        {
          name: 'GET_VALUES',
          targets: [
            {
              component: componentId,
              parameters,
            },
          ],
        },
      ],
    } as const;
    await this.sendInstallationRequest(installationId, body, clientIdOverride);
  };

  /**
   * Discover components and request initial values. If componentId/parameters are not provided,
   * picks the first component from installation details and requests a small default set.
   */
  primeInstallation = async (
    installationId: string,
    opts?: {
      componentId?: string;
      parameters?: string[];
      transactionIds?: { discover?: string; values?: string };
      clientIdOverride?: string;
    }
  ): Promise<void> => {
    const discoverId = opts?.transactionIds?.discover ?? '1';
    const valuesId = opts?.transactionIds?.values ?? '2';
    await this.requestComponentsOnBus(installationId, discoverId, opts?.clientIdOverride);
    let component = opts?.componentId;
    if (!component) {
      try {
        const details = await this.getInstallationDetails(installationId);
        const first = (details.components || []).find((c: any) => !!c?.componentFn);
        component = (first?.componentFn as string | undefined) ?? undefined;
      } catch {}
    }
    const params = opts?.parameters ?? ['u6342', 'u6338', 'u81'];
    if (component) {
      await this.requestValues(installationId, component, params, valuesId, opts?.clientIdOverride);
    }
  };
}

export async function EcoNetAPIClient(init: EcoNetInit): Promise<EcoNetAPIClient> {
  return EcoNetClient.create(init);
}
