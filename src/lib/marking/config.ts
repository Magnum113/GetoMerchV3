import "server-only";

export type MarkingFulfillmentMode =
  | "jit_after_order"
  | "prebuilt_stock"
  | "pre_marked_minor_customization";
export type MarkingShippingGateMode = "observe" | "enforce";
export type MarkingCrptContour = "sandbox" | "production";
export type MarkingSignerTransport = "unix" | "remote";

export type MarkingRuntimeConfig = {
  enabled: boolean;
  importEnabled: boolean;
  labelsEnabled: boolean;
  signerEnabled: boolean;
  ozonWriteEnabled: boolean;
  crptReadEnabled: boolean;
  crptWriteEnabled: boolean;
  crptIntroductionEnabled: boolean;
  withdrawalEnabled: boolean;
  returnsEnabled: boolean;
  ozonReturnsSyncEnabled: boolean;
  suzWriteEnabled: boolean;
  justInTimeEnabled: boolean;
  automationEnabled: boolean;
  defaultFulfillmentMode: MarkingFulfillmentMode;
  shippingGateMode: MarkingShippingGateMode;
  allowedGtins: readonly string[];
  allowedOffers: readonly string[];
  allowedAdminIds: readonly string[];
  keyringFile: string;
  crptContour: MarkingCrptContour;
  crptInn: string;
  suzOmsId: string;
  suzOmsConnection: string;
  signerTransport: MarkingSignerTransport;
  signerSocketPath: string;
  signerClientId: string;
  signerClientSecretFile: string;
  signerClientsFile: string;
  signerCertificateFile: string;
  signerProviderCommand: string;
  agentSecretsFile: string;
};

export class MarkingConfigurationError extends Error {
  readonly code = "marking_configuration_error";

  constructor(message: string) {
    super(message);
    this.name = "MarkingConfigurationError";
  }
}

export function getMarkingRuntimeConfig(): MarkingRuntimeConfig {
  return parseMarkingRuntimeConfig(process.env);
}

export function parseMarkingRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): MarkingRuntimeConfig {
  const config: MarkingRuntimeConfig = {
    enabled: readBoolean(env, "GETOMERCH_MARKING_ENABLED", false),
    importEnabled: readBoolean(env, "GETOMERCH_MARKING_IMPORT_ENABLED", false),
    labelsEnabled: readBoolean(env, "GETOMERCH_MARKING_LABELS_ENABLED", false),
    signerEnabled: readBoolean(env, "GETOMERCH_MARKING_SIGNER_ENABLED", false),
    ozonWriteEnabled: readBoolean(env, "GETOMERCH_MARKING_OZON_WRITE_ENABLED", false),
    crptReadEnabled: readBoolean(env, "GETOMERCH_MARKING_CRPT_READ_ENABLED", false),
    crptWriteEnabled: readBoolean(env, "GETOMERCH_MARKING_CRPT_WRITE_ENABLED", false),
    crptIntroductionEnabled: readBoolean(
      env,
      "GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED",
      false,
    ),
    withdrawalEnabled: readBoolean(
      env,
      "GETOMERCH_MARKING_WITHDRAWAL_ENABLED",
      false,
    ),
    returnsEnabled: readBoolean(
      env,
      "GETOMERCH_MARKING_RETURNS_ENABLED",
      false,
    ),
    ozonReturnsSyncEnabled: readBoolean(
      env,
      "GETOMERCH_MARKING_OZON_RETURNS_SYNC_ENABLED",
      false,
    ),
    suzWriteEnabled: readBoolean(env, "GETOMERCH_MARKING_SUZ_WRITE_ENABLED", false),
    justInTimeEnabled: readBoolean(env, "GETOMERCH_MARKING_JUST_IN_TIME_ENABLED", false),
    automationEnabled: readBoolean(env, "GETOMERCH_MARKING_AUTOMATION_ENABLED", false),
    defaultFulfillmentMode: readEnum(
      env,
      "GETOMERCH_MARKING_DEFAULT_FULFILLMENT_MODE",
      ["jit_after_order", "prebuilt_stock", "pre_marked_minor_customization"] as const,
      "jit_after_order",
    ),
    shippingGateMode: readEnum(
      env,
      "GETOMERCH_MARKING_SHIPPING_GATE_MODE",
      ["observe", "enforce"] as const,
      "observe",
    ),
    allowedGtins: readList(env, "GETOMERCH_MARKING_ALLOWED_GTINS", normalizeGtin),
    allowedOffers: readList(env, "GETOMERCH_MARKING_ALLOWED_OFFERS", normalizeOffer),
    allowedAdminIds: readList(env, "GETOMERCH_MARKING_ALLOWED_ADMIN_IDS", normalizeAdminId),
    keyringFile: readKeyringFile(env),
    crptContour: readEnum(
      env,
      "GETOMERCH_MARKING_CRPT_CONTOUR",
      ["sandbox", "production"] as const,
      "sandbox",
    ),
    crptInn: readOptionalInn(env.GETOMERCH_MARKING_CRPT_INN),
    suzOmsId: readOptionalUuid(
      env.GETOMERCH_MARKING_SUZ_OMS_ID,
      "GETOMERCH_MARKING_SUZ_OMS_ID",
    ),
    suzOmsConnection: readOptionalUuid(
      env.GETOMERCH_MARKING_SUZ_OMS_CONNECTION,
      "GETOMERCH_MARKING_SUZ_OMS_CONNECTION",
    ),
    signerTransport: readEnum(
      env,
      "GETOMERCH_MARKING_SIGNER_TRANSPORT",
      ["unix", "remote"] as const,
      "unix",
    ),
    signerSocketPath: readAbsolutePath(
      env.GETOMERCH_MARKING_SIGNER_SOCKET,
      "/run/getomerch-marking/signer.sock",
      "GETOMERCH_MARKING_SIGNER_SOCKET",
    ),
    signerClientId: readIdentifier(
      env.GETOMERCH_MARKING_SIGNER_CLIENT_ID,
      "marking-worker",
      "GETOMERCH_MARKING_SIGNER_CLIENT_ID",
    ),
    signerClientSecretFile: readCredentialPath(
      env,
      "GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE",
      "marking-signer-client-secret",
    ),
    signerClientsFile: readCredentialPath(
      env,
      "GETOMERCH_MARKING_SIGNER_CLIENTS_FILE",
      "marking-signer-clients",
    ),
    signerCertificateFile: readCredentialPath(
      env,
      "GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE",
      "marking-signer-certificate",
    ),
    signerProviderCommand: readOptionalAbsolutePath(
      env.GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND,
      "GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND",
    ),
    agentSecretsFile: readCredentialPath(
      env,
      "GETOMERCH_MARKING_AGENT_SECRETS_FILE",
      "marking-agent-secrets",
    ),
  };

  validateMarkingRuntimeConfig(config, env);
  return Object.freeze(config);
}

export function markingConfigForHealth(config = getMarkingRuntimeConfig()) {
  return {
    stage: 13,
    enabled: config.enabled,
    importEnabled: config.importEnabled,
    labelsEnabled: config.labelsEnabled,
    signerEnabled: config.signerEnabled,
    ozonWriteEnabled: config.ozonWriteEnabled,
    crptReadEnabled: config.crptReadEnabled,
    crptWriteEnabled: config.crptWriteEnabled,
    crptIntroductionEnabled: config.crptIntroductionEnabled,
    withdrawalEnabled: config.withdrawalEnabled,
    returnsEnabled: config.returnsEnabled,
    ozonReturnsSyncEnabled: config.ozonReturnsSyncEnabled,
    suzWriteEnabled: config.suzWriteEnabled,
    justInTimeEnabled: config.justInTimeEnabled,
    automationEnabled: config.automationEnabled,
    defaultFulfillmentMode: config.defaultFulfillmentMode,
    shippingGateMode: config.shippingGateMode,
    allowedGtinCount: config.allowedGtins.length,
    allowedOfferCount: config.allowedOffers.length,
    allowedAdminCount: config.allowedAdminIds.length,
    keyringConfigured: config.keyringFile.length > 0,
    crptContour: config.crptContour,
    crptInnConfigured: config.crptInn.length > 0,
    suzOmsIdConfigured: config.suzOmsId.length > 0,
    suzOmsConnectionConfigured: config.suzOmsConnection.length > 0,
    signerTransport: config.signerTransport,
    signerSocketConfigured: config.signerSocketPath.length > 0,
    signerClientCredentialConfigured: config.signerClientSecretFile.length > 0,
    signerServerConfigured: Boolean(
      config.signerClientsFile
      && config.signerCertificateFile
      && config.signerProviderCommand
    ),
    agentCredentialConfigured: config.agentSecretsFile.length > 0,
  };
}

function validateMarkingRuntimeConfig(
  config: MarkingRuntimeConfig,
  env: Readonly<Record<string, string | undefined>>,
) {
  const dependentFlags = [
    ["GETOMERCH_MARKING_IMPORT_ENABLED", config.importEnabled],
    ["GETOMERCH_MARKING_LABELS_ENABLED", config.labelsEnabled],
    ["GETOMERCH_MARKING_SIGNER_ENABLED", config.signerEnabled],
    ["GETOMERCH_MARKING_OZON_WRITE_ENABLED", config.ozonWriteEnabled],
    ["GETOMERCH_MARKING_CRPT_READ_ENABLED", config.crptReadEnabled],
    ["GETOMERCH_MARKING_CRPT_WRITE_ENABLED", config.crptWriteEnabled],
    ["GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED", config.crptIntroductionEnabled],
    ["GETOMERCH_MARKING_WITHDRAWAL_ENABLED", config.withdrawalEnabled],
    ["GETOMERCH_MARKING_RETURNS_ENABLED", config.returnsEnabled],
    ["GETOMERCH_MARKING_OZON_RETURNS_SYNC_ENABLED", config.ozonReturnsSyncEnabled],
    ["GETOMERCH_MARKING_SUZ_WRITE_ENABLED", config.suzWriteEnabled],
    ["GETOMERCH_MARKING_JUST_IN_TIME_ENABLED", config.justInTimeEnabled],
    ["GETOMERCH_MARKING_AUTOMATION_ENABLED", config.automationEnabled],
  ] as const;

  const enabledWithoutGlobal = dependentFlags.find(([, enabled]) => enabled);
  if (!config.enabled && enabledWithoutGlobal) {
    throw new MarkingConfigurationError(
      `${enabledWithoutGlobal[0]} requires GETOMERCH_MARKING_ENABLED=true`,
    );
  }
  if (config.shippingGateMode === "enforce" && !config.enabled) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_SHIPPING_GATE_MODE=enforce requires GETOMERCH_MARKING_ENABLED=true",
    );
  }
  const keyringRequired =
    config.importEnabled
    || config.labelsEnabled
    || config.ozonWriteEnabled
    || config.crptReadEnabled
    || config.crptWriteEnabled
    || config.returnsEnabled
    || config.suzWriteEnabled
    || config.justInTimeEnabled
    || config.automationEnabled;
  if (keyringRequired && !config.keyringFile) {
    throw new MarkingConfigurationError(
      "Marking code operations require GETOMERCH_MARKING_KEYRING_FILE or a systemd credential",
    );
  }
  if (config.importEnabled && config.allowedGtins.length === 0) {
    throw new MarkingConfigurationError(
      "Marking code import requires GETOMERCH_MARKING_ALLOWED_GTINS",
    );
  }
  if (config.importEnabled && config.allowedAdminIds.length === 0) {
    throw new MarkingConfigurationError(
      "Marking code import requires GETOMERCH_MARKING_ALLOWED_ADMIN_IDS",
    );
  }
  if (config.justInTimeEnabled && config.allowedGtins.length === 0) {
    throw new MarkingConfigurationError(
      "JIT marking requires GETOMERCH_MARKING_ALLOWED_GTINS",
    );
  }
  if (config.justInTimeEnabled && config.allowedOffers.length === 0) {
    throw new MarkingConfigurationError(
      "JIT marking requires GETOMERCH_MARKING_ALLOWED_OFFERS",
    );
  }
  if (config.justInTimeEnabled && config.allowedAdminIds.length === 0) {
    throw new MarkingConfigurationError(
      "JIT marking requires GETOMERCH_MARKING_ALLOWED_ADMIN_IDS",
    );
  }
  if (config.labelsEnabled && !config.justInTimeEnabled) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_LABELS_ENABLED requires GETOMERCH_MARKING_JUST_IN_TIME_ENABLED=true",
    );
  }
  if (
    config.labelsEnabled
    && (
      config.allowedGtins.length === 0
      || config.allowedOffers.length === 0
      || config.allowedAdminIds.length === 0
    )
  ) {
    throw new MarkingConfigurationError(
      "Marking labels require GTIN, offer and administrator allow-lists",
    );
  }
  if (
    config.ozonWriteEnabled
    && (
      config.allowedOffers.length === 0
      || config.allowedGtins.length === 0
      || config.allowedAdminIds.length === 0
    )
  ) {
    throw new MarkingConfigurationError(
      "Ozon marking writes require GTIN, offer and administrator allow-lists",
    );
  }
  if (
    config.ozonWriteEnabled
    && (!hasValue(env.OZON_CLIENT_ID ?? env.OZON_CLIEN_ID) || !hasValue(env.OZON_API_KEY))
  ) {
    throw new MarkingConfigurationError(
      "Ozon marking writes require server-side Ozon client ID and API key",
    );
  }
  if ((config.crptWriteEnabled || config.suzWriteEnabled) && config.allowedGtins.length === 0) {
    throw new MarkingConfigurationError(
      "CRPT/SUZ marking writes require GETOMERCH_MARKING_ALLOWED_GTINS",
    );
  }
  if (config.suzWriteEnabled && config.allowedAdminIds.length === 0) {
    throw new MarkingConfigurationError(
      "SUZ marking writes require GETOMERCH_MARKING_ALLOWED_ADMIN_IDS",
    );
  }
  if (config.suzWriteEnabled && (!config.suzOmsId || !config.suzOmsConnection)) {
    throw new MarkingConfigurationError(
      "SUZ marking writes require OMS ID and OMS connection",
    );
  }
  if (config.suzWriteEnabled && !config.importEnabled) {
    throw new MarkingConfigurationError(
      "SUZ marking writes require GETOMERCH_MARKING_IMPORT_ENABLED=true",
    );
  }
  if ((config.crptWriteEnabled || config.suzWriteEnabled) && !config.signerEnabled) {
    throw new MarkingConfigurationError(
      "CRPT/SUZ marking writes require GETOMERCH_MARKING_SIGNER_ENABLED=true",
    );
  }
  if (
    config.crptIntroductionEnabled
    && (!config.crptWriteEnabled || !config.crptReadEnabled
      || !config.signerEnabled || !config.justInTimeEnabled)
  ) {
    throw new MarkingConfigurationError(
      "CRPT introduction requires CRPT read/write, signer and JIT marking flags",
    );
  }
  if (
    config.withdrawalEnabled
    && (!config.crptWriteEnabled || !config.crptReadEnabled
      || !config.signerEnabled || !config.justInTimeEnabled
      || !config.ozonWriteEnabled || !config.crptIntroductionEnabled)
  ) {
    throw new MarkingConfigurationError(
      "CRPT withdrawal requires introduction, CRPT read/write, signer, Ozon write and JIT flags",
    );
  }
  if (
    config.returnsEnabled
    && (!config.withdrawalEnabled || !config.crptWriteEnabled
      || !config.crptReadEnabled || !config.signerEnabled
      || !config.justInTimeEnabled)
  ) {
    throw new MarkingConfigurationError(
      "Marking returns require withdrawal, CRPT read/write, signer and JIT flags",
    );
  }
  if (
    config.returnsEnabled
    && (config.allowedGtins.length === 0
      || config.allowedOffers.length === 0
      || config.allowedAdminIds.length === 0)
  ) {
    throw new MarkingConfigurationError(
      "Marking returns require GTIN, offer and administrator allow-lists",
    );
  }
  if (config.ozonReturnsSyncEnabled && !config.returnsEnabled) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_OZON_RETURNS_SYNC_ENABLED requires GETOMERCH_MARKING_RETURNS_ENABLED=true",
    );
  }
  if (
    config.ozonReturnsSyncEnabled
    && (!hasValue(env.OZON_CLIENT_ID ?? env.OZON_CLIEN_ID) || !hasValue(env.OZON_API_KEY))
  ) {
    throw new MarkingConfigurationError(
      "Ozon return sync requires server-side Ozon client ID and API key",
    );
  }
  if (
    config.withdrawalEnabled
    && (config.allowedGtins.length === 0
      || config.allowedOffers.length === 0
      || config.allowedAdminIds.length === 0)
  ) {
    throw new MarkingConfigurationError(
      "CRPT withdrawal requires GTIN, offer and administrator allow-lists",
    );
  }
  if (
    config.crptIntroductionEnabled
    && (config.allowedGtins.length === 0 || config.allowedAdminIds.length === 0)
  ) {
    throw new MarkingConfigurationError(
      "CRPT introduction requires GTIN and administrator allow-lists",
    );
  }
  if (config.crptReadEnabled) {
    if (!config.signerEnabled) {
      throw new MarkingConfigurationError(
        "GETOMERCH_MARKING_CRPT_READ_ENABLED requires GETOMERCH_MARKING_SIGNER_ENABLED=true",
      );
    }
    if (config.allowedGtins.length === 0 || config.allowedAdminIds.length === 0) {
      throw new MarkingConfigurationError(
        "CRPT read-only checks require GTIN and administrator allow-lists",
      );
    }
    if (config.signerTransport === "unix" && !config.signerClientSecretFile) {
      throw new MarkingConfigurationError(
        "CRPT read-only checks require a signer client credential",
      );
    }
  }
  if (
    config.signerEnabled
    && config.signerTransport === "unix"
    && (!config.signerClientsFile || !config.signerCertificateFile || !config.signerProviderCommand)
  ) {
    throw new MarkingConfigurationError(
      "Signer requires client credentials, certificate metadata and a provider command",
    );
  }
  if (config.automationEnabled) {
    if (!config.justInTimeEnabled) {
      throw new MarkingConfigurationError(
        "GETOMERCH_MARKING_AUTOMATION_ENABLED requires GETOMERCH_MARKING_JUST_IN_TIME_ENABLED=true",
      );
    }
    if (!config.ozonWriteEnabled || !config.crptWriteEnabled) {
      throw new MarkingConfigurationError(
        "Marking automation requires both Ozon and CRPT write flags",
      );
    }
  }
}

function readBoolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
) {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new MarkingConfigurationError(`${name} must be true or false`);
}

function readEnum<const T extends readonly string[]>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T[number];
  throw new MarkingConfigurationError(`${name} must be one of: ${values.join(", ")}`);
}

function readList(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  normalize: (value: string) => string,
) {
  const raw = env[name]?.trim();
  if (!raw) return Object.freeze([]) as readonly string[];
  const values = raw
    .split(",")
    .map((value) => normalize(value.trim()))
    .filter(Boolean);
  return Object.freeze([...new Set(values)]);
}

function normalizeGtin(value: string) {
  if (!/^\d{14}$/.test(value)) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_ALLOWED_GTINS must contain comma-separated GTIN-14 values",
    );
  }
  return value;
}

function normalizeOffer(value: string) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_ALLOWED_OFFERS contains an invalid offer ID",
    );
  }
  return value;
}

function normalizeAdminId(value: string) {
  if (!/^[A-Za-z0-9:@._-]{1,120}$/.test(value)) {
    throw new MarkingConfigurationError(
      "GETOMERCH_MARKING_ALLOWED_ADMIN_IDS contains an invalid admin ID",
    );
  }
  return value;
}

function readKeyringFile(env: Readonly<Record<string, string | undefined>>) {
  const explicit = env.GETOMERCH_MARKING_KEYRING_FILE?.trim();
  if (explicit) {
    if (!explicit.startsWith("/")) {
      throw new MarkingConfigurationError("GETOMERCH_MARKING_KEYRING_FILE must be absolute");
    }
    return explicit;
  }
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim();
  return credentialsDirectory ? `${credentialsDirectory}/marking-keyring` : "";
}

function readCredentialPath(
  env: Readonly<Record<string, string | undefined>>,
  explicitName: string,
  credentialName: string,
) {
  const explicit = env[explicitName]?.trim();
  if (explicit) return readAbsolutePath(explicit, "", explicitName);
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim();
  return credentialsDirectory ? `${credentialsDirectory}/${credentialName}` : "";
}

function readOptionalAbsolutePath(value: string | undefined, name: string) {
  const normalized = value?.trim() ?? "";
  return normalized ? readAbsolutePath(normalized, "", name) : "";
}

function readAbsolutePath(
  value: string | undefined,
  fallback: string,
  name: string,
) {
  const normalized = value?.trim() || fallback;
  if (normalized && !normalized.startsWith("/")) {
    throw new MarkingConfigurationError(`${name} must be absolute`);
  }
  return normalized;
}

function readIdentifier(value: string | undefined, fallback: string, name: string) {
  const normalized = value?.trim() || fallback;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(normalized)) {
    throw new MarkingConfigurationError(`${name} contains an invalid identifier`);
  }
  return normalized;
}

function readOptionalInn(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  if (normalized && !/^\d{10}(?:\d{2})?$/.test(normalized)) {
    throw new MarkingConfigurationError("GETOMERCH_MARKING_CRPT_INN must contain 10 or 12 digits");
  }
  return normalized;
}

function readOptionalUuid(value: string | undefined, name: string) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (
    normalized
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new MarkingConfigurationError(`${name} must be a UUID`);
  }
  return normalized;
}

function hasValue(value: string | undefined) {
  return Boolean(value?.trim());
}
