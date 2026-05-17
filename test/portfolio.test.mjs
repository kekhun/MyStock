import assert from "node:assert/strict";
import { buildPortfolio, normalizeSymbol } from "../server.mjs";

const categories = [
  { id: "core", name: "核心", color: "#111111", order: 1, archived: false },
  { id: "bond", name: "債券", color: "#222222", order: 2, archived: false },
];

const prices = {
  fx: { USDTWD: { rate: 30, asOf: "2026-01-01", source: "test" } },
  quotes: {
    VOO: { price: 100, currency: "USD", asOf: "2026-01-01", source: "test" },
    TLT: { price: 90, currency: "USD", asOf: "2026-01-01", source: "test" },
    "0050": { price: 200, currency: "TWD", asOf: "2026-01-01", source: "test" },
  },
};

const holdings = [
  { id: "a", broker: "A", name: "VOO", symbol: "VOO", quoteSymbol: "VOO", market: "US", currency: "USD", shares: 2, categoryId: "core", archived: false },
  { id: "b", broker: "B", name: "VOO", symbol: "NASDAQ:VOO", quoteSymbol: "VOO", market: "US", currency: "USD", shares: 3, categoryId: "core", archived: false },
  { id: "c", broker: "A", name: "0050", symbol: "0050", quoteSymbol: "0050", market: "TW", currency: "TWD", shares: 10, categoryId: "core", archived: false },
  { id: "d", broker: "A", name: "TLT", symbol: "TLT", quoteSymbol: "TLT", market: "US", currency: "USD", shares: 1, categoryId: "bond", archived: true },
];

assert.equal(normalizeSymbol("NASDAQ:VOO"), "VOO");
assert.equal(normalizeSymbol("TPE:006208"), "006208");
assert.equal(normalizeSymbol("00679B.TW"), "00679B");

const portfolio = buildPortfolio({
  holdings,
  categories,
  prices,
  snapshots: [],
  settings: { alphaVantageApiKey: "secret", cacheQuotesForHours: 12 },
});

assert.equal(portfolio.holdings.length, 3);
assert.equal(portfolio.archivedHoldings.length, 1);
assert.equal(portfolio.totals.usdNative, 500);
assert.equal(portfolio.totals.twdNative, 2000);
assert.equal(portfolio.totals.twd, 17000);
assert.equal(portfolio.totals.byCategory.core, 17000);
assert.equal(portfolio.totals.byBroker.A, 8000);
assert.equal(portfolio.totals.byBroker.B, 9000);
assert.equal(portfolio.totals.byMarket["美股"], 15000);
assert.equal(portfolio.totals.byMarket["台股"], 2000);
assert.equal(portfolio.totals.bySymbol.VOO.shares, 5);
assert.equal(portfolio.totals.bySymbol.VOO.valueTwd, 15000);
assert.equal(portfolio.settings.alphaVantageApiKey, "********");

console.log("portfolio tests passed");
