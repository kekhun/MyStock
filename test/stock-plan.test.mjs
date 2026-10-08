import assert from "node:assert/strict";
import test from "node:test";
import { brokerAccountLabel, extractStockPlan } from "../public/stock-plan.js";
import { applyImport, planImport } from "../public/import-core.js";
import { buildPortfolio } from "../server.mjs";

const rs = { name: "Restricted Stock", rows: [
  ["Record Type", "Symbol", "Unvested Qty.", "Sellable Qty.", "Est. Market Value"],
  ["Grant", "AMBA", "1000", "57", "$99,999"],
  ["Grant", "AMBA", "1000", "369", "$99,999"],
  ["Totals", "", "2000", "426", "$199,998"],
] };
const espp = { name: "ESPP", rows: [
  ["Record Type", "Symbol", "Purchased Qty.", "Sellable Qty."],
  ["Purchase", "AMBA", "104", "104"],
  ["Purchase", "AMBA", "82", "82"],
  ["Totals", "", "186", "186"],
] };
const options = { name: "Options", rows: [["Record Type", "Symbol", "Exercisable Qty.", "Sellable Qty."], ["Grant", "AMBA", "100", "0"]] };
const categories = [{ id: "company", name: "公司股票", color: "#ff0000", order: 1, archived: false }];

test("aggregates RS/ESPP separately, ignores Totals, unvested amounts, market values and options", () => {
  const result = extractStockPlan([rs, espp, options]);
  assert.deepEqual(result.rows.map(({ broker, shares }) => ({ broker, shares })), [
    { broker: "E*TRADE Stock Plan (RS)", shares: 426 },
    { broker: "E*TRADE Stock Plan (ESPP)", shares: 186 },
  ]);
  assert.equal(result.rows.reduce((sum, row) => sum + row.shares, 0), 612);
});
test("unchanged generic import detection", () => {
  assert.equal(extractStockPlan([{ name: "Positions", rows: [["symbol", "shares"], ["AMBA", 10]] }]), null);
});
test("compact account labels retain RS/ESPP distinction in charts", () => {
  assert.equal(brokerAccountLabel("E*TRADE Stock Plan (RS)"), "E*TRADE RS");
  assert.equal(brokerAccountLabel("E*TRADE Stock Plan (ESPP)"), "E*TRADE ESPP");
  assert.equal(brokerAccountLabel("E*TRADE"), "E*TRADE");
});
test("rejects total mismatches, missing/negative quantities, missing symbol and unknown rows", () => {
  for (const mutate of [
    (rows) => { rows[3][3] = "427"; },
    (rows) => { rows[1][3] = ""; },
    (rows) => { rows[1][3] = "-1"; },
    (rows) => { rows[1][1] = ""; },
    (rows) => { rows[1][0] = "Other"; },
  ]) {
    const copy = structuredClone(rs);
    mutate(copy.rows);
    assert.throws(() => extractStockPlan([copy]));
  }
  assert.throws(() => extractStockPlan([{ name: "Restricted Stock", rows: [["Symbol", "Sellable Qty."], ["AMBA", "10"]] }]));
  assert.throws(() => extractStockPlan([rs, { name: "ESPP", rows: [["Symbol", "Purchased Qty."], ["AMBA", "10"]] }]));
});
test("zero sellable stock is preserved; duplicate grant tickers aggregate within each benefit only", () => {
  const copy = structuredClone(rs);
  copy.rows[1][3] = "0"; copy.rows[2][3] = "0"; copy.rows[3][3] = "0";
  assert.equal(extractStockPlan([copy]).rows[0].shares, 0);
  assert.equal(extractStockPlan([rs, espp]).rows.length, 2);
});
test("repeat stock plan import replaces totals; archived legacy combined position is excluded", () => {
  const original = [
    { id: "general", broker: "E*TRADE", symbol: "AMBA", quoteSymbol: "AMBA", name: "AMBA", shares: 568, market: "US", currency: "USD", categoryId: "company", archived: false },
    { id: "legacy", broker: "AMBA", symbol: "AMBA", quoteSymbol: "AMBA", name: "AMBA", shares: 1060, market: "US", currency: "USD", categoryId: "company", archived: true },
  ];
  const rows = extractStockPlan([rs, espp]).rows;
  let sequence = 0;
  const next = applyImport(original, categories, planImport(rows, original, categories).map((p) => p.change), () => `plan-${sequence++}`);
  const repeated = planImport(rows, next, categories);
  assert.ok(repeated.every((p) => p.status === "unchanged"));
  const snapshots = [{ id: "old", date: "2026-01-01", totals: { twd: 100 }, bySymbol: { AMBA: { shares: 1060 } } }];
  const portfolio = buildPortfolio({ holdings: next, categories, prices: { quotes: { AMBA: { price: 60, source: "test" } }, fx: { USDTWD: { rate: 30 } } }, snapshots, settings: {} });
  assert.equal(portfolio.totals.bySymbol.AMBA.shares, 1180);
  assert.equal(portfolio.totals.bySymbol.AMBA.valueNative, 70800);
  assert.equal(portfolio.totals.bySymbol.AMBA.valueTwd, 2124000);
  assert.equal(portfolio.totals.bySymbol.AMBA.brokers["E*TRADE"], 1022400);
  assert.equal(portfolio.archivedHoldings[0].shares, 1060);
  assert.equal(portfolio.snapshots[0].bySymbol.AMBA.shares, 1060);
  assert.equal(original.length, 2);
});
