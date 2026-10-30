export const partnerBankOptions = [
  { code: "NATIONAL", slug: "national", name: "National Bank" },
  { code: "STATE", slug: "state", name: "State Bank" },
  { code: "HOLY", slug: "holy", name: "Holy Bank" },
] as const;

export type PartnerBankCode = (typeof partnerBankOptions)[number]["code"];
export type PartnerBankSlug = (typeof partnerBankOptions)[number]["slug"];

type PartnerBankConfig = {
  code: PartnerBankCode;
  slug: PartnerBankSlug;
  name: string;
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
};

const environmentByCode = {
  NATIONAL: ["NATIONAL_BANK_API_KEY", "NATIONAL_BANK_WEBHOOK_SECRET"],
  STATE: ["STATE_BANK_API_KEY", "STATE_BANK_WEBHOOK_SECRET"],
  HOLY: ["HOLY_BANK_API_KEY", "HOLY_BANK_WEBHOOK_SECRET"],
} as const satisfies Record<PartnerBankCode, readonly [string, string]>;

export function partnerBankCodeFromSlug(value: string): PartnerBankCode | null {
  return partnerBankOptions.find((bank) => bank.slug === value)?.code ?? null;
}

export function partnerBankSlug(code: PartnerBankCode): PartnerBankSlug {
  return partnerBankOptions.find((bank) => bank.code === code)!.slug;
}

export function getPartnerBankConfig(code: PartnerBankCode): PartnerBankConfig {
  const option = partnerBankOptions.find((bank) => bank.code === code)!;
  const [apiKeyName, webhookSecretName] = environmentByCode[code];
  const apiKey = process.env[apiKeyName];
  const webhookSecret = process.env[webhookSecretName];
  if (!apiKey || !webhookSecret) throw new Error(`Missing ${apiKeyName} or ${webhookSecretName}`);

  return {
    ...option,
    apiKey,
    webhookSecret,
    baseUrl: (process.env.BANK_SIMULATOR_URL ?? "http://127.0.0.1:4001").replace(/\/$/, ""),
  };
}
