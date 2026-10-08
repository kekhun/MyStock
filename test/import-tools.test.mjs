import test from "node:test";
import assert from "node:assert/strict";
import { applyImport, planImport, importShares, escapeHtml } from "../public/import-core.js";
import { compareSnapshots, createSiteTools, portfolioView, registerSiteTools } from "../public/site-tools.js";

const categories = [{ id: "core", name: "大盤", archived: false }, { id: "inactive", archived: true }];
const holding = { id: "a", broker: "IB", symbol: "VOO", name: "Vanguard", quoteSymbol: "VOO", market: "US", currency: "USD", categoryId: "core", shares: 10, archived: false };
const holdings = [holding, { ...holding, id: "b", broker: "E*TRADE", shares: 3 }];
const row = (shares = 12) => ({ broker: "IB", symbol: "VOO", shares });
const defaults = { categoryId: "core", broker: "台新" };
const makeId = () => "new-id";

test("import updates total shares, retains metadata and omitted brokers, never mutates inputs", () => {
  const plan = planImport([row()], holdings, categories);
  assert.equal(plan[0].delta, 2);
  const next = applyImport(holdings, categories, plan.map((r) => r.change), makeId);
  assert.equal(next[0].shares, 12);
  assert.equal(next[0].name, "Vanguard");
  assert.equal(next[1].shares, 3);
  assert.equal(holdings[0].shares, 10);
});

test("new broker, Taiwan zero prefix, decimals, reductions and zero positions", () => {
  const plan = planImport([{ symbol: "50", shares: "1,000.125" }, row(0)], holdings, categories, defaults);
  assert.equal(plan[0].symbol, "0050");
  assert.equal(plan[0].change.currency, "TWD");
  assert.equal(plan[1].delta, -10);
  const next = applyImport(holdings, categories, plan.map((r) => r.change), makeId);
  assert.equal(next[0].shares, 0);
  assert.equal(next.at(-1).shares, 1000.125);
  assert.equal(next.at(-1).archived, false);
});

test("reject malformed, negative, blank, short, scientific and incorrectly grouped quantities", () => {
  for (const value of ["", " ", "-1", "1e3", "1,2", "1張", "=3+2", Infinity, "0.123456789"]) assert.throws(() => importShares(value));
  assert.equal(importShares("0.12345678"), 0.12345678);
  assert.equal(importShares("1,234,567.25"), 1234567.25);
  const tiny = planImport([row("0.00000001")], holdings, categories)[0].change;
  assert.equal(applyImport(holdings, categories, [tiny], makeId)[0].shares, 0.00000001);
  assert.throws(() => importShares(0.000000001));
});

test("duplicate and archived holdings are blocked; invalid batches never partially apply", () => {
  const duplicate = planImport([row(), row(14)], holdings, categories);
  assert.ok(duplicate.every((r) => r.status === "error" && !r.selected));
  assert.equal(planImport([row()], [...holdings, { ...holding, id: "dup" }], categories)[0].status, "error");
  assert.equal(planImport([row()], [{ ...holding, archived: true }], categories)[0].status, "error");
  const good = planImport([row()], holdings, categories)[0].change;
  assert.throws(() => applyImport(holdings, categories, [good, { broker: "new", symbol: "AMBA", shares: -2 }], makeId));
  assert.equal(holding.shares, 10);
});

test("stale preview, removed/archived holding, conflicting currency and inactive new category are blocked", () => {
  const change = planImport([row()], holdings, categories)[0].change;
  assert.throws(() => applyImport([{ ...holding, shares: 11 }], categories, [change], makeId), /重新預覽/);
  assert.throws(() => applyImport([], categories, [change], makeId), /重新預覽/);
  assert.equal(planImport([{ ...row(), currency: "TWD" }], holdings, categories)[0].status, "error");
  assert.equal(planImport([{ broker: "A", symbol: "AMBA", shares: 3, categoryId: "inactive" }], holdings, categories)[0].status, "error");
  const newChange = planImport([{ ...row(), broker: "new" }], holdings, categories)[0].change;
  assert.throws(() => applyImport([...holdings, { ...holding, broker: "new", id: "c" }], categories, [newChange], makeId));
});

test("untrusted labels are escaped and prototype names rejected", () => {
  assert.equal(escapeHtml('<img onerror="x">'), "&lt;img onerror=&quot;x&quot;&gt;");
  assert.equal(planImport([{ ...row(), broker: "__proto__" }], holdings, categories)[0].status, "error");
});

const snapshot = (id, date, shares, valueTwd) => ({ id, date, totals: { twd: valueTwd }, bySymbol: { VOO: { shares, valueTwd, valueNative: valueTwd / 30, currency: "USD", price: 100, brokers: { IB: valueTwd } } } });
const snapshots = [snapshot("b", "2026-02-01", 15, 45000), snapshot("a", "2026-01-01", 10, 30000)];
test("snapshot comparison sorts dates and compares actual recorded total shares", () => {
  const result = compareSnapshots(snapshots);
  assert.equal(result.start.id, "a");
  assert.equal(result.end.id, "b");
  assert.equal(result.valueChangeTwd, 15000);
  assert.equal(result.stocks[0].sharesChange, 5);
  assert.equal(result.stocks[0].valueNativeAfter, 1500);
  assert.throws(() => compareSnapshots(snapshots, "b", "a"));
  assert.throws(() => compareSnapshots([snapshots[0]]));
});
test("total-only history is unknown detail, not zero shares; removed stock is zero only with full snapshots", () => {
  const old = { id: "old", date: "2025-01-01", totals: { twd: 100 } };
  const result = compareSnapshots([old, snapshots[0]]);
  assert.equal(result.stocks, null);
  assert.equal(result.valueChangeTwd, 44900);
  const closed = { id: "closed", date: "2026-03-01", totals: { twd: 0 }, bySymbol: {} };
  assert.equal(compareSnapshots([snapshots[0], closed]).stocks[0].sharesAfter, 0);
});

const portfolio = { holdings: holdings.map((h) => ({ ...h, price: 100, valueNative: h.shares * 100, valueTwd: h.shares * 3000 })), allCategories: categories, prices: { fx: { USDTWD: { rate: 30 } } }, snapshots, settings: { alphaVantageApiKey: "secret" } };
test("position query consolidates cross-broker holdings and never exposes settings or secrets", () => {
  const result = portfolioView(portfolio, { symbol: "NASDAQ:VOO" });
  assert.equal(result.merged[0].shares, 13);
  assert.equal(result.merged[0].brokers.length, 2);
  assert.equal(result.valueTwd, 39000);
  assert.equal(portfolioView(portfolio, { broker: "IB" }).valueTwd, 30000);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("Site tools register with feature detection and adjustment/import only stage changes", async () => {
  let adjustments = 0; let imports = 0;
  const callbacks = { getPortfolio: async () => portfolio, showAdjustment: () => adjustments++, previewImport: () => { imports++; return { awaitingUserConfirmation: true }; } };
  const tools = createSiteTools(callbacks);
  const adjustment = tools.find((tool) => tool.name === "mystock_preview_adjustment");
  const result = await adjustment.execute({ holdingId: "a", amount: 2, direction: "decrease" });
  assert.equal(result.sharesAfter, 8);
  assert.equal(result.awaitingUserConfirmation, true);
  assert.equal(adjustments, 1);
  assert.ok((await adjustment.execute({ holdingId: "a", amount: 20, direction: "decrease" })).error);
  assert.equal(adjustments, 1);
  await tools.find((tool) => tool.name === "mystock_preview_import").execute({ rows: [row()] });
  assert.equal(imports, 1);
  assert.equal(holding.shares, 10);
  assert.equal(await registerSiteTools(callbacks, {}), false);
  const registered = [];
  assert.equal(await registerSiteTools(callbacks, { registerTool: (tool) => registered.push(tool) }), true);
  assert.equal(registered.length, 5);
});
