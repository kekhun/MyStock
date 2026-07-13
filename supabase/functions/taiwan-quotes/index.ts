const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (value == null) return null;
  const clean = String(value).replace(/,/g, "").trim();
  if (!clean || clean === "--") return null;
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

function addTwseJsonQuotes(data: unknown, quotes: Record<string, number>) {
  const rows = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data || [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const code = String(row[0] || "").trim().toUpperCase();
      const price = parseNumber(row[7]);
      if (code && price) quotes[code] = price;
    } else if (row && typeof row === "object") {
      const item = row as Record<string, unknown>;
      const code = String(item.Code || item.code || item["證券代號"] || "").trim().toUpperCase();
      const price = parseNumber(item.ClosingPrice || item.closingPrice || item["收盤價"]);
      if (code && price) quotes[code] = price;
    }
  }
}

function addTwseCsvQuotes(text: string, quotes: Record<string, number>) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return;
  const headers = parseCsvLine(lines[0]);
  const codeIndex = headers.findIndex((header) => /證券代號|Code/i.test(header));
  const closeIndex = headers.findIndex((header) => /收盤價|ClosingPrice/i.test(header));
  if (codeIndex < 0 || closeIndex < 0) return;
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const code = String(row[codeIndex] || "").trim().toUpperCase();
    const price = parseNumber(row[closeIndex]);
    if (code && price) quotes[code] = price;
  }
}

async function fetchTwseQuotes(quotes: Record<string, number>) {
  const response = await fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json");
  if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
  const text = await response.text();
  const before = Object.keys(quotes).length;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) addTwseJsonQuotes(JSON.parse(trimmed), quotes);
  else addTwseCsvQuotes(text, quotes);
  if (Object.keys(quotes).length === before) throw new Error("TWSE 沒有可解析的收盤價");
}

async function fetchTwseOpenApiQuotes(quotes: Record<string, number>) {
  const response = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  if (!response.ok) throw new Error(`TWSE OpenAPI HTTP ${response.status}`);
  const data = await response.json();
  const before = Object.keys(quotes).length;
  addTwseJsonQuotes(data, quotes);
  if (Object.keys(quotes).length === before) throw new Error("TWSE OpenAPI 沒有可解析的收盤價");
}

async function fetchTpexQuotes(quotes: Record<string, number>) {
  const response = await fetch("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes");
  if (!response.ok) throw new Error(`TPEx HTTP ${response.status}`);
  const data = await response.json();
  for (const table of data.tables || []) {
    for (const row of table.data || []) {
      const code = String(row[0] || "").trim().toUpperCase();
      const price = parseNumber(row[2]);
      if (code && price) quotes[code] = price;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const quotes: Record<string, number> = {};
    const details: Array<{ source: string; ok: boolean; message: string }> = [];

    try {
      await fetchTwseQuotes(quotes);
      details.push({ source: "TWSE", ok: true, message: "ok" });
    } catch (error) {
      details.push({ source: "TWSE", ok: false, message: error instanceof Error ? error.message : String(error) });
      try {
        await fetchTwseOpenApiQuotes(quotes);
        details.push({ source: "TWSE OpenAPI", ok: true, message: "ok" });
      } catch (fallbackError) {
        details.push({ source: "TWSE OpenAPI", ok: false, message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
      }
    }

    try {
      await fetchTpexQuotes(quotes);
      details.push({ source: "TPEx", ok: true, message: "ok" });
    } catch (error) {
      details.push({ source: "TPEx", ok: false, message: error instanceof Error ? error.message : String(error) });
    }

    return new Response(JSON.stringify({ quotes, details, asOf: new Date().toISOString() }), {
      headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
    });
  }
});
