import http from "node:http";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, storageMode, writeJson } from "./store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_COOKIE = "mystock_session";
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function normalizeSymbol(symbol = "") {
  return String(symbol).trim().replace(/^NASDAQ:/i, "").replace(/^TPE:/i, "").replace(/\.TW$/i, "").toUpperCase();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

async function readBody(req) {
  const raw = await readRawBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function readForm(req) {
  return Object.fromEntries(new URLSearchParams(await readRawBody(req)).entries());
}

function jsonResponse(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function downloadResponse(res, status, body, filename, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "content-disposition": `attachment; filename="${filename}"`,
  });
  res.end(body);
}

function redirectResponse(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index === -1) return [decodeURIComponent(item), ""];
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function signSession(payload) {
  return crypto.createHmac("sha256", APP_PASSWORD).update(payload).digest("base64url");
}

function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + AUTH_MAX_AGE_SECONDS * 1000 })).toString("base64url");
  const value = `${payload}.${signSession(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_MAX_AGE_SECONDS}${secure}`;
}

function clearSessionCookie() {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true;
  const value = parseCookies(req)[AUTH_COOKIE];
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || signSession(payload) !== signature) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(session.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>登入 MyStock</title>
    <link rel="stylesheet" href="/styles.css?v=20260517-1" />
  </head>
  <body class="auth-page">
    <main class="auth-shell">
      <section class="auth-panel">
        <p class="eyebrow">MyStock Tracker</p>
        <h1>登入</h1>
        <form class="edit-form auth-form" method="post" action="/login">
          <label>密碼 <input name="password" type="password" autocomplete="current-password" autofocus required /></label>
          ${error ? `<p class="auth-error">${error}</p>` : ""}
          <div class="form-actions">
            <button class="primary" type="submit">登入</button>
          </div>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

async function handleAuth(req, res, pathname) {
  if (req.method === "GET" && pathname === "/login") {
    if (isAuthenticated(req)) return redirectResponse(res, "/");
    return textResponse(res, 200, loginPage(), "text/html; charset=utf-8");
  }
  if (req.method === "POST" && pathname === "/login") {
    const body = await readForm(req);
    if (body.password === APP_PASSWORD) return redirectResponse(res, "/", { "set-cookie": sessionCookie() });
    return textResponse(res, 401, loginPage("密碼不正確"), "text/html; charset=utf-8");
  }
  if (req.method === "POST" && pathname === "/api/logout") {
    return jsonResponse(res, 200, { ok: true, loggedOut: true }, { "set-cookie": clearSessionCookie() });
  }
  return false;
}

function isPublicAsset(pathname) {
  const ext = path.extname(pathname);
  return Boolean(ext && ext !== ".html" && MIME_TYPES[ext]);
}

function parseNumber(value) {
  if (typeof value === "number") return value;
  if (value == null) return null;
  const clean = String(value).replace(/,/g, "").trim();
  if (!clean || clean === "--") return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortProviderMessage(message = "") {
  if (/premium|rate limit|25 requests per day|request per second|Thank you for using Alpha Vantage/i.test(message)) {
    return "Alpha Vantage 免費額度或頻率限制，保留上次價格";
  }
  return String(message).replace(/\s+/g, " ").slice(0, 160);
}

function getFxRate(prices) {
  return Number(prices.fx?.USDTWD?.rate || 0);
}

function holdingPrice(holding, prices) {
  const key = normalizeSymbol(holding.quoteSymbol || holding.symbol);
  return prices.quotes?.[key] || null;
}

function valueHolding(holding, prices) {
  const quote = holdingPrice(holding, prices);
  const price = Number(quote?.price || 0);
  const shares = Number(holding.shares || 0);
  const valueNative = shares * price;
  const fx = getFxRate(prices);
  const valueTwd = holding.currency === "USD" ? valueNative * fx : valueNative;
  return {
    ...holding,
    symbol: normalizeSymbol(holding.symbol),
    quoteSymbol: normalizeSymbol(holding.quoteSymbol || holding.symbol),
    price,
    priceAsOf: quote?.asOf || null,
    priceSource: quote?.source || "missing",
    valueNative,
    valueTwd,
  };
}

function addAmount(target, key, amount) {
  target[key] = (target[key] || 0) + amount;
}

export function buildPortfolio({ holdings, categories, prices, snapshots, settings }) {
  const activeCategories = categories.filter((category) => !category.archived).sort((a, b) => a.order - b.order);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const activeHoldings = holdings.filter((holding) => !holding.archived);
  const valuedHoldings = activeHoldings.map((holding) => valueHolding(holding, prices));
  const totals = {
    twd: 0,
    usdNative: 0,
    twdNative: 0,
    byCategory: {},
    byBroker: {},
    byMarket: {},
    bySymbol: {},
  };

  for (const holding of valuedHoldings) {
    totals.twd += holding.valueTwd;
    if (holding.currency === "USD") totals.usdNative += holding.valueNative;
    if (holding.currency === "TWD") totals.twdNative += holding.valueNative;
    addAmount(totals.byCategory, holding.categoryId || "uncategorized", holding.valueTwd);
    addAmount(totals.byBroker, holding.broker || "未設定券商", holding.valueTwd);
    addAmount(totals.byMarket, holding.market === "TW" ? "台股" : "美股", holding.valueTwd);
    const symbolKey = normalizeSymbol(holding.symbol);
    if (!totals.bySymbol[symbolKey]) {
      totals.bySymbol[symbolKey] = {
        symbol: symbolKey,
        name: holding.name,
        currency: holding.currency,
        categoryId: holding.categoryId,
        shares: 0,
        valueNative: 0,
        valueTwd: 0,
        price: holding.price,
        brokers: {},
      };
    }
    totals.bySymbol[symbolKey].shares += Number(holding.shares || 0);
    totals.bySymbol[symbolKey].valueNative += holding.valueNative;
    totals.bySymbol[symbolKey].valueTwd += holding.valueTwd;
    totals.bySymbol[symbolKey].price = holding.price;
    addAmount(totals.bySymbol[symbolKey].brokers, holding.broker || "未設定券商", holding.valueTwd);
  }

  const allocationRows = Object.values(totals.bySymbol)
    .map((item) => ({
      ...item,
      weight: totals.twd ? item.valueTwd / totals.twd : 0,
      categoryName: categoryMap.get(item.categoryId)?.name || "未分類",
      categoryColor: categoryMap.get(item.categoryId)?.color || "#64748b",
    }))
    .sort((a, b) => b.valueTwd - a.valueTwd);

  return {
    holdings: valuedHoldings,
    archivedHoldings: holdings.filter((holding) => holding.archived),
    categories: activeCategories,
    allCategories: categories,
    prices,
    snapshots,
    settings: { ...settings, alphaVantageApiKey: settings.alphaVantageApiKey ? "********" : "" },
    totals,
    allocationRows,
  };
}

function createSnapshot(portfolio) {
  const date = new Date();
  const isoDate = date.toISOString().slice(0, 10);
  const bySymbol = {};
  for (const symbol of Object.values(portfolio.totals.bySymbol)) {
    bySymbol[symbol.symbol] = {
      symbol: symbol.symbol,
      shares: symbol.shares,
      price: symbol.price,
      currency: symbol.currency,
      valueNative: symbol.valueNative,
      valueTwd: symbol.valueTwd,
      brokers: symbol.brokers,
      categoryId: symbol.categoryId,
    };
  }
  return {
    id: makeId("snapshot"),
    date: isoDate,
    createdAt: date.toISOString(),
    source: "manual",
    totals: {
      twd: portfolio.totals.twd,
      usdNative: portfolio.totals.usdNative,
      twdNative: portfolio.totals.twdNative,
      byCategory: portfolio.totals.byCategory,
      byBroker: portfolio.totals.byBroker,
      byMarket: portfolio.totals.byMarket,
    },
    bySymbol,
  };
}

async function fetchAlphaQuote(symbol, apiKey) {
  if (!apiKey) return { ok: false, message: `${symbol}: 尚未設定 Alpha Vantage API key` };
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "GLOBAL_QUOTE");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);
  let data;
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, message: `${symbol}: Alpha Vantage HTTP ${response.status}` };
    data = await response.json();
  } catch (error) {
    return { ok: false, message: `${symbol}: Alpha Vantage 連線失敗：${error.message}` };
  }
  if (data.Note || data.Information) return { ok: false, message: `${symbol}: ${shortProviderMessage(data.Note || data.Information)}`, code: "rate-limit" };
  const quote = data["Global Quote"] || {};
  const price = parseNumber(quote["05. price"]);
  if (!price) return { ok: false, message: `${symbol}: Alpha Vantage 沒有回傳價格` };
  return {
    ok: true,
    symbol,
    price,
    currency: "USD",
    asOf: new Date().toISOString(),
    source: "alpha-vantage",
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

async function fetchStooqQuotes(symbols) {
  if (!symbols.length) return new Map();
  const stooqSymbols = symbols.map((symbol) => `${normalizeSymbol(symbol).toLowerCase()}.us`);
  const url = `https://stooq.com/q/l/?s=${stooqSymbols.map(encodeURIComponent).join("+")}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Stooq HTTP ${response.status}`);
  const text = await response.text();
  const map = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [rawSymbol, date, time, , , , close] = parseCsvLine(line);
    const price = parseNumber(close);
    const symbol = normalizeSymbol(String(rawSymbol || "").replace(/\.US$/i, ""));
    if (symbol && price) {
      map.set(symbol, {
        price,
        currency: "USD",
        asOf: date && time ? new Date(`${date}T${time}Z`).toISOString() : new Date().toISOString(),
        source: "stooq-batch",
      });
    }
  }
  if (!map.size) throw new Error("Stooq 沒有可解析的美股價格");
  return map;
}

async function fetchTwseQuotes() {
  const response = await fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json");
  if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
  const data = await response.json();
  const map = new Map();
  const rows = Array.isArray(data) ? data : data.data || [];
  for (const row of rows) {
    const code = Array.isArray(row) ? normalizeSymbol(row[0]) : normalizeSymbol(row.Code || row.code || row["證券代號"]);
    const price = Array.isArray(row) ? parseNumber(row[7]) : parseNumber(row.ClosingPrice || row.closingPrice || row["收盤價"]);
    if (code && price) map.set(code, price);
  }
  try {
    for (const [code, price] of await fetchTpexQuotes()) map.set(code, price);
  } catch {
    // TPEx is a best-effort supplement for OTC/bond ETFs; TWSE-listed quotes can still update without it.
  }
  if (!map.size) throw new Error("TWSE 沒有可解析的收盤價");
  return map;
}

async function fetchTpexQuotes() {
  const response = await fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes");
  if (!response.ok) throw new Error(`TPEx HTTP ${response.status}`);
  const data = await response.json();
  const map = new Map();
  for (const table of data.tables || []) {
    for (const row of table.data || []) {
      const code = normalizeSymbol(row[0]);
      const price = parseNumber(row[2]);
      if (code && price) map.set(code, price);
    }
  }
  if (!map.size) throw new Error("TPEx 沒有可解析的收盤價");
  return map;
}

async function fetchTwseOpenApiQuotes() {
  const response = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  if (!response.ok) throw new Error(`TWSE OpenAPI HTTP ${response.status}`);
  const rows = await response.json();
  const map = new Map();
  for (const row of rows) {
    const code = normalizeSymbol(row.Code || row.code || row["證券代號"]);
    const price = parseNumber(row.ClosingPrice || row.closingPrice || row["收盤價"]);
    if (code && price) map.set(code, price);
  }
  if (!map.size) throw new Error("TWSE OpenAPI 沒有可解析的收盤價");
  return map;
}

async function fetchYahooChart(symbol) {
  const yahooSymbol = `${normalizeSymbol(symbol)}.TW`;
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=5d&interval=1d`);
  if (!response.ok) throw new Error(`Yahoo chart HTTP ${response.status}`);
  const data = await response.json();
  const result = data.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const price = [...closes].reverse().find((value) => Number.isFinite(value));
  if (!price) throw new Error("Yahoo chart 沒有可用收盤價");
  return price;
}

async function fetchCbcUsdTwd() {
  const response = await fetch("https://cpx.cbc.gov.tw/API/DataAPI/Get?FileName=BP01D01en");
  if (!response.ok) throw new Error(`CBC HTTP ${response.status}`);
  const data = await response.json();
  const candidates = [];
  const visit = (value, trail = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...trail, index]));
      return;
    }
    if (value && typeof value === "object") {
      const values = Object.values(value);
      const dateLike = values.find((item) => typeof item === "string" && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(item));
      const numbers = values.map(parseNumber).filter((item) => item && item > 20 && item < 40);
      if (dateLike && numbers.length) candidates.push({ date: dateLike, rate: numbers.at(-1) });
      Object.entries(value).forEach(([key, item]) => visit(item, [...trail, key]));
    }
  };
  visit(data);
  candidates.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = candidates.at(-1);
  if (!latest) throw new Error("CBC 沒有可解析的 USD/TWD 匯率");
  return {
    rate: latest.rate,
    asOf: new Date().toISOString(),
    source: "cbc",
  };
}

async function fetchFrankfurterUsdTwd() {
  const response = await fetch("https://api.frankfurter.dev/v2/rate/USD/TWD");
  if (!response.ok) throw new Error(`Frankfurter HTTP ${response.status}`);
  const data = await response.json();
  const rate = parseNumber(data.rate);
  if (!rate) throw new Error("Frankfurter 沒有回傳 USD/TWD");
  return {
    rate,
    asOf: new Date().toISOString(),
    source: "frankfurter",
  };
}

export async function refreshPrices({ holdings, prices, settings, force = false }) {
  const messages = [];
  const details = [];
  const summary = { updated: 0, skipped: 0, failed: 0, rateLimited: false };
  const now = new Date();
  const cacheMs = Number(settings.cacheQuotesForHours || 12) * 60 * 60 * 1000;
  const shouldFetch = (symbol) => {
    if (force) return true;
    const asOf = prices.quotes?.[symbol]?.asOf;
    return !asOf || now - new Date(asOf) > cacheMs;
  };

  try {
    prices.fx.USDTWD = await fetchCbcUsdTwd();
    messages.push("USD/TWD 已由台灣央行資料更新");
    details.push({ level: "ok", symbol: "USD/TWD", message: "已由台灣央行資料更新" });
  } catch (error) {
    try {
      prices.fx.USDTWD = await fetchFrankfurterUsdTwd();
      messages.push("USD/TWD 已由 Frankfurter 備援資料更新");
      details.push({ level: "ok", symbol: "USD/TWD", message: "已由 Frankfurter 備援資料更新" });
    } catch (fallbackError) {
      messages.push(`USD/TWD 更新失敗，保留上次匯率：${error.message}`);
      details.push({ level: "warn", symbol: "USD/TWD", message: "更新失敗，保留上次匯率" });
      summary.failed += 1;
    }
  }

  const active = holdings.filter((holding) => !holding.archived && Number(holding.shares || 0) >= 0);
  const usSymbols = [...new Set(active.filter((holding) => holding.market === "US").map((holding) => normalizeSymbol(holding.quoteSymbol || holding.symbol)))];
  const twSymbols = [...new Set(active.filter((holding) => holding.market === "TW").map((holding) => normalizeSymbol(holding.quoteSymbol || holding.symbol)))];

  let twseQuotes = null;
  if (twSymbols.some(shouldFetch)) {
    try {
      twseQuotes = await fetchTwseQuotes();
    } catch (error) {
      try {
        twseQuotes = await fetchTwseOpenApiQuotes();
        messages.push("TWSE 主要資料源失敗，已使用 OpenAPI 備援");
        details.push({ level: "warn", symbol: "TWSE", message: "主要資料源失敗，已使用 OpenAPI 備援" });
      } catch {
        messages.push(`TWSE 批次資料更新失敗：${error.message}`);
        details.push({ level: "warn", symbol: "TWSE", message: "批次資料更新失敗，將嘗試個別備援" });
      }
    }
  }

  for (const symbol of twSymbols) {
    if (!shouldFetch(symbol)) {
      summary.skipped += 1;
      continue;
    }
    try {
      let price = twseQuotes?.get(symbol);
      let source = "taiwan-official";
      if (!price) {
        price = await fetchYahooChart(symbol);
        source = "yahoo-chart-fallback";
      }
      prices.quotes[symbol] = { price, currency: "TWD", asOf: now.toISOString(), source };
      messages.push(`${symbol} 已更新`);
      details.push({ level: "ok", symbol, message: `已更新 ${price}` });
      summary.updated += 1;
    } catch (error) {
      messages.push(`${symbol} 更新失敗，保留上次價格：${error.message}`);
      details.push({ level: "warn", symbol, message: "更新失敗，保留上次價格" });
      summary.failed += 1;
    }
  }

  const pendingUsSymbols = usSymbols.filter(shouldFetch);
  summary.skipped += usSymbols.length - pendingUsSymbols.length;
  let stooqQuotes = null;
  if (pendingUsSymbols.length) {
    try {
      stooqQuotes = await fetchStooqQuotes(pendingUsSymbols);
      details.push({ level: "ok", symbol: "US-BATCH", message: `Stooq 批次更新 ${stooqQuotes.size} / ${pendingUsSymbols.length} 檔美股` });
    } catch (error) {
      messages.push(`美股批次資料更新失敗，改用 Alpha Vantage 備援：${error.message}`);
      details.push({ level: "warn", symbol: "US-BATCH", message: "批次資料更新失敗，改用 Alpha Vantage 備援" });
    }
  }

  for (const symbol of pendingUsSymbols) {
    const stooqQuote = stooqQuotes?.get(symbol);
    if (stooqQuote) {
      prices.quotes[symbol] = stooqQuote;
      messages.push(`${symbol} 已由 Stooq 批次更新`);
      details.push({ level: "ok", symbol, message: `已更新 ${stooqQuote.price}` });
      summary.updated += 1;
      continue;
    }
    const quote = await fetchAlphaQuote(symbol, settings.alphaVantageApiKey);
    if (quote.ok) {
      prices.quotes[symbol] = {
        price: quote.price,
        currency: quote.currency,
        asOf: quote.asOf,
        source: quote.source,
      };
      messages.push(`${symbol} 已更新`);
      details.push({ level: "ok", symbol, message: `已更新 ${quote.price}` });
      summary.updated += 1;
    } else {
      messages.push(quote.message);
      details.push({ level: quote.code === "rate-limit" ? "warn" : "error", symbol, message: quote.message.replace(`${symbol}: `, "") });
      summary.failed += 1;
      if (quote.code === "rate-limit") summary.rateLimited = true;
    }
    await wait(1100);
  }

  prices.lastRefresh = now.toISOString();
  prices.messages = messages;
  prices.updateSummary = summary;
  prices.updateDetails = details;
  return prices;
}

function toCsv(portfolio) {
  const rows = [
    ["broker", "symbol", "name", "shares", "currency", "price", "value_native", "value_twd", "category", "price_as_of", "price_source"],
  ];
  const categoryMap = new Map(portfolio.allCategories.map((category) => [category.id, category.name]));
  for (const holding of portfolio.holdings) {
    rows.push([
      holding.broker,
      holding.symbol,
      holding.name,
      holding.shares,
      holding.currency,
      holding.price,
      holding.valueNative,
      holding.valueTwd,
      categoryMap.get(holding.categoryId) || "未分類",
      holding.priceAsOf || "",
      holding.priceSource || "",
    ]);
  }
  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

async function loadPortfolioData() {
  const [holdings, categories, prices, snapshots, settings] = await Promise.all([
    readJson("holdings"),
    readJson("categories"),
    readJson("prices"),
    readJson("snapshots"),
    readJson("settings"),
  ]);
  return { holdings, categories, prices, snapshots, settings };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/portfolio") {
    const data = await loadPortfolioData();
    return jsonResponse(res, 200, { ...buildPortfolio(data), meta: { storage: storageMode(), authEnabled: Boolean(APP_PASSWORD) } });
  }

  if (req.method === "POST" && pathname === "/api/prices/refresh") {
    const body = await readBody(req);
    const data = await loadPortfolioData();
    const prices = await refreshPrices({ ...data, force: Boolean(body.force) });
    await writeJson("prices", prices);
    return jsonResponse(res, 200, buildPortfolio({ ...data, prices }));
  }

  if (req.method === "POST" && pathname === "/api/snapshots") {
    const data = await loadPortfolioData();
    const portfolio = buildPortfolio(data);
    const snapshots = [...data.snapshots, createSnapshot(portfolio)];
    await writeJson("snapshots", snapshots);
    return jsonResponse(res, 201, buildPortfolio({ ...data, snapshots }));
  }

  if (req.method === "POST" && pathname === "/api/holdings") {
    const body = await readBody(req);
    const holdings = await readJson("holdings");
    const next = {
      id: makeId("holding"),
      broker: body.broker?.trim() || "未設定券商",
      name: body.name?.trim() || normalizeSymbol(body.symbol),
      symbol: normalizeSymbol(body.symbol),
      quoteSymbol: normalizeSymbol(body.quoteSymbol || body.symbol),
      market: body.market === "TW" ? "TW" : "US",
      currency: body.currency === "TWD" ? "TWD" : "USD",
      shares: Number(body.shares || 0),
      categoryId: body.categoryId || "uncategorized",
      archived: false,
    };
    holdings.push(next);
    await writeJson("holdings", holdings);
    return jsonResponse(res, 201, next);
  }

  const holdingMatch = pathname.match(/^\/api\/holdings\/([^/]+)(\/archive)?$/);
  if (holdingMatch && req.method === "PATCH") {
    const [, id, archivePath] = holdingMatch;
    const body = archivePath ? { archived: true } : await readBody(req);
    const holdings = await readJson("holdings");
    const index = holdings.findIndex((holding) => holding.id === id);
    if (index === -1) return jsonResponse(res, 404, { error: "找不到持股" });
    holdings[index] = {
      ...holdings[index],
      ...body,
      symbol: body.symbol ? normalizeSymbol(body.symbol) : holdings[index].symbol,
      quoteSymbol: body.quoteSymbol ? normalizeSymbol(body.quoteSymbol) : holdings[index].quoteSymbol,
      shares: body.shares == null ? holdings[index].shares : Number(body.shares),
    };
    await writeJson("holdings", holdings);
    return jsonResponse(res, 200, holdings[index]);
  }

  if (req.method === "POST" && pathname === "/api/categories") {
    const body = await readBody(req);
    const categories = await readJson("categories");
    const next = {
      id: makeId("category"),
      name: body.name?.trim() || "新分類",
      color: body.color || "#64748b",
      order: Number(body.order || categories.length + 1),
      archived: false,
    };
    categories.push(next);
    await writeJson("categories", categories);
    return jsonResponse(res, 201, next);
  }

  const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (categoryMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const categories = await readJson("categories");
    const index = categories.findIndex((category) => category.id === categoryMatch[1]);
    if (index === -1) return jsonResponse(res, 404, { error: "找不到分類" });
    categories[index] = {
      ...categories[index],
      ...body,
      order: body.order == null ? categories[index].order : Number(body.order),
    };
    await writeJson("categories", categories);
    return jsonResponse(res, 200, categories[index]);
  }

  if (req.method === "PATCH" && pathname === "/api/settings") {
    const body = await readBody(req);
    const settings = await readJson("settings");
    const next = {
      ...settings,
      alphaVantageApiKey: body.alphaVantageApiKey == null ? settings.alphaVantageApiKey : String(body.alphaVantageApiKey).trim(),
      cacheQuotesForHours: body.cacheQuotesForHours == null ? settings.cacheQuotesForHours : Number(body.cacheQuotesForHours),
    };
    await writeJson("settings", next);
    return jsonResponse(res, 200, { ...next, alphaVantageApiKey: next.alphaVantageApiKey ? "********" : "" });
  }

  if (req.method === "GET" && pathname === "/api/export/holdings.csv") {
    const portfolio = buildPortfolio(await loadPortfolioData());
    return downloadResponse(res, 200, toCsv(portfolio), "holdings.csv", "text/csv; charset=utf-8");
  }

  if (req.method === "GET" && pathname === "/api/export/data.json") {
    const data = await loadPortfolioData();
    const backup = JSON.stringify({
      ...data,
      settings: { ...data.settings, alphaVantageApiKey: "" },
    }, null, 2);
    return downloadResponse(res, 200, `${backup}\n`, `mystock-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json; charset=utf-8");
  }

  return jsonResponse(res, 404, { error: "API not found" });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return textResponse(res, 403, "Forbidden");
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    textResponse(res, 404, "Not found");
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse(res, 200, { ok: true, storage: storageMode() });
      }
      const authHandled = await handleAuth(req, res, url.pathname);
      if (authHandled !== false) return;
      if (!isAuthenticated(req) && !isPublicAsset(url.pathname)) {
        if (url.pathname.startsWith("/api/")) return jsonResponse(res, 401, { error: "請先登入" });
        return redirectResponse(res, "/login");
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      jsonResponse(res, 500, { error: error.message });
    }
  });
}

if (process.argv[1] === __filename) {
  createServer().listen(PORT, HOST, () => {
    console.log(`MyStock tracker running at http://${HOST}:${PORT}`);
  });
}
