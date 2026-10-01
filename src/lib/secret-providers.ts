/*
 * External secret managers. A variable references a secret as ${{secrets.<name>.<path>}} or
 * ${{secrets.<name>.<path>:<FIELD>}}; Serve fetches it when the service deploys.
 */

export const SECRET_PROVIDER_KINDS = ["vault", "infisical", "doppler", "aws-secrets", "aws-parameters"] as const;
export type SecretProviderKind = (typeof SECRET_PROVIDER_KINDS)[number];

export type SecretProviderConfig = {
  /** Vault and Infisical: the server's address. */
  url?: string;
  /** Vault: the KV secrets engine's mount and version, and the Enterprise namespace. */
  mount?: string;
  kvVersion?: 1 | 2;
  namespace?: string;
  /** Infisical: project ID and environment slug. */
  projectId?: string;
  environment?: string;
  /** Doppler: project and config, when the token is not a service token for one config. */
  project?: string;
  config?: string;
  /** AWS: region. */
  region?: string;
};

export type SecretProviderCredentials = {
  token?: string;
  clientId?: string;
  clientSecret?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

export type SecretProviderAccess = { projectIds: string[]; environmentIds: string[] };

type Field = { key: keyof SecretProviderConfig | keyof SecretProviderCredentials; label: string; placeholder?: string; secret?: boolean; optional?: boolean; help?: string };

export const SECRET_PROVIDERS: Record<
  SecretProviderKind,
  { label: string; fields: Field[] /** How a reference's path and field are read, shown with an example. */; format: string; example: string }
> = {
  vault: {
    label: "HashiCorp Vault / OpenBao",
    fields: [
      { key: "url", label: "Vault URL", placeholder: "https://vault.example.com:8200" },
      { key: "token", label: "Token", secret: true },
      { key: "mount", label: "KV mount", placeholder: "secret", optional: true },
      { key: "namespace", label: "Namespace", placeholder: "admin", optional: true, help: "Vault Enterprise and HCP only." },
    ],
    format: "<path/to/secret>:<FIELD>",
    example: "app/db:password",
  },
  infisical: {
    label: "Infisical",
    fields: [
      { key: "url", label: "Infisical URL", placeholder: "https://app.infisical.com", optional: true, help: "Leave empty for Infisical Cloud (US)." },
      { key: "clientId", label: "Machine identity client ID", help: "Universal Auth. Give the identity read access to the project." },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "projectId", label: "Project ID" },
      { key: "environment", label: "Environment slug", placeholder: "prod" },
    ],
    format: "<folder/>SECRET_NAME",
    example: "DATABASE_URL",
  },
  doppler: {
    label: "Doppler",
    fields: [
      { key: "token", label: "Service token", secret: true, help: "A service token reads one config, so project and config can stay empty." },
      { key: "project", label: "Project", optional: true },
      { key: "config", label: "Config", placeholder: "prd", optional: true },
    ],
    format: "SECRET_NAME",
    example: "DATABASE_URL",
  },
  "aws-secrets": {
    label: "AWS Secrets Manager",
    fields: [
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "accessKeyId", label: "Access key ID", help: "Needs secretsmanager:GetSecretValue." },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
      { key: "sessionToken", label: "Session token", secret: true, optional: true },
    ],
    format: "<secret-name>[:<JSON key>]",
    example: "prod/app:password",
  },
  "aws-parameters": {
    label: "AWS Parameter Store",
    fields: [
      { key: "region", label: "Region", placeholder: "us-east-1" },
      { key: "accessKeyId", label: "Access key ID", help: "Needs ssm:GetParameter, and kms:Decrypt for SecureString." },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
      { key: "sessionToken", label: "Session token", secret: true, optional: true },
    ],
    format: "</parameter/name>",
    example: "/prod/app/db-password",
  },
};

export const CREDENTIAL_KEYS = new Set<string>(["token", "clientId", "clientSecret", "accessKeyId", "secretAccessKey", "sessionToken"]);

export const providerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The scope name in references: ${{secrets.<name>.<path>}}. */
export const SECRETS_SCOPE = "secrets";

export const secretReference = (name: string, path: string) => `\${{${SECRETS_SCOPE}.${name}.${path}}}`;

/** `<name>.<path>[:<field>]` (a reference after "secrets.") split up, or null when malformed. */
export function parseSecretRef(rest: string): { provider: string; path: string; field: string | null } | null {
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const provider = rest.slice(0, dot).toLowerCase();
  const tail = rest.slice(dot + 1);
  const colon = tail.lastIndexOf(":");
  const path = colon === -1 ? tail : tail.slice(0, colon);
  const field = colon === -1 ? null : tail.slice(colon + 1);
  if (!path || field === "") return null;
  return { provider, path, field };
}

/** Whether a provider may be used by a service in this project and environment. */
export function providerAllows(access: SecretProviderAccess, projectId: string, environmentId: string, environmentProject: (id: string) => string | undefined) {
  if (access.projectIds.length && !access.projectIds.includes(projectId)) return false;
  const listedHere = access.environmentIds.filter((id) => environmentProject(id) === projectId);
  return !listedHere.length || listedHere.includes(environmentId);
}
