// Hand-authored friendly REST client with sensible types and names.
// Replaces usage of auto-generated api.generated.ts so it can be removed later.

export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

// Default fetcher falls back to global fetch.
const defaultFetcher: Fetcher = (input: RequestInfo, init?: RequestInit) => fetch(input, init);

export type AuthHeadersProvider = () => Promise<Record<string, string>> | Record<string, string>;

// -------- Types (cleaned-up names) --------
export type UserNotificationsResponse = {
  success: boolean;
  data?: {
    maintenance?: { fromDate?: string; toDate?: string };
    invitations?: unknown | null;
    accessRequests?: unknown[];
  };
};

export type InstallationDetailsResponse = {
  installationInfo?: {
    id?: string;
    isConnected?: boolean;
    hasAlarms?: boolean;
    name?: string;
    softVersion?: string;
    hardwareVersion?: string;
    factoryNumber?: string;
    producerCode?: number;
    producerName?: string;
    premiumExpires?: string;
    typeId?: number;
    protocol?: string;
    customName?: string;
    update?: { version?: string; location?: string };
    weatherEnabled?: number;
    energyTariffStatus?: number;
    electricityTariffDetails?: Record<string, unknown>;
  };
  components?: Array<{
    installationId?: string;
    componentFn?: string;
    isHidden?: boolean;
    typeId?: number;
    componentType?: string;
    softVersion?: string;
    producerName?: string;
    producerCode?: number;
    hardwareVersion?: string;
    protocol?: string;
    hasRadioModule?: boolean;
  }>;
};

export type RegisteredDataValuesRequest = {
  range?: string[]; // [fromISO, toISO]
  targets?: Array<{
    factoryNumber?: string;
    parameters?: string[];
  }>;
};

export type RegisteredDataValuesResponse = {
  installation?: string;
  components?: Array<{
    factoryNumber?: string;
    parameters?: Array<{
      key?: string;
      timestamps?: number[];
      values?: number[];
      isDownsampled?: boolean;
    }>;
  }>;
};

export type GetInstallationsResponse = Array<{
  id: string;
  name: string;
  factoryNumber: string;
  customName?: string;
  hardwareVersion?: string;
  softVersion?: string;
  hasAccess?: boolean;
  isConnected?: boolean;
  hasAlarms?: boolean;
  producerCode?: number;
  protocol?: string;
}>;

// -------- Profile JSON types (based on sample) --------
export type Visibility = {
  conditions: unknown[];
  conjunction: 'AND' | 'OR';
};

export type ValueDescriptor = {
  title?: string;
  icon?: string;
  parameterName?: string;
  unit?: string;
  format?: string;
  step?: number;
  precision?: number;
  tooltipText?: string;
  options?: Record<string, { description?: string } & Record<string, unknown>>;
  visibility?: Visibility;
  actualValueInModal?: boolean;
};

export type Tile = {
  title?: string;
  type?: number;
  quickEdition?: { editParam?: ValueDescriptor };
  setValue?: ValueDescriptor;
  actualValue?: ValueDescriptor;
  editionSettings?: { id: string; enabled: boolean | null };
} & Record<string, unknown>;

export type EditionScreen = {
  title: string;
  id: string;
  barParams: ValueDescriptor[];
  tiles: Tile[];
  type?: number;
};

export type Chart = {
  title: string;
  type: number; // 0 = numeric, 1 = options
  parameterName: string;
  unit?: string;
  precision?: number;
  options?: Record<string, { description?: string } & Record<string, unknown>>;
};

export type Schedule = {
  title: string;
  id: string;
  type: string; // e.g., "ECOVENT"
  rangeParamSequences: string[][];
  options: Record<string, { description?: string } & Record<string, unknown>>;
};

export type Alarms = {
  descriptions: Array<{
    code: string;
    description: string;
    longDescription?: string;
  }>;
};

export type AdvancedAccessLevel = {
  groups: number[];
  password?: string;
};

export type AdvancedParameterGroup = {
  title: string;
  type: number;
  id: string;
  accessGroup: number;
  children: unknown[];
};

export type AdvancedParameters = {
  access: Record<string, AdvancedAccessLevel>;
  parameters: AdvancedParameterGroup[];
};

export type ProfileJson = {
  tiles: Tile[];
  barParams: ValueDescriptor[];
  editionScreens: EditionScreen[];
  schedules: Schedule[];
  schemas: unknown[];
  charts: Chart[];
  alarms: Alarms;
  advancedParameters: AdvancedParameters;
  notifications: unknown[];
  wizards: unknown[];
  profileColor: string;
};

export type TranslationsJson = Record<string, string>;

export type ApiClients = {
  app: {
    // GET /user/getNotifications
    getNotifications: (opts?: { headers?: Record<string, string> }) => Promise<UserNotificationsResponse>;

    // GET /get-installations
    getInstallations: (opts?: { headers?: Record<string, string> }) => Promise<GetInstallationsResponse>;

    // GET /getInstallationDetailsV2/{installationId}
    getInstallationDetails: (
      installationId: string,
      opts?: { headers?: Record<string, string> }
    ) => Promise<InstallationDetailsResponse>;

    // GET /profiles/{producerCode}/{deviceName}/{firmware}/{schema}/web/profile.json
    getProfile: (
      params: {
        producerCode: string | number;
        deviceName: string; // e.g. "ecoVENT MINI OEM"
        firmware: string; // e.g. "H3.4.0"
        schema: string; // e.g. "S001.38"
      },
      opts?: { headers?: Record<string, string> }
    ) => Promise<ProfileJson>;

    // GET /profiles/{producerCode}/{deviceName}/{firmware}/{schema}/web/trans_{lang}.json
    getTranslations: (
      params: {
        producerCode: string | number;
        deviceName: string;
        firmware: string;
        schema: string;
        lang: string; // e.g. 'pl', 'en'
      },
      opts?: { headers?: Record<string, string> }
    ) => Promise<TranslationsJson>;
  };
  econet: {
    // POST /api/v2/registereddata/values/{installationId}
    postRegisteredDataValues: (
      installationId: string,
      body: RegisteredDataValuesRequest,
      opts?: { headers?: Record<string, string> }
    ) => Promise<RegisteredDataValuesResponse>;
  };
};

export function createApiClients(config?: {
  fetcher?: Fetcher;
  appBaseUrl?: string;
  econetBaseUrl?: string;
  siteBaseUrl?: string; // optional, reserved for future use
  defaultHeaders?: AuthHeadersProvider; // e.g., supply Authorization headers
}): ApiClients {
  const fetcher = config?.fetcher ?? defaultFetcher;
  if (!config?.appBaseUrl) throw new Error('createApiClients requires appBaseUrl');
  if (!config?.econetBaseUrl) throw new Error('createApiClients requires econetBaseUrl');
  const appBase = config.appBaseUrl;
  const econetBase = config.econetBaseUrl;
  const _siteBase = config.siteBaseUrl; // not used yet, but accepted for completeness
  const defaultHeadersProvider = config?.defaultHeaders;

  // helper to merge default headers
  const withDefaultHeaders = async (
    headers?: Record<string, string>
  ): Promise<Record<string, string> | undefined> => {
    if (!defaultHeadersProvider) return headers;
    const dh = await defaultHeadersProvider();
    return { ...(headers ?? {}), ...dh };
  };

  return {
    app: {
      /** Returns notification summary for current user. */
      async getNotifications(opts) {
        const headers = await withDefaultHeaders(opts?.headers);
        const res = await fetcher(`${appBase}/user-get-notifications`, { method: 'GET', headers });
        if (!res.ok) throw new Error(`GET /user-get-notifications failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<UserNotificationsResponse>;
      },

      /** Returns installations available for the current user. */
      async getInstallations(opts) {
        const headers = await withDefaultHeaders(opts?.headers);
        const res = await fetcher(`${appBase}/get-installations`, { method: 'GET', headers });
        if (!res.ok) throw new Error(`GET /get-installations failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<GetInstallationsResponse>;
      },

      /** Returns installation details and component list. */
      async getInstallationDetails(installationId: string, opts) {
        if (!installationId) throw new Error("installationId is required");
        const headers = await withDefaultHeaders(opts?.headers);
        const url = `${appBase}/get-installation-details-V2/${encodeURIComponent(installationId)}`;
        const res = await fetcher(url, { method: 'GET', headers });
        if (!res.ok) throw new Error(`GET /get-installation-details-V2/{id} failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<InstallationDetailsResponse>;
      },

      /** Returns profile JSON for a specific installation/device/firmware/schema. */
      async getProfile(params, opts) {
        const { producerCode, deviceName, firmware, schema } = params ?? ({} as any);
        if (producerCode === undefined || producerCode === null || producerCode === '') {
          throw new Error("producerCode is required");
        }
        if (!deviceName) throw new Error("deviceName is required");
        if (!firmware) throw new Error("firmware is required");
        if (!schema) throw new Error("schema is required");
        const headers = await withDefaultHeaders(opts?.headers);
        const url = `${appBase}/profiles/${encodeURIComponent(String(producerCode))}/${encodeURIComponent(deviceName)}/${encodeURIComponent(firmware)}/${encodeURIComponent(schema)}/web/profile.json`;
        const res = await fetcher(url, { method: 'GET', headers });
        if (!res.ok) throw new Error(`GET /profiles/{producer}/{name}/{fw}/{schema}/web/profile.json failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<ProfileJson>;
      },

      /** Returns translations JSON for a specific profile and language. */
      async getTranslations(params, opts) {
        const { producerCode, deviceName, firmware, schema, lang } = params ?? ({} as any);
        if (producerCode === undefined || producerCode === null || producerCode === '') {
          throw new Error("producerCode is required");
        }
        if (!deviceName) throw new Error("deviceName is required");
        if (!firmware) throw new Error("firmware is required");
        if (!schema) throw new Error("schema is required");
        if (!lang) throw new Error("lang is required");
        const headers = await withDefaultHeaders(opts?.headers);
        const url = `${appBase}/profiles/${encodeURIComponent(String(producerCode))}/${encodeURIComponent(deviceName)}/${encodeURIComponent(firmware)}/${encodeURIComponent(schema)}/web/trans_${encodeURIComponent(lang)}.json`;
        const res = await fetcher(url, { method: 'GET', headers });
        if (!res.ok) throw new Error(`GET /profiles/{producer}/{name}/{fw}/{schema}/web/trans_${lang}.json failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<TranslationsJson>;
      },
    },

    econet: {
      /** Returns time-series values for selected registered parameters. */
      async postRegisteredDataValues(installationId: string, body: RegisteredDataValuesRequest, opts) {
        if (!installationId) throw new Error("installationId is required");
        const headers = await withDefaultHeaders(opts?.headers);
        const url = `${econetBase}/api/v2/registereddata/values/${encodeURIComponent(installationId)}`;
        const res = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(headers ?? {}) },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`POST /api/v2/registereddata/values/{id} failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<RegisteredDataValuesResponse>;
      },
    },
  };
}

