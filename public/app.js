const currency = {
  TWD: new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

const currencyWhole = {
  TWD: new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }),
};

const currencyPrefix = {
  TWD: "NT$",
  USD: "US$",
};

const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat("zh-TW", { style: "percent", maximumFractionDigits: 1 });

let state = null;
let selectedPeriod = "all";
let supabaseClient = null;
let timelineInteraction = null;

const documentNames = ["holdings", "categories", "prices", "snapshots", "settings"];
const supabaseConfig = {
  ...(window.MYSTOCK_CONFIG || {}),
  supabaseUrl: normalizeSupabaseUrl(window.MYSTOCK_CONFIG?.supabaseUrl || ""),
};
const localApiHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const supabaseEnabled = !localApiHost && Boolean(supabaseConfig.supabaseUrl && supabaseConfig.supabaseAnonKey && window.supabase);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function money(value, unit = "TWD") {
  const formatter = currency[unit] || number;
  const prefix = currencyPrefix[unit] || `${unit} `;
  return `${prefix}${formatter.format(Number(value || 0))}`;
}

function moneyValue(value, unit = "TWD") {
  const formatter = currency[unit] || number;
  return formatter.format(Number(value || 0));
}

function moneyWhole(value, unit = "TWD") {
  const formatter = currencyWhole[unit] || number;
  const prefix = currencyPrefix[unit] || `${unit} `;
  return `${prefix}${formatter.format(Number(value || 0))}`;
}

function quoteCacheMinutes(settings = {}) {
  if (settings.cacheQuotesForMinutes != null) return Number(settings.cacheQuotesForMinutes || 10);
  return 10;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSupabaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/+$/g, "");
}

function setStatus(message, strong = "") {
  const status = $("#status");
  if (!status) return;
  status.innerHTML = strong ? `<strong>${strong}</strong> ${message}` : message;
}

async function api(path, options = {}) {
  if (supabaseEnabled) return supabaseApi(path, options);
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API request failed");
  return data;
}

async function load() {
  state = await api("/api/portfolio");
  $("#logoutButton").hidden = !state.meta?.authEnabled;
  const csvLink = document.querySelector('a.button[href="/api/export/holdings.csv"]');
  if (csvLink && supabaseEnabled) csvLink.href = "#";
  render();
}

function normalizeSymbol(symbol = "") {
  return String(symbol).trim().replace(/^NASDAQ:/i, "").replace(/^TPE:/i, "").replace(/\.TW$/i, "").toUpperCase();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseNumber(value) {
  if (typeof value === "number") return value;
  if (value == null) return null;
  const clean = String(value).replace(/,/g, "").trim();
  if (!clean || clean === "--") return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addAmount(target, key, amount) {
  target[key] = (target[key] || 0) + amount;
}

function buildPortfolio({ holdings, categories, prices, snapshots, settings }) {
  const activeCategories = categories.filter((category) => !category.archived).sort((a, b) => a.order - b.order);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const activeHoldings = holdings.filter((holding) => !holding.archived);
  const fx = Number(prices.fx?.USDTWD?.rate || 0);
  const valuedHoldings = activeHoldings.map((holding) => {
    const quoteSymbol = normalizeSymbol(holding.quoteSymbol || holding.symbol);
    const quote = prices.quotes?.[quoteSymbol] || null;
    const price = Number(quote?.price || 0);
    const valueNative = Number(holding.shares || 0) * price;
    return {
      ...holding,
      symbol: normalizeSymbol(holding.symbol),
      quoteSymbol,
      price,
      priceAsOf: quote?.asOf || null,
      priceSource: quote?.source || "missing",
      valueNative,
      valueTwd: holding.currency === "USD" ? valueNative * fx : valueNative,
    };
  });
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
    date: date.toISOString().slice(0, 10),
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

function shortProviderMessage(message = "") {
  if (/Finnhub.*(HTTP 429|API limit|rate limit|too many requests)|too many requests/i.test(message)) {
    return "Finnhub 免費額度或頻率限制，改用備援來源";
  }
  if (/premium|rate limit|25 requests per day|request per second|Thank you for using Alpha Vantage/i.test(message)) {
    return "Alpha Vantage 免費額度或頻率限制，保留上次價格";
  }
  return String(message).replace(/\s+/g, " ").slice(0, 160);
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
  return { ok: true, symbol, price, currency: "USD", asOf: new Date().toISOString(), source: "alpha-vantage" };
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
  if (supabaseEnabled) {
    return await fetchSupabaseUsQuotes(symbols);
  }
  const stooqSymbols = symbols.map((symbol) => `${normalizeSymbol(symbol).toLowerCase()}.us`);
  const url = `https://stooq.com/q/l/?s=${stooqSymbols.map(encodeURIComponent).join("+")}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetchWithTimeout(url, {}, 10000);
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

function summarizeQuoteSources(quotes) {
  const counts = new Map();
  for (const quote of quotes.values()) {
    const source = quote.source === "finnhub" ? "Finnhub" : quote.source === "stooq-batch" ? "Stooq" : quote.source || "unknown";
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => `${source} ${count}`).join("，");
}

async function fetchSupabaseUsQuotes(symbols) {
  const url = new URL(`${supabaseConfig.supabaseUrl}/functions/v1/us-quotes`);
  url.searchParams.set("symbols", symbols.map(normalizeSymbol).join(","));
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        apikey: supabaseConfig.supabaseAnonKey,
        authorization: `Bearer ${supabaseConfig.supabaseAnonKey}`,
      },
    },
    9000
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `US quotes function HTTP ${response.status}`);
  const map = new Map();
  for (const [symbol, quote] of Object.entries(data.quotes || {})) {
    const price = parseNumber(quote?.price);
    if (symbol && price) {
      map.set(normalizeSymbol(symbol), {
        price,
        currency: "USD",
        asOf: quote.asOf || data.asOf || new Date().toISOString(),
        source: quote.source || "finnhub",
      });
    }
  }
  if (!map.size) throw new Error("Supabase US quotes function 沒有可解析的美股價格");
  return map;
}

async function fetchTwseQuotes() {
  if (supabaseEnabled) {
    try {
      return await fetchSupabaseTaiwanQuotes();
    } catch {
      // Fall back to direct browser fetches when the Edge Function has not been deployed yet.
    }
  }
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

async function fetchSupabaseTaiwanQuotes() {
  const response = await fetch(`${supabaseConfig.supabaseUrl}/functions/v1/taiwan-quotes`, {
    headers: {
      apikey: supabaseConfig.supabaseAnonKey,
      authorization: `Bearer ${supabaseConfig.supabaseAnonKey}`,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Taiwan quotes function HTTP ${response.status}`);
  const map = new Map();
  for (const [code, price] of Object.entries(data.quotes || {})) {
    const parsed = parseNumber(price);
    if (code && parsed) map.set(normalizeSymbol(code), parsed);
  }
  if (!map.size) throw new Error("Supabase Taiwan quotes function 沒有可解析的收盤價");
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

async function fetchCbcUsdTwd() {
  const response = await fetch("https://cpx.cbc.gov.tw/API/DataAPI/Get?FileName=BP01D01en");
  if (!response.ok) throw new Error(`CBC HTTP ${response.status}`);
  const data = await response.json();
  const candidates = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") {
      const values = Object.values(value);
      const dateLike = values.find((item) => typeof item === "string" && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(item));
      const numbers = values.map(parseNumber).filter((item) => item && item > 20 && item < 40);
      if (dateLike && numbers.length) candidates.push({ date: dateLike, rate: numbers.at(-1) });
      Object.values(value).forEach(visit);
    }
  };
  visit(data);
  candidates.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = candidates.at(-1);
  if (!latest) throw new Error("CBC 沒有可解析的 USD/TWD 匯率");
  return { rate: latest.rate, asOf: new Date().toISOString(), source: "cbc" };
}

async function fetchFrankfurterUsdTwd() {
  const response = await fetch("https://api.frankfurter.dev/v2/rate/USD/TWD");
  if (!response.ok) throw new Error(`Frankfurter HTTP ${response.status}`);
  const data = await response.json();
  const rate = parseNumber(data.rate);
  if (!rate) throw new Error("Frankfurter 沒有回傳 USD/TWD");
  return { rate, asOf: new Date().toISOString(), source: "frankfurter" };
}

async function refreshPrices({ holdings, prices, settings, force = false }) {
  const messages = [];
  const details = [];
  const summary = { updated: 0, skipped: 0, failed: 0, rateLimited: false };
  const nextPrices = structuredClone(prices);
  const now = new Date();
  const cacheMs = quoteCacheMinutes(settings) * 60 * 1000;
  const shouldFetch = (symbol) => {
    if (force) return true;
    const asOf = nextPrices.quotes?.[symbol]?.asOf;
    return !asOf || now - new Date(asOf) > cacheMs;
  };

  try {
    nextPrices.fx.USDTWD = await fetchCbcUsdTwd();
    messages.push("USD/TWD 已由台灣央行資料更新");
    details.push({ level: "ok", symbol: "USD/TWD", message: "已由台灣央行資料更新" });
  } catch (error) {
    try {
      nextPrices.fx.USDTWD = await fetchFrankfurterUsdTwd();
      messages.push("USD/TWD 已由 Frankfurter 備援資料更新");
      details.push({ level: "ok", symbol: "USD/TWD", message: "已由 Frankfurter 備援資料更新" });
    } catch {
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
        details.push({ level: "warn", symbol: "TWSE", message: "批次資料更新失敗" });
      }
    }
  }

  for (const symbol of twSymbols) {
    if (!shouldFetch(symbol)) {
      summary.skipped += 1;
      continue;
    }
    const price = twseQuotes?.get(symbol);
    if (price) {
      nextPrices.quotes[symbol] = { price, currency: "TWD", asOf: now.toISOString(), source: "taiwan-official" };
      details.push({ level: "ok", symbol, message: `已更新 ${price}` });
      summary.updated += 1;
    } else {
      details.push({ level: "warn", symbol, message: "更新失敗，保留上次價格" });
      summary.failed += 1;
    }
  }

  const pendingUsSymbols = usSymbols.filter(shouldFetch);
  summary.skipped += usSymbols.length - pendingUsSymbols.length;
  let primaryUsQuotes = null;
  if (pendingUsSymbols.length) {
    try {
      primaryUsQuotes = await fetchStooqQuotes(pendingUsSymbols);
      details.push({ level: "ok", symbol: "US-BATCH", message: `美股主要來源更新 ${primaryUsQuotes.size} / ${pendingUsSymbols.length} 檔：${summarizeQuoteSources(primaryUsQuotes)}` });
    } catch (error) {
      details.push({ level: "warn", symbol: "US-BATCH", message: `美股主要來源失敗：${shortProviderMessage(error.message)}。改用 Alpha Vantage 備援` });
    }
  }

  for (const symbol of pendingUsSymbols) {
    const primaryQuote = primaryUsQuotes?.get(symbol);
    if (primaryQuote) {
      nextPrices.quotes[symbol] = primaryQuote;
      details.push({ level: "ok", symbol, message: `已由 ${primaryQuote.source === "finnhub" ? "Finnhub" : "Stooq"} 更新 ${primaryQuote.price}` });
      summary.updated += 1;
      continue;
    }
    const quote = await fetchAlphaQuote(symbol, settings.alphaVantageApiKey);
    if (quote.ok) {
      nextPrices.quotes[symbol] = { price: quote.price, currency: quote.currency, asOf: quote.asOf, source: quote.source };
      details.push({ level: "ok", symbol, message: `已更新 ${quote.price}` });
      summary.updated += 1;
    } else {
      details.push({ level: quote.code === "rate-limit" ? "warn" : "error", symbol, message: quote.message.replace(`${symbol}: `, "") });
      summary.failed += 1;
      if (quote.code === "rate-limit") summary.rateLimited = true;
    }
    await wait(1100);
  }

  nextPrices.lastRefresh = now.toISOString();
  nextPrices.messages = messages;
  nextPrices.updateSummary = summary;
  nextPrices.updateDetails = details;
  return nextPrices;
}

function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseAnonKey);
  }
  return supabaseClient;
}

async function requireSupabaseSession() {
  const client = getSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("請先登入 Supabase");
  return data.session;
}

async function showSupabaseAuth() {
  document.body.classList.add("auth-page");
  document.body.innerHTML = `<main class="auth-shell">
    <section class="auth-panel">
      <p class="eyebrow">MyStock Tracker</p>
      <h1>登入 Supabase</h1>
      <form id="supabaseAuthForm" class="edit-form auth-form">
        <label>Email <input name="email" type="email" autocomplete="email" required /></label>
        <label>密碼 <input name="password" type="password" autocomplete="current-password" required /></label>
        <p class="form-note">第一次使用請按「建立帳號」。如果 Supabase 有開 email confirmation，請先到信箱完成驗證再登入。</p>
        <p id="authStatus" class="auth-error" hidden></p>
        <div class="form-actions">
          <button class="primary" name="mode" value="signin" type="submit">登入</button>
          <button name="mode" value="signup" type="submit">建立帳號</button>
        </div>
      </form>
    </section>
  </main>`;
  $("#supabaseAuthForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const form = event.currentTarget;
    const status = $("#authStatus");
    const email = form.email.value.trim();
    const password = form.password.value;
    status.hidden = true;
    try {
      const client = getSupabase();
      const result =
        submitter?.value === "signup"
          ? await client.auth.signUp({ email, password })
          : await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      window.location.reload();
    } catch (error) {
      status.textContent = [error.code, error.message].filter(Boolean).join(": ");
      status.hidden = false;
    }
  });
}

async function readSupabaseDocuments() {
  const client = getSupabase();
  const session = await requireSupabaseSession();
  const { data, error } = await client.from("mystock_documents").select("name,value").eq("user_id", session.user.id);
  if (error) throw error;
  const docs = Object.fromEntries((data || []).map((row) => [row.name, row.value]));
  return {
    holdings: docs.holdings || [],
    categories: docs.categories || [{ id: "uncategorized", name: "未分類", color: "#64748b", order: 99, archived: false }],
    prices: docs.prices || { fx: { USDTWD: { rate: 0, asOf: null, source: "missing" } }, quotes: {}, messages: [] },
    snapshots: docs.snapshots || [],
    settings: docs.settings || { alphaVantageApiKey: "", baseCurrency: "TWD", cacheQuotesForMinutes: 10 },
  };
}

async function writeSupabaseDocument(name, value) {
  const client = getSupabase();
  const session = await requireSupabaseSession();
  const { error } = await client
    .from("mystock_documents")
    .upsert({ user_id: session.user.id, name, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,name" });
  if (error) throw error;
}

async function writeSupabaseDocuments(docs) {
  for (const name of documentNames) await writeSupabaseDocument(name, docs[name]);
}

async function supabaseApi(path, options = {}) {
  const client = getSupabase();
  const { data } = await client.auth.getSession();
  if (!data.session) {
    await showSupabaseAuth();
    throw new Error("請先登入 Supabase");
  }

  const method = options.method || "GET";
  const body = options.body || {};
  const docs = await readSupabaseDocuments();

  if (method === "GET" && path === "/api/portfolio") {
    return { ...buildPortfolio(docs), meta: { storage: "supabase", authEnabled: true } };
  }
  if (method === "POST" && path === "/api/logout") {
    await client.auth.signOut();
    return { ok: true };
  }
  if (method === "POST" && path === "/api/prices/refresh") {
    const prices = await refreshPrices({ ...docs, force: Boolean(body.force) });
    await writeSupabaseDocument("prices", prices);
    return { ...buildPortfolio({ ...docs, prices }), meta: { storage: "supabase", authEnabled: true } };
  }
  if (method === "POST" && path === "/api/snapshots") {
    const portfolio = buildPortfolio(docs);
    const snapshots = [...docs.snapshots, createSnapshot(portfolio)];
    await writeSupabaseDocument("snapshots", snapshots);
    return { ...buildPortfolio({ ...docs, snapshots }), meta: { storage: "supabase", authEnabled: true } };
  }
  if (method === "POST" && path === "/api/holdings") {
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
    await writeSupabaseDocument("holdings", [...docs.holdings, next]);
    return next;
  }
  const holdingMatch = path.match(/^\/api\/holdings\/([^/]+)(\/archive)?$/);
  if (holdingMatch && method === "PATCH") {
    const [, id, archivePath] = holdingMatch;
    const patch = archivePath ? { archived: true } : body;
    const holdings = docs.holdings.map((holding) =>
      holding.id === id
        ? {
            ...holding,
            ...patch,
            symbol: patch.symbol ? normalizeSymbol(patch.symbol) : holding.symbol,
            quoteSymbol: patch.quoteSymbol ? normalizeSymbol(patch.quoteSymbol) : holding.quoteSymbol,
            shares: patch.shares == null ? holding.shares : Number(patch.shares),
          }
        : holding
    );
    await writeSupabaseDocument("holdings", holdings);
    return holdings.find((holding) => holding.id === id);
  }
  if (method === "POST" && path === "/api/categories") {
    const next = {
      id: makeId("category"),
      name: body.name?.trim() || "新分類",
      color: body.color || "#64748b",
      order: Number(body.order || docs.categories.length + 1),
      archived: false,
    };
    await writeSupabaseDocument("categories", [...docs.categories, next]);
    return next;
  }
  const categoryMatch = path.match(/^\/api\/categories\/([^/]+)$/);
  if (categoryMatch && method === "PATCH") {
    const categories = docs.categories.map((category) =>
      category.id === categoryMatch[1]
        ? { ...category, ...body, order: body.order == null ? category.order : Number(body.order) }
        : category
    );
    await writeSupabaseDocument("categories", categories);
    return categories.find((category) => category.id === categoryMatch[1]);
  }
  if (method === "PATCH" && path === "/api/settings") {
    const next = {
      ...docs.settings,
      alphaVantageApiKey: body.alphaVantageApiKey == null || body.alphaVantageApiKey === "" ? docs.settings.alphaVantageApiKey : String(body.alphaVantageApiKey).trim(),
      cacheQuotesForMinutes: body.cacheQuotesForMinutes == null ? quoteCacheMinutes(docs.settings) : Number(body.cacheQuotesForMinutes),
    };
    await writeSupabaseDocument("settings", next);
    return { ...next, alphaVantageApiKey: next.alphaVantageApiKey ? "********" : "" };
  }

  throw new Error(`Unsupported Supabase API route: ${method} ${path}`);
}

function render() {
  renderStatus();
  renderKpis();
  renderSelectors();
  renderHoldings();
  renderCategories();
  renderDashboard();
  renderStockDetail();
  renderSettings();
}

function renderStatus() {
  const fx = state.prices.fx.USDTWD;
  const lastRefresh = state.prices.lastRefresh ? new Date(state.prices.lastRefresh).toLocaleString("zh-TW") : "尚未更新";
  const summary = state.prices.updateSummary;
  const updateText = summary
    ? `更新 ${summary.updated} 筆，略過 ${summary.skipped} 筆，失敗 ${summary.failed} 筆${summary.rateLimited ? "；Alpha Vantage 已達免費額度/頻率限制" : ""}`
    : "價格目前使用匯入或上次更新資料";
  setStatus(`USD/TWD ${number.format(fx.rate)}，最後更新：${lastRefresh}。${updateText}`);
  renderUpdateDetails();
}

function renderUpdateDetails() {
  const details = state.prices.updateDetails || [];
  const panel = $("#updateDetails");
  if (!details.length) {
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = `<details>
    <summary>查看價格更新明細</summary>
    <div class="update-detail-list">
      ${details
        .map((item) => `<div class="update-detail ${item.level}"><strong>${item.symbol}</strong><span>${item.message}</span></div>`)
        .join("")}
    </div>
  </details>`;
}

function renderKpis() {
  const updatedQuotes = state.holdings.filter((holding) => holding.priceSource !== "missing").length;
  $("#kpis").innerHTML = [
    ["總資產", moneyWhole(state.totals.twd, "TWD")],
    ["美元資產", moneyWhole(state.totals.usdNative, "USD")],
    ["台幣資產", moneyWhole(state.totals.twdNative, "TWD")],
    ["追蹤持股", `${state.holdings.length} 筆 / ${updatedQuotes} 筆有價格`],
  ]
    .map(([label, value]) => `<div class="kpi"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function categoryName(id) {
  return state.allCategories.find((category) => category.id === id)?.name || "未分類";
}

function categoryColor(id) {
  return state.allCategories.find((category) => category.id === id)?.color || "#64748b";
}

function renderSelectors() {
  const categoryOptions = state.allCategories
    .filter((category) => !category.archived)
    .sort((a, b) => a.order - b.order)
    .map((category) => `<option value="${category.id}">${category.name}</option>`)
    .join("");
  $("#holdingCategorySelect").innerHTML = categoryOptions;
  const selected = $("#stockSelect").value;
  $("#stockSelect").innerHTML = state.allocationRows
    .map((row) => `<option value="${row.symbol}">${row.symbol} ${row.name !== row.symbol ? row.name : ""}</option>`)
    .join("");
  if (selected && state.allocationRows.some((row) => row.symbol === selected)) $("#stockSelect").value = selected;
}

function renderHoldings() {
  const brokerOrder = Object.entries(state.totals.byBroker)
    .sort(([, valueA], [, valueB]) => valueB - valueA)
    .map(([broker]) => broker);
  const grouped = state.holdings
    .slice()
    .sort((a, b) => {
      const brokerCompare = brokerOrder.indexOf(a.broker) - brokerOrder.indexOf(b.broker);
      if (brokerCompare) return brokerCompare;
      return b.valueTwd - a.valueTwd;
    });
  let currentBroker = "";
  $("#holdingsRows").innerHTML = grouped
    .map((holding) => {
      const brokerIndex = Math.max(0, brokerOrder.indexOf(holding.broker));
      const brokerTotal = state.totals.byBroker[holding.broker] || 0;
      const brokerHeader =
        holding.broker !== currentBroker
          ? `<tr class="broker-group-row" style="--broker-color:${palette(brokerIndex)}">
              <td colspan="8">
                <div class="broker-group">
                  <span class="broker-chip"></span>
                  <strong>${holding.broker}</strong>
                  <span>${money(brokerTotal, "TWD")} · ${percent.format(state.totals.twd ? brokerTotal / state.totals.twd : 0)}</span>
                </div>
              </td>
            </tr>`
          : "";
      currentBroker = holding.broker;
      const showHoldingName = holding.name && holding.name !== holding.symbol;
      return `${brokerHeader}<tr class="holding-row" style="--broker-color:${palette(brokerIndex)}">
        <td><span class="broker-dot"></span>${holding.broker}</td>
        <td>
          <div class="symbol-cell">
            <div><strong>${holding.symbol}</strong>${showHoldingName ? `<br><span class="muted">${holding.name}</span>` : ""}</div>
          </div>
        </td>
        <td>${number.format(holding.shares)}</td>
        <td>${holding.currency}</td>
        <td>${moneyValue(holding.price, holding.currency)}</td>
        <td>${moneyValue(holding.valueTwd, "TWD")}</td>
        <td><span class="swatch" style="display:inline-block;background:${categoryColor(holding.categoryId)}"></span> ${categoryName(holding.categoryId)}</td>
        <td><div class="table-actions">
          <button data-edit-holding="${holding.id}">編輯</button>
          <button class="danger" data-archive-holding="${holding.id}">停用</button>
        </div></td>
      </tr>`;
    })
    .join("");
}

function renderCategories() {
  $("#categoryList").innerHTML = state.allCategories
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((category) => {
      const total = state.totals.byCategory[category.id] || 0;
      return `<div class="category-item">
        <span class="swatch" style="background:${category.color}"></span>
        <strong class="${category.archived ? "archived" : ""}">${category.name}</strong>
        <span>${money(total, "TWD")}</span>
        <button data-edit-category="${category.id}">編輯</button>
      </div>`;
    })
    .join("");
}

function renderDashboard() {
  const periodSnapshots = filterSnapshotsByPeriod(state.snapshots, selectedPeriod);
  const normalizedSnapshots = periodSnapshots.map(normalizeSnapshot);
  const fullSnapshots = normalizedSnapshots.filter((snapshot) => snapshot.totals?.byCategory || snapshot.totals?.byBroker || snapshot.totals?.byMarket);
  const endSnapshot = fullSnapshots.at(-1);
  const timeline = periodSnapshots.map((snapshot) => ({
    label: snapshot.date,
    time: snapshotTimestamp(snapshot),
    value: snapshot.totals?.twd || 0,
    snapshot,
  }));
  renderTimelineSummary(timeline);
  const timelineMeta = drawLineChart($("#timelineChart"), timeline, {
    color: "#1f6feb",
    label: "總資產",
    formatter: (value) => money(value, "TWD"),
  });
  setupTimelineTooltip(timeline, timelineMeta);
  renderSnapshotList(timeline);
  drawDonutChart(
    $("#categoryChart"),
    Object.entries(endSnapshot?.totals?.byCategory || state.totals.byCategory).map(([id, value]) => ({ label: categoryName(id), value, color: categoryColor(id) }))
  );
  drawDonutChart(
    $("#brokerChart"),
    Object.entries(endSnapshot?.totals?.byBroker || state.totals.byBroker).map(([label, value], index) => ({ label, value, color: palette(index) }))
  );
  drawDonutChart(
    $("#marketChart"),
    Object.entries(endSnapshot?.totals?.byMarket || state.totals.byMarket || getCurrentMarketTotals()).map(([label, value], index) => ({ label, value, color: index === 0 ? "#2563eb" : "#059669" }))
  );
  renderPeriodBreakdown(normalizedSnapshots);
  renderConcentration();
}

function normalizeSnapshot(snapshot) {
  if (!snapshot?.bySymbol || snapshot.totals?.byMarket) return snapshot;
  const byMarket = Object.values(snapshot.bySymbol).reduce((totals, item) => {
    const label = item.currency === "TWD" ? "台股" : "美股";
    totals[label] = (totals[label] || 0) + Number(item.valueTwd || 0);
    return totals;
  }, {});
  return {
    ...snapshot,
    totals: {
      ...snapshot.totals,
      byMarket,
    },
  };
}

function filterSnapshotsByPeriod(snapshots, period) {
  if (period === "all") return snapshots;
  const latest = snapshots.at(-1)?.date ? new Date(`${snapshots.at(-1).date}T00:00:00`) : new Date();
  const cutoff = new Date(latest);
  if (period === "ytd") cutoff.setMonth(0, 1);
  if (period === "12m") cutoff.setFullYear(cutoff.getFullYear() - 1);
  if (period === "6m") cutoff.setMonth(cutoff.getMonth() - 6);
  return snapshots.filter((snapshot) => new Date(`${snapshot.date}T00:00:00`) >= cutoff);
}

function renderTimelineSummary(points) {
  if (!points.length) {
    $("#timelineSummary").textContent = "尚無快照資料。按「儲存快照」後，時間軸會記錄當下總資產。";
    return;
  }
  const first = points[0];
  const last = points.at(-1);
  const change = last.value - first.value;
  const changePct = first.value ? change / first.value : 0;
  $("#timelineSummary").textContent = `${first.label} 到 ${last.label}，變化 ${money(change, "TWD")}（${percent.format(changePct)}），共 ${points.length} 筆快照。X 軸依實際時間間隔，Y 軸依目前區間調整。`;
}

function snapshotTimestamp(snapshot) {
  const raw = snapshot?.createdAt || (snapshot?.date ? `${snapshot.date}T12:00:00` : "");
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

function setupTimelineTooltip(points, meta) {
  const canvas = $("#timelineChart");
  const tooltip = $("#timelineTooltip");
  if (!canvas || !tooltip) return;
  if (timelineInteraction) {
    timelineInteraction.abort();
    timelineInteraction = null;
  }
  if (!points.length || !meta?.positions?.length) {
    tooltip.hidden = true;
    return;
  }

  const controller = new AbortController();
  timelineInteraction = controller;
  let hideTimer = null;

  const showPoint = (clientX, keepVisible = false) => {
    const rect = canvas.getBoundingClientRect();
    const xInCanvas = clientX - rect.left;
    let nearest = meta.positions[0];
    for (const position of meta.positions) {
      if (Math.abs(position.x - xInCanvas) < Math.abs(nearest.x - xInCanvas)) nearest = position;
    }
    const point = points[nearest.index];
    const previous = points[nearest.index - 1];
    const change = previous ? point.value - previous.value : 0;
    const changeClass = change > 0 ? "positive" : change < 0 ? "negative" : "";
    const totals = normalizeSnapshot(point.snapshot || {}).totals || {};
    tooltip.innerHTML = `<span class="tooltip-date">${point.label}</span>
      <strong class="tooltip-value">${money(point.value, "TWD")}</strong>
      <div class="tooltip-grid">
        <span>較前次</span><strong class="${changeClass}">${previous ? money(change, "TWD") : "第一筆"}</strong>
        <span>美股</span><strong>${money(totals.byMarket?.["美股"] || 0, "TWD")}</strong>
        <span>台股</span><strong>${money(totals.byMarket?.["台股"] || 0, "TWD")}</strong>
      </div>`;
    const tooltipWidth = tooltip.offsetWidth || 220;
    const left = Math.max(tooltipWidth / 2 + 8, Math.min(rect.width - tooltipWidth / 2 - 8, nearest.x));
    const top = Math.max(56, nearest.y - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.hidden = false;
    if (hideTimer) clearTimeout(hideTimer);
    if (keepVisible) hideTimer = setTimeout(() => (tooltip.hidden = true), 1800);
  };

  canvas.addEventListener("mousemove", (event) => showPoint(event.clientX), { signal: controller.signal });
  canvas.addEventListener("mouseleave", () => (tooltip.hidden = true), { signal: controller.signal });
  canvas.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches[0]) showPoint(event.touches[0].clientX);
    },
    { passive: true, signal: controller.signal }
  );
  canvas.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches[0]) showPoint(event.touches[0].clientX);
    },
    { passive: true, signal: controller.signal }
  );
  canvas.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (touch) showPoint(touch.clientX, true);
    },
    { passive: true, signal: controller.signal }
  );
}

function renderSnapshotList(points) {
  const recent = points.slice(-4).reverse();
  $("#snapshotList").innerHTML = recent
    .map((point) => `<div class="snapshot-item"><span>${point.label}</span><strong>${money(point.value, "TWD")}</strong></div>`)
    .join("");
}

function getCurrentMarketTotals() {
  return state.holdings.reduce((totals, holding) => {
    const label = holding.market === "TW" ? "台股" : "美股";
    totals[label] = (totals[label] || 0) + holding.valueTwd;
    return totals;
  }, {});
}

function renderPeriodBreakdown(snapshots) {
  const fullSnapshots = snapshots.filter((snapshot) => snapshot.totals?.byCategory || snapshot.totals?.byBroker || snapshot.totals?.byMarket);
  const start = fullSnapshots[0];
  const end = fullSnapshots.at(-1);
  if (!fullSnapshots.length) {
    $("#periodBreakdown").innerHTML = `<p class="empty-note">這段期間的舊快照只有總資產，沒有分類、券商或台美股拆分。從現在開始按「儲存快照」後，這裡會累積完整變化。</p>`;
    return;
  }
  const comparisonNote =
    fullSnapshots.length === 1
      ? `<p class="empty-note">目前只有 1 筆完整快照，先顯示目前分布；累積第 2 筆後，這裡會顯示期間變化。</p>`
      : "";
  const groups = [
    ["分類", "byCategory", categoryName],
    ["券商", "byBroker", (label) => label],
    ["市場", "byMarket", (label) => label],
  ];
  $("#periodBreakdown").innerHTML = comparisonNote + groups
    .map(([title, key, labeler]) => renderChangeGroup(title, start.totals?.[key] || {}, end.totals?.[key] || {}, labeler))
    .join("");
}

function renderChangeGroup(title, startValues, endValues, labeler) {
  const keys = [...new Set([...Object.keys(startValues), ...Object.keys(endValues)])];
  if (!keys.length) return `<div class="change-group"><h3>${title}</h3><p class="empty-note">尚無完整快照資料</p></div>`;
  const rows = keys
    .map((key) => ({
      key,
      label: labeler(key),
      start: startValues[key] || 0,
      end: endValues[key] || 0,
      change: (endValues[key] || 0) - (startValues[key] || 0),
    }))
    .sort((a, b) => Math.abs(b.end) - Math.abs(a.end));
  return `<div class="change-group">
    <h3>${title}</h3>
    ${rows
      .map((row) => `<div class="change-row">
        <span>${row.label}</span>
        <strong>${money(row.end, "TWD")}</strong>
        <em class="${row.change >= 0 ? "positive" : "negative"}">${row.change >= 0 ? "+" : ""}${money(row.change, "TWD")}</em>
      </div>`)
      .join("")}
  </div>`;
}

function renderConcentration() {
  const rows = state.allocationRows.slice(0, 8);
  $("#concentration").innerHTML = rows
    .map((row, index) => `<div class="concentration-row">
      <div class="concentration-symbol">
        <span class="concentration-rank">${index + 1}</span>
        <div>
          <strong>${row.symbol}</strong>
          <span>${row.categoryName}</span>
        </div>
      </div>
      <div class="concentration-track">
        <div class="concentration-fill" style="width:${Math.max(2, row.weight * 100)}%;background:${row.categoryColor || palette(index)}"></div>
      </div>
      <div class="concentration-value">
        <strong>${money(row.valueTwd, "TWD")}</strong>
        <span>${percent.format(row.weight)}</span>
      </div>
    </div>`)
    .join("");
}

function renderStockDetail() {
  const symbol = $("#stockSelect").value || state.allocationRows[0]?.symbol;
  if (!symbol) return;
  const row = state.allocationRows.find((item) => item.symbol === symbol);
  if (!row) return;
  $("#stockSummary").innerHTML = [
    ["股數", number.format(row.shares)],
    ["目前價格", money(row.price, row.currency)],
    ["原幣總值", money(row.valueNative, row.currency)],
    ["台幣總值", money(row.valueTwd, "TWD")],
  ]
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  const points = state.snapshots
    .filter((snapshot) => snapshot.bySymbol?.[symbol])
    .map((snapshot) => ({
      label: snapshot.date,
      value: snapshot.bySymbol[symbol].valueTwd || 0,
      shares: snapshot.bySymbol[symbol].shares || 0,
    }));
  drawDualLineChart($("#stockChart"), points, {
    valueColor: "#1f6feb",
    sharesColor: "#059669",
  });

  const total = Object.values(row.brokers).reduce((sum, item) => sum + item, 0);
  $("#stockBrokerSplit").innerHTML = Object.entries(row.brokers)
    .map(([broker, value], index) => `<div class="broker-row">
      <div class="bar-row">
        <strong>${broker}</strong>
        <div class="bar-track"><div class="bar-fill" style="width:${total ? (value / total) * 100 : 0}%;background:${palette(index)}"></div></div>
        <span>${money(value, "TWD")}</span>
      </div>
    </div>`)
    .join("");
}

function renderSettings() {
  $("#settingsForm").cacheQuotesForMinutes.value = quoteCacheMinutes(state.settings);
}

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function currentBackupData() {
  return {
    holdings: state.holdings.map(({ price, priceAsOf, priceSource, valueNative, valueTwd, ...holding }) => holding),
    categories: state.allCategories,
    prices: state.prices,
    snapshots: state.snapshots,
    settings: { ...state.settings, alphaVantageApiKey: "" },
  };
}

function validateBackupData(data) {
  for (const name of documentNames) {
    if (!(name in data)) throw new Error(`備份檔缺少 ${name}`);
  }
  if (!Array.isArray(data.holdings) || !Array.isArray(data.categories) || !Array.isArray(data.snapshots)) {
    throw new Error("備份檔格式不正確");
  }
}

function toCsv(portfolio) {
  const rows = [["broker", "symbol", "name", "shares", "currency", "price", "value_native", "value_twd", "category", "price_as_of", "price_source"]];
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
  return rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function palette(index) {
  return ["#1f6feb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#475569", "#be185d"][index % 8];
}

function getValueDomain(points) {
  const values = points.map((point) => point.value).filter((value) => Number.isFinite(value));
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const padding = Math.max(spread * 0.12, max * 0.01, 1);
  return {
    min: Math.max(0, min - padding),
    max: max + padding,
  };
}

function drawFrame(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d8dee9";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(52, 18);
  ctx.lineTo(52, height - 34);
  ctx.lineTo(width - 16, height - 34);
  ctx.stroke();
}

function prepareCanvas(canvas) {
  const baseHeight = Number(canvas.dataset.baseHeight || canvas.getAttribute("height") || 220);
  canvas.dataset.baseHeight = String(baseHeight);
  canvas.style.height = `${baseHeight}px`;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, rect.width) * dpr;
  canvas.height = baseHeight * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, width: canvas.width / dpr, height: canvas.height / dpr };
}

function drawLineChart(canvas, points, options) {
  const { ctx, width, height } = prepareCanvas(canvas);
  drawFrame(ctx, width, height);
  if (!points.length) {
    drawEmpty(ctx, width, height, "尚無快照資料");
    return { positions: [] };
  }
  const fallbackDomain = getValueDomain(points);
  const min = options.domain?.min ?? fallbackDomain.min;
  const max = options.domain?.max ?? fallbackDomain.max;
  const plot = { left: 52, top: 18, right: width - 16, bottom: height - 34 };
  const times = points.map((point) => (Number.isFinite(point.time) ? point.time : null)).filter((time) => time != null);
  const minTime = times.length ? Math.min(...times) : null;
  const maxTime = times.length ? Math.max(...times) : null;
  const useTimeScale = points.length > 1 && minTime != null && maxTime != null && maxTime > minTime;
  const x = (point, index) => {
    if (points.length === 1) return plot.left + (plot.right - plot.left) / 2;
    if (useTimeScale && Number.isFinite(point.time)) {
      return plot.left + ((point.time - minTime) / (maxTime - minTime)) * (plot.right - plot.left);
    }
    return plot.left + (index / (points.length - 1)) * (plot.right - plot.left);
  };
  const y = (value) => plot.bottom - ((value - min) / (max - min || 1)) * (plot.bottom - plot.top);
  ctx.strokeStyle = options.color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const px = x(point, index);
    const py = y(point.value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.fillStyle = options.color;
  const positions = points.map((point, index) => ({ index, x: x(point, index), y: y(point.value), value: point.value }));
  positions.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  drawAxisLabels(ctx, points, min, max, width, height, options.formatter);
  return { positions, plot: { left: 52, top: 18, right: width - 16, bottom: height - 34 }, min, max };
}

function drawDualLineChart(canvas, points, options) {
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (!points.length) {
    drawEmpty(ctx, width, height, "手動儲存快照後，這裡會顯示單股歷史");
    return;
  }

  const compact = width < 560;
  const left = compact ? 28 : 76;
  const right = width - 18;
  const gap = compact ? 38 : 34;
  const top = 24;
  const bottomPadding = compact ? 42 : 40;
  const plotHeight = Math.max(58, (height - top - bottomPadding - gap) / 2);
  const valuePlot = { left, top, right, bottom: top + plotHeight };
  const sharesPlot = {
    left,
    top: valuePlot.bottom + gap,
    right,
    bottom: valuePlot.bottom + gap + plotHeight,
  };

  const x = (index, plot) => {
    if (points.length === 1) return plot.left + (plot.right - plot.left) / 2;
    return plot.left + (index / (points.length - 1)) * (plot.right - plot.left);
  };
  const getDomain = (values) => {
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const padding = Math.max(Math.abs(max) * 0.05, 1);
      min -= padding;
      max += padding;
    } else {
      const padding = (max - min) * 0.12;
      min -= padding;
      max += padding;
    }
    return { min, max };
  };
  const drawMiniChart = ({ key, label, color, plot, formatter }) => {
    const values = points.map((point) => point[key] || 0);
    const { min, max } = getDomain(values);
    const y = (value) => plot.bottom - ((value - min) / (max - min || 1)) * (plot.bottom - plot.top);
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const maxIndex = values.indexOf(maxValue);
    const minIndex = values.indexOf(minValue);

    ctx.strokeStyle = "#e8eef6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.left, plot.top);
    ctx.lineTo(plot.right, plot.top);
    ctx.moveTo(plot.left, plot.bottom);
    ctx.lineTo(plot.right, plot.bottom);
    ctx.stroke();

    if (!compact) {
      ctx.fillStyle = "#64748b";
      ctx.font = "12px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(formatter(max), plot.left - 10, plot.top + 4);
      ctx.fillText(formatter(min), plot.left - 10, plot.bottom + 4);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((point, index) => {
      const px = x(index, plot);
      const py = y(point[key] || 0);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    ctx.fillStyle = color;
    points.forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(x(index, plot), y(point[key] || 0), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });

    const drawPointBadge = (index, title, value, offsetY) => {
      const text = `${title} ${formatter(value)}`;
      ctx.font = compact ? "700 11px system-ui" : "700 12px system-ui";
      const badgeWidth = Math.min(ctx.measureText(text).width + 14, plot.right - plot.left);
      const badgeHeight = compact ? 22 : 24;
      let bx = x(index, plot) - badgeWidth / 2;
      const by = Math.max(plot.top + 4, Math.min(plot.bottom - badgeHeight - 4, y(value) + offsetY));
      bx = Math.max(plot.left, Math.min(plot.right - badgeWidth, bx));
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.strokeStyle = "#d8dee9";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeWidth, badgeHeight, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = title === "高" ? "#b42318" : "#047857";
      ctx.textAlign = "center";
      ctx.fillText(fitCanvasText(ctx, text, badgeWidth - 10), bx + badgeWidth / 2, by + (compact ? 15 : 16));
    };

    if (points.length > 1) {
      drawPointBadge(maxIndex, "高", maxValue, compact ? -28 : -30);
      if (minIndex !== maxIndex) drawPointBadge(minIndex, "低", minValue, compact ? 10 : 12);
    } else {
      drawPointBadge(0, "值", values[0] || 0, compact ? -28 : -30);
    }

    ctx.fillStyle = color;
    ctx.font = "700 13px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(label, plot.left, plot.top - 8);

    ctx.fillStyle = "#172033";
    ctx.font = "700 14px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(formatter(values.at(-1) || 0), plot.right, plot.top - 8);
  };

  drawMiniChart({
    key: "value",
    label: "台幣總值",
    color: options.valueColor,
    plot: valuePlot,
    formatter: (value) => money(value, "TWD"),
  });
  drawMiniChart({
    key: "shares",
    label: "股數",
    color: options.sharesColor,
    plot: sharesPlot,
    formatter: (value) => number.format(value),
  });

  ctx.fillStyle = "#64748b";
  ctx.font = "12px system-ui";
  if (points.length === 1) {
    ctx.textAlign = "center";
    ctx.fillText(points[0]?.label || "", left + (right - left) / 2, height - 8);
  } else {
    ctx.textAlign = "left";
    ctx.fillText(points[0]?.label || "", left, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(points.at(-1)?.label || "", right, height - 8);
    ctx.textAlign = "center";
    ctx.fillText("日期", left + (right - left) / 2, height - 8);
  }
}

function drawDonutChart(canvas, rawData) {
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const data = rawData.filter((item) => item.value > 0);
  if (!data.length) {
    drawEmpty(ctx, width, height, "沒有資料");
    return;
  }
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const compact = width < 520;
  const radius = compact ? Math.min(width * 0.28, height * 0.24) : Math.min(width, height) * 0.32;
  const cx = compact ? width * 0.5 : width * 0.36;
  const cy = compact ? height * 0.38 : height * 0.48;
  let start = -Math.PI / 2;
  data.forEach((item, index) => {
    const angle = (item.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = item.color || palette(index);
    ctx.fill();
    start += angle;
  });
  ctx.beginPath();
  ctx.fillStyle = "#fff";
  ctx.arc(cx, cy, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#172033";
  ctx.font = compact ? "600 12px system-ui" : "600 14px system-ui";
  ctx.textAlign = "left";
  data.slice(0, 6).forEach((item, index) => {
    const x = compact ? 16 + (index % 2) * ((width - 32) / 2) : width * 0.68;
    const y = compact ? height * 0.72 + Math.floor(index / 2) * 24 : 30 + index * 26;
    const label = `${item.label} ${percent.format(item.value / total)}`;
    const maxTextWidth = compact ? (width - 44) / 2 : width - x - 18;
    ctx.fillStyle = item.color || palette(index);
    ctx.fillRect(x, y - 10, 10, 10);
    ctx.fillStyle = "#172033";
    ctx.fillText(fitCanvasText(ctx, label, maxTextWidth), x + 16, y);
  });
}

function fitCanvasText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}...`;
}

function drawAxisLabels(ctx, points, min, max, width, height, formatter) {
  ctx.fillStyle = "#64748b";
  ctx.font = "12px system-ui";
  ctx.textAlign = "left";
  ctx.fillText(formatter(max), 4, 24);
  ctx.fillText(formatter(min), 4, height - 36);
  ctx.textAlign = "center";
  ctx.fillText(points[0]?.label || "", 70, height - 10);
  ctx.fillText(points.at(-1)?.label || "", width - 68, height - 10);
}

function drawEmpty(ctx, width, height, label) {
  ctx.fillStyle = "#64748b";
  ctx.font = "14px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(label, width / 2, height / 2);
}

function fillHoldingForm(holding = {}) {
  const form = $("#holdingForm");
  form.id.value = holding.id || "";
  form.broker.value = holding.broker || "";
  form.name.value = holding.name || "";
  form.symbol.value = holding.symbol || "";
  form.quoteSymbol.value = holding.quoteSymbol || holding.symbol || "";
  form.market.value = holding.market || "US";
  form.currency.value = holding.currency || "USD";
  form.shares.value = holding.shares ?? "";
  form.categoryId.value = holding.categoryId || "uncategorized";
  $("#holdingFormTitle").textContent = holding.id ? "編輯持股" : "新增持股";
}

function fillCategoryForm(category = {}) {
  const form = $("#categoryForm");
  form.id.value = category.id || "";
  form.name.value = category.name || "";
  form.color.value = category.color || "#64748b";
  form.order.value = category.order ?? 10;
  form.archived.checked = Boolean(category.archived);
  $("#categoryFormTitle").textContent = category.id ? "編輯分類" : "新增分類";
}

document.addEventListener("click", async (event) => {
  const csvLink = event.target.closest('a[href="#"]');
  if (csvLink && supabaseEnabled) {
    event.preventDefault();
    downloadText("holdings.csv", toCsv(state), "text/csv; charset=utf-8");
    return;
  }
  const editHolding = event.target.closest("[data-edit-holding]");
  if (editHolding) {
    fillHoldingForm(state.holdings.find((holding) => holding.id === editHolding.dataset.editHolding));
    document.querySelector('[data-tab="holdings"]').click();
  }
  const archiveHolding = event.target.closest("[data-archive-holding]");
  if (archiveHolding && confirm("停用這筆持股？歷史快照不會被刪除。")) {
    await api(`/api/holdings/${archiveHolding.dataset.archiveHolding}/archive`, { method: "PATCH" });
    await load();
  }
  const editCategory = event.target.closest("[data-edit-category]");
  if (editCategory) {
    fillCategoryForm(state.allCategories.find((category) => category.id === editCategory.dataset.editCategory));
  }
});

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((item) => item.classList.remove("active"));
    $$(".tab-panel").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    $(`#${tab.dataset.tab}`).classList.add("active");
    setTimeout(renderDashboard, 0);
    setTimeout(renderStockDetail, 0);
  });
});

$("#refreshPrices").addEventListener("click", async () => {
  const button = $("#refreshPrices");
  button.disabled = true;
  setStatus("正在更新股價與匯率...");
  try {
    state = await api("/api/prices/refresh", { method: "POST", body: { force: false } });
    render();
  } catch (error) {
    setStatus(error.message, "更新失敗");
  } finally {
    button.disabled = false;
  }
});

$("#saveSnapshot").addEventListener("click", async () => {
  state = await api("/api/snapshots", { method: "POST" });
  render();
  setStatus("已儲存一筆手動快照。");
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = supabaseEnabled ? "index.html" : "/login";
});

$("#holdingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.shares = Number(payload.shares);
  const id = payload.id;
  delete payload.id;
  await api(id ? `/api/holdings/${id}` : "/api/holdings", { method: id ? "PATCH" : "POST", body: payload });
  fillHoldingForm();
  await load();
});

$("#categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.order = Number(payload.order);
  payload.archived = form.archived.checked;
  const id = payload.id;
  delete payload.id;
  await api(id ? `/api/categories/${id}` : "/api/categories", { method: id ? "PATCH" : "POST", body: payload });
  fillCategoryForm();
  await load();
});

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  await api("/api/settings", { method: "PATCH", body: payload });
  form.alphaVantageApiKey.value = "";
  await load();
  setStatus("設定已儲存。");
});

$("#exportBackup").addEventListener("click", async () => {
  if (supabaseEnabled) {
    downloadJson(`mystock-backup-${new Date().toISOString().slice(0, 10)}.json`, currentBackupData());
    setStatus("已下載完整備份。");
    return;
  }
  window.location.href = "/api/export/data.json";
});

$("#importBackup").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    validateBackupData(data);
    if (!confirm("匯入會覆蓋目前雲端資料，確定繼續？")) return;
    if (!supabaseEnabled) throw new Error("完整匯入目前只支援 Supabase 雲端版。");
    await writeSupabaseDocuments(data);
    await load();
    setStatus("完整備份已匯入 Supabase。");
  } catch (error) {
    setStatus(error.message, "匯入失敗");
  } finally {
    event.currentTarget.value = "";
  }
});

$("#resetHoldingForm").addEventListener("click", () => fillHoldingForm());
$("#resetCategoryForm").addEventListener("click", () => fillCategoryForm());
$("#newHolding").addEventListener("click", () => fillHoldingForm());
$("#newCategory").addEventListener("click", () => fillCategoryForm());
$("#stockSelect").addEventListener("change", renderStockDetail);
$$(".period-button").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    $$(".period-button").forEach((item) => item.classList.toggle("active", item === button));
    renderDashboard();
  });
});
window.addEventListener("resize", () => {
  renderDashboard();
  renderStockDetail();
});

load().catch((error) => setStatus(error.message, "載入失敗"));
