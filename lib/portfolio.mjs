export function normalizeSymbol(raw) {
  if (!raw) return "";
  let symbol = raw.toUpperCase().trim().replace(/\(.*?\)/g, "").replace(/\s+/g, "");
  symbol = symbol.replace(/[^A-Z0-9]/g, "");
  while (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    symbol = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol.slice(0, -3);
  }
  return symbol;
}

export function isValidPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function appendMissingBuyRows(summary, buys, excludedSymbols = new Set()) {
  const present = new Set(summary.map((row) => normalizeSymbol(row.token)));
  return summary.concat(buys.filter((row) => {
    const symbol = normalizeSymbol(row.token);
    return !present.has(symbol) && !excludedSymbols.has(symbol);
  }));
}

function numberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/,/g, "").trim();
  const number = Number.parseFloat(text);
  if (Number.isFinite(number)) return number;
  if (!text.startsWith("=")) return null;
  const expression = text.slice(1).trim();
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) return null;
  try {
    // Workbook formulas without cached values are limited to simple arithmetic.
    const result = Function(`"use strict"; return (${expression});`)();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

const HEADER_NAMES = {
  token: new Set(["token", "symbol", "coin", "asset", "pair", "ticker"]),
  buy: new Set(["buy", "buyprice", "price", "averageprice", "avgprice"]),
  qty: new Set(["qty", "quantity", "amount", "units", "coins"]),
  leftover: new Set(["leftover", "remaining", "remainder"]),
};

function headerName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumns(rows, required) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 25); rowIndex++) {
    const columns = {};
    for (let column = 0; column < (rows[rowIndex]?.length ?? 0); column++) {
      const name = headerName(rows[rowIndex][column]);
      for (const [field, names] of Object.entries(HEADER_NAMES)) {
        if (names.has(name) && columns[field] == null) columns[field] = column;
      }
    }
    if (required.every((field) => columns[field] != null)) return { rowIndex, columns };
  }
  return null;
}

function findSheet(workbook, name) {
  const sheetName = workbook.SheetNames.find(
    (candidate) => candidate.trim().toLowerCase() === name.toLowerCase(),
  );
  return sheetName ? workbook.Sheets[sheetName] : null;
}

function displayToken(raw) {
  const symbol = normalizeSymbol(String(raw ?? ""));
  return symbol ? `${symbol}/USDT` : "";
}

function parseSummary(XLSX, workbook) {
  const sheet = findSheet(workbook, "Summary") ?? workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const detected = findColumns(rows, ["token", "buy", "qty"]);
  const columns = detected?.columns ?? { token: 0, buy: 1, qty: 3, spent: 4 };
  const start = detected ? detected.rowIndex + 1 : 1;
  const output = [];
  const summarySymbols = new Set();
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    const token = displayToken(row?.[columns.token]);
    const buy = numberOrNull(row?.[columns.buy]);
    if (!token || buy == null) continue;
    const symbol = normalizeSymbol(token);
    summarySymbols.add(symbol);
    const originalQty = numberOrNull(row?.[columns.qty]);
    const leftoverCell = columns.leftover == null ? null : row?.[columns.leftover];
    const hasLeftover = leftoverCell != null && String(leftoverCell).trim() !== "";
    const currentQty = hasLeftover ? numberOrNull(leftoverCell) : originalQty;
    if (currentQty == null || currentQty <= 0) continue;
    output.push({
      token,
      buy,
      qty: currentQty,
      spent: currentQty * buy,
    });
  }
  return summarySymbols.size > 0 ? { rows: output, summarySymbols } : null;
}

function parseBuys(XLSX, workbook) {
  const sheet = findSheet(workbook, "Buys");
  if (!sheet) throw new Error("Sheet 'Buys' not found");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const detected = findColumns(rows, ["token", "buy", "qty"]);
  const columns = detected?.columns ?? { token: 0, buy: 1, qty: 3 };
  const start = detected ? detected.rowIndex + 1 : 0;
  const aggregate = {};
  for (let index = start; index < rows.length; index++) {
    const row = rows[index];
    const symbol = normalizeSymbol(row?.[columns.token]);
    const price = numberOrNull(row?.[columns.buy]);
    const qty = numberOrNull(row?.[columns.qty]);
    if (!symbol || price == null || qty == null || qty === 0) continue;
    aggregate[symbol] ??= { qty: 0, spent: 0 };
    aggregate[symbol].qty += qty;
    aggregate[symbol].spent += price * qty;
  }
  return Object.entries(aggregate)
    .filter(([, value]) => value.qty > 0)
    .map(([symbol, value]) => ({
      token: `${symbol}/USDT`,
      buy: value.spent / value.qty,
      qty: value.qty,
      spent: value.spent,
    }));
}

/** Parse the same workbook route used by the upload UI. */
export function readPortfolioWorkbook(XLSX, workbook) {
  const summary = parseSummary(XLSX, workbook);
  if (summary) {
    const buys = findSheet(workbook, "Buys") ? parseBuys(XLSX, workbook) : [];
    return appendMissingBuyRows(summary.rows, buys, summary.summarySymbols);
  }
  return parseBuys(XLSX, workbook);
}

export function countValidPrices(prices) {
  return prices.filter(isValidPrice).length;
}

/** Resolve prices without ever losing the symbol's exact CoinGecko ID. */
export async function resolveCoinGeckoPrices({ symbols, baseMap, userMap, searchId, requestJson }) {
  const symbolToId = {};
  const nextUserMap = { ...userMap };

  for (const symbol of Object.keys(baseMap)) delete nextUserMap[symbol];
  for (const symbol of symbols) {
    if (!symbol) continue;
    const officialId = baseMap[symbol];
    if (officialId) symbolToId[symbol] = officialId;
    else if (nextUserMap[symbol]) symbolToId[symbol] = nextUserMap[symbol];
    else {
      const found = await searchId(symbol);
      if (found) symbolToId[symbol] = nextUserMap[symbol] = found;
    }
  }

  const ids = [...new Set(Object.values(symbolToId))];
  const byId = {};
  for (let index = 0; index < ids.length; index += 170) {
    const chunk = ids.slice(index, index + 170);
    try {
      const simple = await requestJson(
        `/api/coingecko/simple-price?ids=${encodeURIComponent(chunk.join(","))}` +
          "&vs_currencies=usd&include_24hr_change=true"
      );
      for (const id of chunk) {
        const item = simple?.[id];
        if (isValidPrice(item?.usd)) {
          byId[id] = {
            price: item.usd,
            ch: typeof item.usd_24h_change === "number" && Number.isFinite(item.usd_24h_change)
              ? item.usd_24h_change : null,
            id,
          };
        }
      }
    } catch {}
  }

  const missingIds = ids.filter((id) => !isValidPrice(byId[id]?.price));
  for (let index = 0; index < missingIds.length; index += 100) {
    const chunk = missingIds.slice(index, index + 100);
    try {
      const markets = await requestJson(
        `/api/coingecko/markets?vs_currency=usd&ids=${encodeURIComponent(chunk.join(","))}` +
          "&price_change_percentage=24h"
      );
      for (const item of Array.isArray(markets) ? markets : []) {
        const id = String(item?.id || "");
        // CoinGecko must return the exact requested ID; ticker similarity is irrelevant.
        if (!chunk.includes(id) || !isValidPrice(item?.current_price)) continue;
        byId[id] = {
          price: item.current_price,
          ch: typeof item.price_change_percentage_24h === "number" &&
            Number.isFinite(item.price_change_percentage_24h)
              ? item.price_change_percentage_24h : null,
          id,
        };
      }
    } catch {}
  }

  const prices = {};
  for (const symbol of symbols) {
    const id = symbolToId[symbol];
    prices[symbol] = byId[id] ?? { price: null, ch: null, id: id || "—" };
  }
  return { prices, userMap: nextUserMap };
}
