import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  appendMissingBuyRows,
  countValidPrices,
  isValidPrice,
  normalizeSymbol,
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
    [{ id: "gram", current_price: 0.00052 }, { id: "the-open-network", current_price: 0.0042 }],
    { GRAM: "gram-altcoin" },
  );
  assert.deepEqual(prices.GRAM, { price: 0.0042, ch: null, id: "the-open-network" });
  assert.equal(userMap.GRAM, undefined);
  assert.match(decodeURIComponent(urls[0]), /ids=the-open-network(?:&|$)/);
  assert.ok(urls.every((url) => !url.includes("cryptocompare")));
});

test("ONDO and PHA omissions retry markets and retain exact IDs", async () => {
  const { prices, urls } = await resolve(
    ["ONDO", "PHA"],
    {},
    [
      { id: "ondo-finance", current_price: 0.91, price_change_percentage_24h: 2 },
      { id: "pha", current_price: 0.12 },
      { id: "ondo", current_price: 99 },
    ],
  );
  assert.equal(prices.ONDO.id, "ondo-finance");
  assert.equal(prices.PHA.id, "pha");
  assert.equal(prices.ONDO.price, 0.91);
  assert.equal(prices.PHA.price, 0.12);
  assert.ok(decodeURIComponent(urls[1]).includes("ondo-finance,pha"));
});

test("STX zero and invalid prices fall back, and unresolved invalid values stay null", async () => {
  const recovered = await resolve(["STX"], { blockstack: { usd: 0 } }, [{ id: "blockstack", current_price: 1.55 }]);
  assert.deepEqual(recovered.prices.STX, { price: 1.55, ch: null, id: "blockstack" });

  for (const invalid of [0, -1, NaN, Infinity, "1"]) assert.equal(isValidPrice(invalid), false);
  const unresolved = await resolve(["STX"], { blockstack: { usd: 0 } }, [{ id: "blockstack", current_price: -2 }]);
  assert.deepEqual(unresolved.prices.STX, { price: null, ch: null, id: "blockstack" });
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

test("required pair formats normalize and only positive finite prices are counted", () => {
  for (const symbol of ["GRAM", "ONDO", "PHA", "STX", "ROOT"]) {
    assert.equal(normalizeSymbol(`${symbol}USDT`), symbol);
    assert.equal(normalizeSymbol(`${symbol}/USDT`), symbol);
  }
  assert.equal(countValidPrices([1, 0, -1, NaN, Infinity, "2", null]), 1);
  assert.equal(official.DYDX, "dydx-chain");
  assert.equal(official.A, "vaulta");
});
