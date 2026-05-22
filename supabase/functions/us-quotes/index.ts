const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function normalizeSymbol(symbol = "") {
  return String(symbol).trim().replace(/^NASDAQ:/i, "").replace(/\.US$/i, "").toUpperCase();
}

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (value == null) return null;
  const clean = String(value).replace(/,/g, "").trim();
  if (!clean || clean === "--" || clean === "N/D") return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function parseCsvLine(line: string) {
  const values: string[] = [];
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

async function fetchWithTimeout(url: string, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFinnhubQuote(symbol: string, token: string) {
  const normalized = normalizeSymbol(symbol);
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", normalized);
  url.searchParams.set("token", token);
  const response = await fetchWithTimeout(url.toString(), {}, 5000);
  if (!response.ok) throw new Error(`Finnhub ${normalized} HTTP ${response.status}`);
  const data = await response.json();
  const price = parseNumber(data?.c);
  if (!price) throw new Error(`Finnhub ${normalized} 沒有回傳價格`);
  return {
    price,
    currency: "USD",
    asOf: data?.t ? new Date(Number(data.t) * 1000).toISOString() : new Date().toISOString(),
    source: "finnhub",
  };
}

async function fetchFinnhubQuotes(symbols: string[]) {
  const token = Deno.env.get("FINNHUB_API_KEY")?.trim();
  if (!token) throw new Error("尚未設定 FINNHUB_API_KEY");
  const quotes: Record<string, { price: number; asOf: string; source: string; currency: string }> = {};
  const errors: string[] = [];
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];

  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        quotes[symbol] = await fetchFinnhubQuote(symbol, token);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    })
  );

  return { quotes, errors };
}

async function fetchStooqQuotes(symbols: string[]) {
  if (!symbols.length) return {};
  const stooqSymbols = symbols.map((symbol) => `${normalizeSymbol(symbol).toLowerCase()}.us`);
  const url = `https://stooq.com/q/l/?s=${stooqSymbols.map(encodeURIComponent).join("+")}&f=sd2t2ohlcv&h&e=csv`;
  const response = await fetchWithTimeout(url, {}, 8000);
  if (!response.ok) throw new Error(`Stooq HTTP ${response.status}`);
  const text = await response.text();
  const quotes: Record<string, { price: number; asOf: string; source: string; currency: string }> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [rawSymbol, date, time, , , , close] = parseCsvLine(line);
    const price = parseNumber(close);
    const symbol = normalizeSymbol(rawSymbol);
    if (symbol && price) {
      quotes[symbol] = {
        price,
        currency: "USD",
        asOf: date && time ? new Date(`${date}T${time}Z`).toISOString() : new Date().toISOString(),
        source: "stooq-batch",
      };
    }
  }
  return quotes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const symbols = (url.searchParams.get("symbols") || "")
      .split(",")
      .map(normalizeSymbol)
      .filter(Boolean);
    const uniqueSymbols = [...new Set(symbols)];
    const { quotes, errors } = await fetchFinnhubQuotes(uniqueSymbols).catch((error) => ({
      quotes: {},
      errors: [error instanceof Error ? error.message : String(error)],
    }));
    const missingSymbols = uniqueSymbols.filter((symbol) => !quotes[symbol]);
    const stooqQuotes = missingSymbols.length ? await fetchStooqQuotes(missingSymbols).catch(() => ({})) : {};
    const mergedQuotes = { ...stooqQuotes, ...quotes };
    if (!Object.keys(mergedQuotes).length) {
      throw new Error(errors[0] || "美股報價來源沒有可解析的價格");
    }
    return new Response(JSON.stringify({ quotes: mergedQuotes, asOf: new Date().toISOString(), errors }), {
      headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
    });
  }
});
