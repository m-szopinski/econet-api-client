import { createApiClients, ApiClients } from '../services/api.js';
import { loginWithCognitoSRP } from '../services/cognitoLogin.js';
import { getCognitoIdentityCredentials } from '../services/cognitoIdentity.js';
import { createSigv4Fetcher } from '../services/sigv4Fetch.js';
import {
  installationNotifications$ as streamNotifications$,
  installationResponse$ as streamResponse$,
  sendInstallationRequest as publishRequest,
  TopicMessage,
} from '../iot/streams.js';
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

export type MqttStreamOptions = { profile?: ProfileSelector };

export type EcoNetInit = {
  username: string;
  password: string;
  region: string;
  userPoolId: string;
  clientId: string;
  identityPoolId: string;
  /** WebSocket MQTT endpoint: wss://xxx-ats.iot.<region>.amazonaws.com/mqtt */
  iotEndpoint: string;
  appBaseUrl: string;
  econetBaseUrl: string;
  siteBaseUrl?: string;
  /** Language code for parameter labels, e.g. 'pl', 'en'. Defaults to 'en'. */
  lang?: string;
  debug?: boolean;
  fetcher?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  defaultValuesChunkSize?: number;
};

export type EcoNetAPIClient = {
  getInstallations: ApiClients['app']['getInstallations'];
  getInstallationDetails: ApiClients['app']['getInstallationDetails'];
  getNotifications: ApiClients['app']['getNotifications'];
  getProfile: ApiClients['app']['getProfile'];
  getTranslations: ApiClients['app']['getTranslations'];
  postRegisteredDataValues: ApiClients['econet']['postRegisteredDataValues'];
  /** Lists all known parameters (key + human label) by loading component profiles + translations. */
  getInstallationParameters: (id: string, opts?: MqttStreamOptions) => Promise<Array<{ key: string; title: string; unit?: string }>>;
  getPahoConnectionInfo: (clientIdOverride?: string) => Promise<PahoConnectionInfo>;
  installationNotifications$: (id: string, opts?: MqttStreamOptions) => Observable<TopicMessage>;
  installationResponse$: (id: string, clientId?: string, opts?: MqttStreamOptions) => Observable<TopicMessage>;
  sendInstallationRequest: (id: string, body: unknown, clientIdOverride?: string) => Promise<void>;
  requestComponentsOnBus: (id: string, transactionId?: string, clientIdOverride?: string) => Promise<void>;
  requestValues: (id: string, componentId: string, parameters: string[], transactionId?: string, clientIdOverride?: string) => Promise<void>;
  /** Set parameter values via PARAMS_MODIFICATION. Values must be strings. Status "0"/"16" = accepted. */
  setValues: (id: string, componentId: string, values: Record<string, string>, transactionId?: string, clientIdOverride?: string) => Promise<void>;
  requestAllValues: (id: string, opts?: { componentId?: string; chunkSize?: number; transactionStart?: number; profile?: ProfileSelector; clientIdOverride?: string }) => Promise<number>;
  raw: ApiClients;
  accessToken: string;
  idToken: string;
};

type Labels = Record<string, { title: string; unit?: string }>;
type Conn = { connection: MqttLikeConnection; clientId: string };

const REQUIRED_FIELDS = ['username', 'password', 'region', 'userPoolId', 'clientId', 'identityPoolId', 'iotEndpoint', 'appBaseUrl', 'econetBaseUrl'] as const;

export class EcoNetClient {
  private region!: string;
  private api!: ApiClients;
  private mqttConn: Promise<Conn> | null = null;
  private labelsCache = new Map<string, Labels>();
  private credentials!: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  private identityId?: string;
  private iotEndpoint!: string;
  private siteBaseUrl?: string;
  private lang = 'en';
  private chunkSize = 100;
  private debug = false;

  accessToken!: string;
  idToken!: string;
  raw!: ApiClients;

  private constructor() {}

  static async create(init: EcoNetInit): Promise<EcoNetClient> {
    const self = new EcoNetClient();

    // Node/Homey: ensure HOME exists and skip shared AWS config file
    if (typeof window === 'undefined') {
      try {
        if (!process.env.HOME && !process.env.USERPROFILE) process.env.HOME = '/tmp';
        process.env.AWS_SDK_LOAD_CONFIG ??= '0';
      } catch {}
    }

    for (const k of REQUIRED_FIELDS) if (!init[k]) throw new Error(`${k} is required`);

    const { username, password, region, userPoolId, clientId, identityPoolId,
            iotEndpoint, appBaseUrl, econetBaseUrl, siteBaseUrl, lang, debug, fetcher, defaultValuesChunkSize } = init;

    self.region = region;
    self.iotEndpoint = iotEndpoint;
    self.siteBaseUrl = siteBaseUrl;
    self.lang = lang ?? 'en';
    self.debug = !!debug;
    if (Number.isFinite(defaultValuesChunkSize) && (defaultValuesChunkSize as number) > 0)
      self.chunkSize = Math.trunc(defaultValuesChunkSize as number);

    const { accessToken, idToken } = await loginWithCognitoSRP({ username, password, userPoolId, clientId, region });
    self.accessToken = accessToken;
    self.idToken = idToken;

    const identity = await getCognitoIdentityCredentials({ idToken, identityPoolId, userPoolId, region });
    self.credentials = {
      accessKeyId: identity.credentials.AccessKeyId,
      secretAccessKey: identity.credentials.SecretKey,
      sessionToken: identity.credentials.SessionToken,
    };
    self.identityId = identity.identityId;

    const sigv4Fetcher = createSigv4Fetcher({
      region,
      service: 'execute-api',
      credentials: self.credentials,
      signHosts: [new URL(appBaseUrl).hostname],
    });

    self.api = createApiClients({
      fetcher: fetcher ?? sigv4Fetcher,
      appBaseUrl,
      econetBaseUrl,
      siteBaseUrl,
      defaultHeaders: () => ({ appid: '0' }),
    });
    self.raw = self.api;
    return self;
  }

  private ensureMqtt(): Promise<Conn> {
    return (this.mqttConn ??= (async () => {
      const info = await this.getPahoConnectionInfo();
      const { connectAwsIotPaho } = await import('../iot/mqttPaho.js') as any;
      const connection: MqttLikeConnection = await connectAwsIotPaho({
        endpoint: this.iotEndpoint,
        region: this.region,
        clientId: info.clientId,
        credentials: this.credentials,
        origin: info.recommended.origin,
      });
      if (this.debug) console.log('[MQTT] connected');
      return { connection, clientId: info.clientId };
    })());
  }

  getPahoConnectionInfo = async (clientIdOverride?: string): Promise<PahoConnectionInfo> => {
    const info = buildPahoConnectionInfo({
      endpoint: this.iotEndpoint,
      region: this.region,
      credentials: this.credentials,
      clientId: clientIdOverride ?? generateClientId(this.region, this.identityId),
      origin: this.siteBaseUrl,
    });
    if (this.debug) console.log('[PAHO]', { host: info.host, clientId: info.clientId, url: info.presignedUrlRedacted });
    return info;
  };

  private buildLabels(profile: ProfileJson): Labels {
    const labels: Labels = Object.create(null);
    const record = (key: string, node: any) => {
      labels[key] = {
        title: typeof node.title === 'string' ? node.title : labels[key]?.title ?? key,
        unit: typeof node.unit === 'string' ? node.unit : labels[key]?.unit,
      };
    };
    const visit = (n: any): void => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n === 'object') {
        if (typeof n.parameterName === 'string') record(n.parameterName, n);
        if (typeof n.parameter === 'string') record(n.parameter, n);
        for (const k in n) visit(n[k]);
      }
    };
    try { visit(profile); } catch {}
    return labels;
  }

  /** Fetch translations for a profile descriptor, falling back to 'en' on error. */
  private async fetchTranslations(a: { producerCode: string; deviceName: string; firmware: string; schema: string }): Promise<Record<string, string>> {
    const tryLang = async (lang: string) => {
      try { return await this.api.app.getTranslations({ ...a, lang }); } catch { return null; }
    };
    return (this.lang !== 'en' ? await tryLang(this.lang) : null) ?? await tryLang('en') ?? {};
  }

  private async ensureLabels(installationId: string, selector?: ProfileSelector): Promise<Labels> {
    const cacheKey = JSON.stringify({ installationId, selector: selector ?? {}, lang: this.lang });
    if (this.labelsCache.has(cacheKey)) return this.labelsCache.get(cacheKey)!;

    const details = await this.api.app.getInstallationDetails(installationId);

    type Attempt = { producerCode: string; deviceName: string; firmware: string; schema: string };
    const seen = new Set<string>();
    const plan: Attempt[] = [];
    const addAttempt = (a: Attempt) => {
      const k = `${a.producerCode}\x01${a.deviceName}\x01${a.firmware}\x01${a.schema}`;
      if (!seen.has(k)) { seen.add(k); plan.push(a); }
    };

    if (selector?.producerCode && selector.deviceName && selector.firmware && selector.schema)
      addAttempt({ producerCode: String(selector.producerCode), deviceName: selector.deviceName, firmware: selector.firmware, schema: selector.schema });

    for (const c of (details.components ?? []) as any[]) {
      const { producerCode: pc, componentType: dn, hardwareVersion: fw, softVersion: sc } = c ?? {};
      if (pc != null && dn && fw && sc) addAttempt({ producerCode: String(pc), deviceName: dn, firmware: fw, schema: sc });
    }
    if (!plan.length) throw new Error('Cannot resolve any profile descriptor from installation components');

    const merged: Labels = Object.create(null);
    const trans: Record<string, string> = Object.create(null);
    let lastErr: unknown;

    for (const a of plan) {
      if (this.debug) console.log('[profile]', `${a.producerCode}/${a.deviceName}/${a.firmware}/${a.schema}`);
      try {
        const [profile, t] = await Promise.all([this.api.app.getProfile(a), this.fetchTranslations(a)]);
        for (const [k, v] of Object.entries(this.buildLabels(profile))) if (!merged[k] || merged[k].title === k) merged[k] = v;
        for (const [k, v] of Object.entries(t)) if (!trans[k]) trans[k] = v;
      } catch (e) {
        lastErr = e;
        if (/404/i.test((e as Error)?.message ?? '')) { if (this.debug) console.log('[profile] 404', `${a.producerCode}/${a.deviceName}`); continue; }
        throw e;
      }
    }
    if (!Object.keys(merged).length) throw lastErr ?? new Error('Failed to load any profile');

    // Apply translations: resolve title keys, then fill params known only in translations
    for (const k of Object.keys(merged)) {
      const { title } = merged[k];
      const resolved = trans[title] ?? (title === k ? trans[k] : undefined);
      if (resolved) merged[k] = { ...merged[k], title: resolved };
    }
    for (const [k, v] of Object.entries(trans)) if (!merged[k]) merged[k] = { title: v };

    this.labelsCache.set(cacheKey, merged);
    return merged;
  }

  private enrichWithLabels(msg: TopicMessage, labels: Labels): TopicMessage & { labels: Labels; labeled?: any } {
    const enriched: any = { ...msg, labels };
    const js = msg.json as any;
    if (Array.isArray(js?.messages)) {
      enriched.labeled = {
        messages: js.messages.map((m: any) => {
          if (!Array.isArray(m?.targets)) return m;
          return {
            ...m,
            targets: m.targets.map((t: any) => ({
              ...t,
              parameters: Object.fromEntries(
                Object.entries(t?.parameters ?? {}).map(([k, v]) => [labels[k]?.title ?? k, v])
              ),
            })),
          };
        }),
      };
    }
    return enriched;
  }

  // ── REST proxies ──────────────────────────────────────────────────────────
  getNotifications: ApiClients['app']['getNotifications'] = (opts) => this.api.app.getNotifications(opts);
  getInstallations: ApiClients['app']['getInstallations'] = (opts) => this.api.app.getInstallations(opts);
  getInstallationDetails: ApiClients['app']['getInstallationDetails'] = (id, opts) => this.api.app.getInstallationDetails(id, opts);
  getProfile: ApiClients['app']['getProfile'] = (p, opts) => this.api.app.getProfile(p, opts);
  getTranslations: ApiClients['app']['getTranslations'] = (p, opts) => this.api.app.getTranslations(p, opts);
  postRegisteredDataValues: ApiClients['econet']['postRegisteredDataValues'] = (id, body, opts) => this.api.econet.postRegisteredDataValues(id, body, opts);

  getInstallationParameters = async (id: string, opts?: MqttStreamOptions) => {
    const labels = await this.ensureLabels(id, opts?.profile);
    return Object.keys(labels).sort().map((key) => ({ key, title: labels[key].title, unit: labels[key].unit }));
  };

  // ── MQTT streams ──────────────────────────────────────────────────────────
  installationNotifications$ = (id: string, opts?: MqttStreamOptions) =>
    defer(() => Promise.all([this.ensureMqtt(), this.ensureLabels(id, opts?.profile)] as const)).pipe(
      switchMap(([{ connection }, labels]) =>
        streamNotifications$(connection, id).pipe(map((msg) => this.enrichWithLabels(msg, labels)))
      )
    );

  installationResponse$ = (id: string, customClientId?: string, opts?: MqttStreamOptions) =>
    defer(() => Promise.all([this.ensureMqtt(), this.ensureLabels(id, opts?.profile)] as const)).pipe(
      switchMap(([{ connection, clientId }, labels]) =>
        streamResponse$(connection, id, customClientId ?? clientId).pipe(map((msg) => this.enrichWithLabels(msg, labels)))
      )
    );

  sendInstallationRequest = async (id: string, body: unknown, clientIdOverride?: string): Promise<void> => {
    const { connection, clientId } = await this.ensureMqtt();
    await publishRequest(connection, id, clientIdOverride ?? clientId, body);
  };

  // ── MQTT operations ───────────────────────────────────────────────────────
  private sendOp = (id: string, tx: string, name: string, targets?: unknown[], override?: string) =>
    this.sendInstallationRequest(id, { transactionId: tx, operations: [targets ? { name, targets } : { name }] }, override);

  requestComponentsOnBus = (id: string, tx = '1', override?: string) =>
    this.sendOp(id, tx, 'GET_COMPONENTS_ON_BUS', undefined, override);

  requestValues = (id: string, componentId: string, parameters: string[], tx = '2', override?: string) =>
    this.sendOp(id, tx, 'GET_VALUES', [{ component: componentId, parameters }], override);

  setValues = (id: string, componentId: string, values: Record<string, string>, tx = '10', override?: string) =>
    this.sendOp(id, tx, 'PARAMS_MODIFICATION', [{ component: componentId, parameters: values }], override);

  requestAllValues = async (id: string, opts?: { componentId?: string; chunkSize?: number; transactionStart?: number; profile?: ProfileSelector; clientIdOverride?: string }): Promise<number> => {
    const labels = await this.ensureLabels(id, opts?.profile);
    const keys = Object.keys(labels).sort();
    if (!keys.length) return 0;

    const component = opts?.componentId
      ?? (await this.getInstallationDetails(id)).components?.find((c: any) => c?.componentFn)?.componentFn;
    if (!component) throw new Error('Cannot determine componentId to request values for');

    const chunk = Math.max(1, Math.trunc(opts?.chunkSize ?? this.chunkSize));
    let tx = Math.trunc(opts?.transactionStart ?? 1000);
    for (let i = 0; i < keys.length; i += chunk)
      await this.requestValues(id, component, keys.slice(i, i + chunk), String(tx++), opts?.clientIdOverride);
    return keys.length;
  };

}

export const EcoNetAPIClient = (init: EcoNetInit): Promise<EcoNetAPIClient> => EcoNetClient.create(init);
