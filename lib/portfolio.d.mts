export type PortfolioRow = { token: string; buy: number; qty: number; spent?: number | null };
export type PriceEntry = { price: number | null; ch: number | null; id: string };
export function normalizeSymbol(raw: string): string;
export function isValidPrice(value: unknown): value is number;
export function appendMissingBuyRows(summary: PortfolioRow[], buys: PortfolioRow[]): PortfolioRow[];
export function readPortfolioWorkbook(XLSX: any, workbook: any): PortfolioRow[];
export function countValidPrices(prices: unknown[]): number;
export function resolveCoinGeckoPrices(options: {
  symbols: string[];
  baseMap: Record<string, string>;
  userMap: Record<string, string>;
  searchId: (symbol: string) => Promise<string | null>;
  requestJson: (url: string) => Promise<any>;
}): Promise<{ prices: Record<string, PriceEntry>; userMap: Record<string, string> }>;
