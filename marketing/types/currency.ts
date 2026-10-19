export const SUPPORTED_CURRENCIES = ["usd", "eur"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
