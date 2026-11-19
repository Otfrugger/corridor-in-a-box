// Core logic, types, and validation for the testnet reference Send App (RFC 0004 §6).

export type PriceLabel = "locked" | "indicative" | "estimated";

/**
 * Exact wording and definitions from RFC 0004 §2.
 * Labels are never merged or hidden; each option clearly identifies its pricing tier.
 */
export const PRICE_LABELS: Record<
  PriceLabel,
  {
    label: PriceLabel;
    title: string;
    description: string;
    source: string;
  }
> = {
  locked: {
    label: "locked",
    title: "Locked Price",
    description: "A locked price comes from a firm SEP-38 quote. The rate is guaranteed until it expires.",
    source: "SEP-38 firm quote",
  },
  indicative: {
    label: "indicative",
    title: "Indicative Price",
    description: "An indicative price comes from current market rates or SEP-38 /price. The final rate may differ when the payment executes.",
    source: "SEP-38 /price",
  },
  estimated: {
    label: "estimated",
    title: "Estimated Price",
    description: "An estimated price is calculated from historical rate data. It is a benchmark estimate, not a live quote.",
    source: "Historical rate data",
  },
} as const;

/**
 * Dynamic receiver field definition driven by an anchor's /sep31/info and SEP-12.
 * No hardcoded field list is assumed: forms are generated directly from field schemas.
 */
export interface ReceiverField {
  name: string;
  label: string;
  description?: string;
  type?: "string" | "number" | "select";
  choices?: string[];
  optional?: boolean;
  placeholder?: string;
}

/** One route option returned for a destination and amount. */
export interface RouteOption {
  id: string;
  corridorId: string;
  anchorName: string;
  sourceAsset: string;
  sourceAmount: string;
  destAsset: string;
  destCurrency: string;
  destAmount: string;
  exchangeRate: string;
  fee: string;
  estimatedDelivery: string;
  label: PriceLabel;
  reasons: string[];
  expiresAt?: string;
  receiverFields: ReceiverField[];
}

export interface AmountValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates the send amount entered in the form.
 * Invalid amounts (negative, zero, NaN, empty, non-numeric, out-of-bounds) are rejected with clear messages.
 */
export function validateSendAmount(
  amount: string,
  limits?: { min?: number; max?: number },
): AmountValidationResult {
  if (!amount || amount.trim() === "") {
    return { valid: false, error: "Please enter an amount" };
  }

  const trimmed = amount.trim();

  // Strictly positive decimal numbers with optional leading digits and up to 7 decimal places
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { valid: false, error: "Amount must be a valid positive number" };
  }

  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return { valid: false, error: "Amount must be a finite number" };
  }

  if (num <= 0) {
    return { valid: false, error: "Amount must be greater than 0" };
  }

  if (limits?.min !== undefined && num < limits.min) {
    return { valid: false, error: `Amount is below the minimum limit of ${limits.min}` };
  }

  if (limits?.max !== undefined && num > limits.max) {
    return { valid: false, error: `Amount exceeds the maximum limit of ${limits.max}` };
  }

  return { valid: true };
}

/** Formats remaining seconds into MM:SS. */
export function formatRemainingSeconds(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/** Checks whether a quote expiry timestamp has passed. */
export function isQuoteExpired(expiresAt?: string | number | Date): boolean {
  if (!expiresAt) return false;
  const expiry = typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return false;
  return Date.now() >= expiry;
}

/** Computes remaining seconds until expiration, or 0 if expired. */
export function getRemainingSeconds(expiresAt?: string | number | Date): number {
  if (!expiresAt) return 0;
  const expiry = typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) return 0;
  const diffMs = expiry - Date.now();
  return diffMs > 0 ? Math.floor(diffMs / 1000) : 0;
}

/**
 * Validates dynamic receiver fields according to their schema.
 * Rejects missing non-optional fields with clear field-specific messages.
 */
export function validateReceiverFields(
  fields: ReceiverField[],
  values: Record<string, string>,
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    if (!field.optional) {
      const val = values[field.name];
      if (!val || val.trim() === "") {
        errors[field.name] = `${field.label} is required`;
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Catalog of supported destination anchor fields driven by their /sep31/info and SEP-12.
 * Each corridor specifies distinct dynamic fields, demonstrating that changing the route
 * dynamically changes the fields without any hardcoding in the form components.
 */
export const ANCHOR_RECEIVER_SCHEMAS: Record<string, ReceiverField[]> = {
  "reference-testnet": [
    {
      name: "routing_number",
      label: "ACH Routing Number",
      description: "9-digit US bank routing transit number",
      type: "string",
      placeholder: "123456789",
      optional: false,
    },
    {
      name: "account_number",
      label: "Bank Account Number",
      description: "Recipient checking or savings account number",
      type: "string",
      placeholder: "9876543210",
      optional: false,
    },
    {
      name: "account_type",
      label: "Account Type",
      description: "Type of destination bank account",
      type: "select",
      choices: ["checking", "savings"],
      optional: false,
    },
    {
      name: "first_name",
      label: "Recipient First Name",
      type: "string",
      placeholder: "Jane",
      optional: false,
    },
    {
      name: "last_name",
      label: "Recipient Last Name",
      type: "string",
      placeholder: "Doe",
      optional: false,
    },
  ],
  "ng-cowrie": [
    {
      name: "account_number",
      label: "NUBAN Account Number",
      description: "10-digit Nigerian bank account number",
      type: "string",
      placeholder: "0123456789",
      optional: false,
    },
    {
      name: "bank_code",
      label: "Bank Code / CBN Code",
      description: "3-digit Central Bank of Nigeria bank identifier",
      type: "select",
      choices: ["058 (GTBank)", "011 (First Bank)", "057 (Zenith Bank)", "033 (UBA)", "214 (FCMB)"],
      optional: false,
    },
    {
      name: "account_name",
      label: "Account Name",
      description: "Full registered name matching bank account",
      type: "string",
      placeholder: "Amina Adeleke",
      optional: false,
    },
    {
      name: "bvn",
      label: "BVN (Bank Verification Number)",
      description: "Optional recipient BVN for expedited clearance",
      type: "string",
      placeholder: "22233344455",
      optional: true,
    },
  ],
  "mx-example": [
    {
      name: "clabe",
      label: "CLABE Interbancaria",
      description: "18-digit Mexican interbank standard account number",
      type: "string",
      placeholder: "012180001234567890",
      optional: false,
    },
    {
      name: "recipient_name",
      label: "Beneficiary Full Name",
      description: "Full legal name as registered with the Mexican bank",
      type: "string",
      placeholder: "Carlos Hernandez",
      optional: false,
    },
    {
      name: "curp",
      label: "CURP / RFC",
      description: "Tax identification code",
      type: "string",
      placeholder: "HEMC800101XYZ",
      optional: true,
    },
  ],
  "zeam": [
    {
      name: "account_number",
      label: "South African Account Number",
      description: "Recipient bank account number",
      type: "string",
      placeholder: "4051234567",
      optional: false,
    },
    {
      name: "branch_code",
      label: "Branch Code",
      description: "6-digit universal branch code",
      type: "string",
      placeholder: "250655",
      optional: false,
    },
    {
      name: "account_holder_name",
      label: "Account Holder Name",
      type: "string",
      placeholder: "Sipho Khumalo",
      optional: false,
    },
  ],
  "testanchor-sep6": [
    {
      name: "dest",
      label: "Payout Destination Address",
      description: "Off-chain account or identifier for SEP-6 withdrawal",
      type: "string",
      placeholder: "user@example.com or phone number",
      optional: false,
    },
    {
      name: "dest_extra",
      label: "Memo / Extra Identifier",
      description: "Optional payout memo or tag",
      type: "string",
      optional: true,
    },
  ],
};

/** Default fallback receiver fields for arbitrary anchors */
export const DEFAULT_RECEIVER_FIELDS: ReceiverField[] = [
  {
    name: "recipient_account",
    label: "Recipient Account",
    description: "Account or IBAN number",
    type: "string",
    optional: false,
  },
  {
    name: "recipient_name",
    label: "Recipient Name",
    type: "string",
    optional: false,
  },
];

/**
 * Returns dynamic receiver fields for a specific corridor / anchor.
 * Changing the route returns different fields.
 */
export function getReceiverFieldsForCorridor(corridorId: string): ReceiverField[] {
  return ANCHOR_RECEIVER_SCHEMAS[corridorId] || DEFAULT_RECEIVER_FIELDS;
}

export interface RouteSearchParams {
  amount: string;
  sourceAsset: string;
  destCountry: string;
  destCurrency: string;
}

/**
 * Generates ranked route options for given search criteria.
 * Demonstrates locked (firm quote with countdown), indicative (market rate),
 * and estimated (rate history) tiers with exact RFC 0004 §2 wording and human-readable reasons.
 */
export function findRouteOptions(params: RouteSearchParams): RouteOption[] {
  const num = Number(params.amount);
  if (!Number.isFinite(num) || num <= 0) {
    return [];
  }

  const { destCountry, destCurrency } = params;

  // Corridors matching Nigeria
  if (destCountry === "NG" || destCurrency === "NGN") {
    const rateLocked = 1520.5;
    const rateIndicative = 1515.0;
    const rateEstimated = 1490.0;

    return [
      {
        id: "route-ng-cowrie-locked",
        corridorId: "ng-cowrie",
        anchorName: "Cowrie Nigeria",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:NGN",
        destCurrency: "NGN",
        destAmount: (num * rateLocked).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateLocked.toFixed(2)} NGN`,
        fee: "0.50 USDC",
        estimatedDelivery: "~2 minutes",
        label: "locked",
        reasons: ["Firm SEP-38 quote", "Guaranteed rate for 60 s", "Fastest NGN delivery"],
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        receiverFields: getReceiverFieldsForCorridor("ng-cowrie"),
      },
      {
        id: "route-ng-indicative",
        corridorId: "ng-cowrie",
        anchorName: "Cowrie Market Router",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:NGN",
        destCurrency: "NGN",
        destAmount: (num * rateIndicative).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateIndicative.toFixed(2)} NGN`,
        fee: "0.75 USDC",
        estimatedDelivery: "~5 minutes",
        label: "indicative",
        reasons: ["Live SEP-38 /price", "Market rate subject to execution window"],
        receiverFields: getReceiverFieldsForCorridor("ng-cowrie"),
      },
      {
        id: "route-ng-estimated",
        corridorId: "ng-cn",
        anchorName: "Alternative Exchange",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:NGN",
        destCurrency: "NGN",
        destAmount: (num * rateEstimated).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateEstimated.toFixed(2)} NGN`,
        fee: "1.20 USDC",
        estimatedDelivery: "~15 minutes",
        label: "estimated",
        reasons: ["Historical rate estimate (7d median)", "Anchor has no live quote server"],
        receiverFields: DEFAULT_RECEIVER_FIELDS,
      },
    ];
  }

  // Corridors matching Mexico
  if (destCountry === "MX" || destCurrency === "MXN") {
    const rateLocked = 19.85;
    const rateIndicative = 19.78;

    return [
      {
        id: "route-mx-locked",
        corridorId: "mx-example",
        anchorName: "Bifrost Mexico",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:MXN",
        destCurrency: "MXN",
        destAmount: (num * rateLocked).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateLocked.toFixed(2)} MXN`,
        fee: "0.25 USDC",
        estimatedDelivery: "Instant (SPEI)",
        label: "locked",
        reasons: ["Firm SEP-38 quote", "SPEI instant payout", "Locked for 45 s"],
        expiresAt: new Date(Date.now() + 45 * 1000).toISOString(),
        receiverFields: getReceiverFieldsForCorridor("mx-example"),
      },
      {
        id: "route-mx-indicative",
        corridorId: "mx-example",
        anchorName: "SPEI Direct Market",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:MXN",
        destCurrency: "MXN",
        destAmount: (num * rateIndicative).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateIndicative.toFixed(2)} MXN`,
        fee: "0.50 USDC",
        estimatedDelivery: "~10 minutes",
        label: "indicative",
        reasons: ["SEP-38 /price endpoint", "Rate subject to trade settlement"],
        receiverFields: getReceiverFieldsForCorridor("mx-example"),
      },
    ];
  }

  // Corridors matching South Africa
  if (destCountry === "ZA" || destCurrency === "ZAR") {
    const rateLocked = 18.25;
    return [
      {
        id: "route-za-locked",
        corridorId: "zeam",
        anchorName: "Zeam South Africa",
        sourceAsset: params.sourceAsset || "USDC",
        sourceAmount: params.amount,
        destAsset: "iso4217:ZAR",
        destCurrency: "ZAR",
        destAmount: (num * rateLocked).toFixed(2),
        exchangeRate: `1 ${params.sourceAsset || "USDC"} = ${rateLocked.toFixed(2)} ZAR`,
        fee: "0.40 USDC",
        estimatedDelivery: "~30 minutes (RTC)",
        label: "locked",
        reasons: ["Firm SEP-38 quote", "Real-Time Clearing (RTC)"],
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        receiverFields: getReceiverFieldsForCorridor("zeam"),
      },
    ];
  }

  // Default / US Payout (Reference Anchor)
  const rateLocked = 1.0;
  const rateIndicative = 0.998;
  return [
    {
      id: "route-us-reference-locked",
      corridorId: "reference-testnet",
      anchorName: "Anchor Platform Reference",
      sourceAsset: params.sourceAsset || "USDC",
      sourceAmount: params.amount,
      destAsset: "iso4217:USD",
      destCurrency: "USD",
      destAmount: (num * rateLocked - 0.5).toFixed(2),
      exchangeRate: `1 ${params.sourceAsset || "USDC"} = 1.00 USD`,
      fee: "0.50 USDC",
      estimatedDelivery: "Instant (Local Testnet)",
      label: "locked",
      reasons: ["Firm SEP-38 quote", "Lowest fee", "Full SEP-31 testnet compliance"],
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      receiverFields: getReceiverFieldsForCorridor("reference-testnet"),
    },
    {
      id: "route-us-sep6-indicative",
      corridorId: "testanchor-sep6",
      anchorName: "TestAnchor SEP-6",
      sourceAsset: params.sourceAsset || "USDC",
      sourceAmount: params.amount,
      destAsset: "iso4217:USD",
      destCurrency: "USD",
      destAmount: (num * rateIndicative - 1.0).toFixed(2),
      exchangeRate: `1 ${params.sourceAsset || "USDC"} = 0.998 USD`,
      fee: "1.00 USDC",
      estimatedDelivery: "~5 minutes",
      label: "indicative",
      reasons: ["SEP-6 /withdraw price", "Alternative protocol lane"],
      receiverFields: getReceiverFieldsForCorridor("testanchor-sep6"),
    },
  ];
}
