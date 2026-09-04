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

export function appendMissingBuyRows(summary, buys) {
  const present = new Set(summary.map((row) => normalizeSymbol(row.token)));
  return summary.concat(buys.filter((row) => !present.has(normalizeSymbol(row.token))));
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
