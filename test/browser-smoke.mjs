import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mystock-smoke-"));
const artifacts = process.env.MYSTOCK_TEST_ARTIFACTS || path.join(temp, "screenshots");
let server;
let browser;
const categories = [{ id: "core", name: "核心大盤", color: "#1f6feb", order: 1, archived: false }];
const base = { symbol: "VOO", name: "VOO", quoteSymbol: "VOO", market: "US", currency: "USD", categoryId: "core", archived: false };
const holdings = [{ ...base, id: "a", broker: "IB", shares: 10 }, { ...base, id: "b", broker: "E*TRADE", shares: 8 }];
const snapshots = [{ id: "old", date: "2025-01-01", totals: { twd: 30000 }, source: "imported-total-only" }];
try {
  await fs.cp(path.join(root, "public"), path.join(temp, "public"), { recursive: true });
  for (const name of ["server.mjs", "store.mjs"]) await fs.copyFile(path.join(root, name), path.join(temp, name));
  await fs.mkdir(path.join(temp, "data"));
  await fs.mkdir(artifacts, { recursive: true });
  const documents = { holdings, categories, snapshots, settings: { cacheQuotesForMinutes: 10, alphaVantageApiKey: "test-secret-never-expose" }, prices: { fx: { USDTWD: { rate: 30, asOf: "2026-01-01", source: "test" } }, quotes: { VOO: { price: 100, asOf: "2026-01-01", source: "test" } } } };
  for (const [name, value] of Object.entries(documents)) await fs.writeFile(path.join(temp, "data", `${name}.json`), JSON.stringify(value));
  const { createServer } = await import(pathToFileURL(path.join(temp, "server.mjs")));
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  // The host bridge is simulated here. Real client discovery is checked separately.
  await page.addInitScript(() => {
    window.registeredSiteTools = {};
    Object.defineProperty(document, "modelContext", { value: { registerTool(tool) { window.registeredSiteTools[tool.name] = tool; } } });
  });
  await page.goto(url);
  await page.waitForFunction(() => Object.keys(window.registeredSiteTools).length === 5);
  assert.equal(await page.locator("#holdingsRows .holding-row").count(), 2);
  const view = await page.evaluate(() => window.registeredSiteTools.mystock_get_positions.execute({ symbol: "VOO" }));
  assert.equal(view.merged[0].shares, 18);
  assert.ok(!JSON.stringify(view).includes("test-secret"));
  const comparison = await page.evaluate(() => window.registeredSiteTools.mystock_compare_snapshots.execute({}));
  assert.ok(comparison.error);

  const height = await page.locator("#timelineChart").evaluate((el) => el.getBoundingClientRect().height);
  for (const period of ["ytd", "12m", "6m", "all", "all"]) {
    await page.locator(`[data-period="${period}"]`).click();
    assert.ok(Math.abs(await page.locator("#timelineChart").evaluate((el) => el.getBoundingClientRect().height) - height) < 1);
  }
  await page.locator('[data-tab="holdings"]').click();
  await page.locator("#importPositions").click();
  const csv = "broker,symbol,shares,name,market,currency\nIB,VOO,12,VOO,US,USD\nE*TRADE,VOO,6,VOO,US,USD\n台新,0050,100,台灣50,TW,TWD\nIB,AMBA,3,AMBA,US,USD\nIB,AMBA,4,AMBA,US,USD\n";
  await page.locator("#positionFile").setInputFiles({ name: "positions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForFunction(() => document.getElementById("importRows").children.length === 5);
  await page.locator("#importCategory").selectOption("core");
  assert.equal(await page.locator("#importRows tr.import-row-error").count(), 2);
  assert.equal(await page.locator("#importRows input:checked").count(), 3);
  await page.locator('#importRows [data-import-row="1"]').uncheck();
  assert.match(await page.locator("#applyImport").innerText(), /2/);
  await page.locator("#selectImportRows").click();
  await page.screenshot({ path: path.join(artifacts, "import-desktop.png"), fullPage: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#applyImport").click();
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, "data/holdings.json")))[0].shares, 10);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#applyImport").click();
  await page.waitForFunction(() => document.getElementById("importMessage").textContent.includes("已套用 3"));
  let saved = JSON.parse(await fs.readFile(path.join(temp, "data/holdings.json")));
  assert.deepEqual(saved.map((h) => h.shares), [12, 6, 100]);
  assert.equal(saved[2].symbol, "0050");
  assert.equal(saved[2].currency, "TWD");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, "data/snapshots.json"))), snapshots);
  assert.equal(await page.locator("#applyImport").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.XLSX.version), "0.20.3");
  const workbook = await page.evaluate(() => {
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet([["備註"], ["broker", "symbol", "shares"], ["IB", "VOO", 14]]), "部位");
    return Array.from(new Uint8Array(window.XLSX.write(book, { type: "array", bookType: "xlsx" })));
  });
  await page.locator("#positionFile").setInputFiles({ name: "positions.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(workbook) });
  await page.waitForFunction(() => document.getElementById("importHeader").value === "1" && document.getElementById("importRows").children.length === 1);
  assert.match(await page.locator("#importRows").innerText(), /14/);
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, "data/holdings.json")))[0].shares, 12);
  const preview = await page.evaluate(() => window.registeredSiteTools.mystock_preview_adjustment.execute({ holdingId: "a", direction: "decrease", amount: 2 }));
  assert.equal(preview.sharesAfter, 10);
  assert.equal(await page.locator("#adjustHoldingDialog").isVisible(), true);
  await page.locator("#cancelAdjustHolding").click();
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, "data/holdings.json")))[0].shares, 12);
  await page.evaluate(() => window.registeredSiteTools.mystock_preview_import.execute({ rows: [{ broker: "IB", symbol: "VOO", shares: 13 }] }));
  await page.locator("#applyImport").waitFor({ state: "visible" });
  assert.match(await page.locator("#importRows").innerText(), /13/);

  // Direct API stale-preview rejection preserves every row and existing snapshots.
  const response = await fetch(url + "/api/holdings/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ ...holdings[0], expectedShares: 10, shares: 20 }] }) });
  assert.equal(response.status, 409);
  saved = JSON.parse(await fs.readFile(path.join(temp, "data/holdings.json")));
  assert.equal(saved[0].shares, 12);

  // Big5 CSV, including broker labels and padded Taiwan ticker.
  const big5csv = Buffer.concat([Buffer.from("broker,symbol,shares,market\n"), Buffer.from([0xa5, 0x78, 0xb7, 0x73]), Buffer.from(",0050,120,TW\n")]);
  await page.locator("#positionFile").setInputFiles({ name: "big5.csv", mimeType: "text/csv", buffer: big5csv });
  await page.locator("#importEncoding").selectOption("big5");
  await page.waitForFunction(() => document.getElementById("importRows").textContent.includes("台新"));
  assert.match(await page.locator("#importRows").innerText(), /0050/);

  // Stock Plan file: aggregate grants within RS/ESPP, never aggregate across accounts.
  const stockBook = await page.evaluate(() => {
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet([
      ["Record Type", "Symbol", "Unvested Qty.", "Sellable Qty.", "Est. Market Value"],
      ["Grant", "AMBA", 9999, 57, 999999], ["Grant", "AMBA", 9999, 369, 999999],
      ["Totals", "", 19998, 426, 1999998],
    ]), "Restricted Stock");
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet([
      ["Record Type", "Symbol", "Purchased Qty.", "Sellable Qty."],
      ["Purchase", "AMBA", 104, 104], ["Purchase", "AMBA", 82, 82], ["Totals", "", 186, 186],
    ]), "ESPP");
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet([
      ["Record Type", "Symbol", "Exercisable Qty.", "Sellable Qty."], ["Grant", "AMBA", 100, 0],
    ]), "Options");
    return Array.from(new Uint8Array(window.XLSX.write(book, { type: "array", bookType: "xlsx" })));
  });
  const generalResponse = await fetch(url + "/api/holdings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ broker: "E*TRADE", symbol: "AMBA", shares: 568, categoryId: "core", currency: "USD", market: "US" }) });
  assert.equal(generalResponse.status, 201);
  await page.locator("#recheckImport").click();
  await page.locator("#positionFile").setInputFiles({ name: "ByBenefitType_collapsed.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(stockBook) });
  await page.waitForFunction(() => document.getElementById("importMessage").textContent.includes("RS 可出售 426") && document.getElementById("importRows").children.length === 2);
  assert.equal(await page.locator("#importMapping").isVisible(), false);
  assert.equal(await page.locator("#importRows input:checked").count(), 2);
  await page.screenshot({ path: path.join(artifacts, "stock-plan-desktop.png"), fullPage: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#applyImport").click();
  await page.waitForFunction(() => document.getElementById("importMessage").textContent.includes("已套用 2"));
  const mergedAmba = await page.evaluate(() => window.registeredSiteTools.mystock_get_positions.execute({ symbol: "AMBA" }));
  assert.equal(mergedAmba.merged[0].shares, 1180);
  assert.equal(mergedAmba.merged[0].brokers.length, 3);
  assert.equal(await page.locator("#applyImport").isDisabled(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, "data/snapshots.json"))), snapshots);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, "stock-plan-mobile.png"), fullPage: true });
  await page.screenshot({ path: path.join(artifacts, "import-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const overflow = await page.locator(".import-table-wrap").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(overflow.scroll > overflow.client);
  await page.locator('[data-tab="holdings"]').click();
  await page.screenshot({ path: path.join(artifacts, "holdings-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(`Browser smoke passed: CSV/XLSX/Big5/Stock Plan, confirmation/cancel, API validation, merged AMBA 1180, tool previews, timeline dimensions, desktop/mobile. Screenshots: ${artifacts}`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
