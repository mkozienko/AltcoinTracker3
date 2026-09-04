import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  appendMissingBuyRows,
  countValidPrices,
  isValidPrice,
  normalizeSymbol,
  readPortfolioWorkbook,
  resolveCoinGeckoPrices,
} from "../lib/portfolio.mjs";

const official = JSON.parse(await readFile(new URL("../public/data/coingecko_map.json", import.meta.url)));

async function resolve(symbols, simple, markets, userMap = {}) {
  const urls = [];
  const result = await resolveCoinGeckoPrices({
    symbols,
    baseMap: official,
    userMap,
    searchId: async () => { throw new Error("official symbols must not be searched"); },
    requestJson: async (url) => {
      urls.push(url);
      return url.includes("simple-price") ? simple : markets;
    },
  });
  return { ...result, urls };
}

test("GRAM uses only its exact official CoinGecko ID", async () => {
  const { prices, userMap, urls } = await resolve(
    ["GRAM"],
    {},
    [{ id: "gram-altcoin", current_price: 0.00052 }, { id: "gram", current_price: 0.0042 }],
    { GRAM: "gram-altcoin" },
  );
  assert.deepEqual(prices.GRAM, { price: 0.0042, ch: null, id: "gram" });
  assert.equal(userMap.GRAM, undefined);
  assert.match(decodeURIComponent(urls[0]), /ids=gram(?:&|$)/);
  assert.ok(urls.every((url) => !url.includes("cryptocompare")));
});

test("ONDO and PHA omissions retry markets and retain exact IDs", async () => {
  const { prices, urls } = await resolve(
    ["ONDO", "PHA"],
    {},
    [
      { id: "ondo", current_price: 0.91, price_change_percentage_24h: 2 },
      { id: "phala-network", current_price: 0.12 },
      { id: "ondo-finance", current_price: 99 },
    ],
  );
  assert.equal(prices.ONDO.id, "ondo");
  assert.equal(prices.PHA.id, "phala-network");
  assert.equal(prices.ONDO.price, 0.91);
  assert.equal(prices.PHA.price, 0.12);
  assert.ok(decodeURIComponent(urls[1]).includes("ondo,phala-network"));
});

test("STX zero and invalid prices fall back, and unresolved invalid values stay null", async () => {
  const recovered = await resolve(["STX"], { stacks: { usd: 0 } }, [{ id: "stacks", current_price: 1.55 }]);
  assert.deepEqual(recovered.prices.STX, { price: 1.55, ch: null, id: "stacks" });

  for (const invalid of [0, -1, NaN, Infinity, "1"]) assert.equal(isValidPrice(invalid), false);
  const unresolved = await resolve(["STX"], { stacks: { usd: 0 } }, [{ id: "stacks", current_price: -2 }]);
  assert.deepEqual(unresolved.prices.STX, { price: null, ch: null, id: "stacks" });
});

test("ROOT missing from Summary is recovered from Buys without replacing Summary calculations", () => {
  const summary = [{ token: "GRAM/USDT", buy: 1, qty: 2, spent: 2 }];
  const buys = [
    { token: "GRAMUSDT", buy: 9, qty: 9, spent: 81 },
    { token: "ROOT/USDT", buy: 0.03, qty: 100, spent: 3 },
  ];
  assert.deepEqual(appendMissingBuyRows(summary, buys), [summary[0], buys[1]]);
  assert.equal(official.ROOT, "the-root-network");
});

test("MNGO pair variants use the Mango Markets CoinGecko ID", async () => {
  assert.equal(official.MNGO, "mango-markets");
  assert.equal(official.MNGOUSDT, "mango-markets");
  const { prices } = await resolve(
    ["MNGO"],
    { "mango-markets": { usd: 0.025 } },
    [],
  );
  assert.deepEqual(prices.MNGO, { price: 0.025, ch: null, id: "mango-markets" });
});

test("ROOT survives the serialized workbook import when absent from Summary", () => {
  for (const rootToken of ["ROOT", "ROOTUSDT", "ROOT/USDT"]) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Token", "Buy Price", "Ignored", "Quantity", "Spent"],
        ["GRAM/USDT", 1, null, 2, 2],
      ]),
      "Summary",
    );
    // The source Buys sheet has columns in this order; the former fixed A/B/D
    // indexes read the date as a token and never reached ROOT.
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Date", "Quantity", "Pair", "Buy Price"],
        ["2026-01-02", 9, "GRAMUSDT", 9],
        ["2026-01-03", 100, rootToken, 0.03],
      ]),
      "Buys",
    );

    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const imported = XLSX.read(bytes, { type: "buffer" });
    const rows = readPortfolioWorkbook(XLSX, imported);

    assert.deepEqual(rows, [
      { token: "GRAM/USDT", buy: 1, qty: 2, spent: 2 },
      { token: "ROOT/USDT", buy: 0.03, qty: 100, spent: 3 },
    ]);
  }
  assert.equal(official.ROOT, "the-root-network");
});

test("required pair formats normalize and only positive finite prices are counted", () => {
  for (const symbol of ["GRAM", "ONDO", "PHA", "STX", "ROOT"]) {
    assert.equal(normalizeSymbol(`${symbol}USDT`), symbol);
    assert.equal(normalizeSymbol(`${symbol}/USDT`), symbol);
  }
  assert.equal(countValidPrices([1, 0, -1, NaN, Infinity, "2", null]), 1);
  assert.equal(official.DYDX, "dydx-chain");
  assert.equal(official.A, "vaulta");
});
