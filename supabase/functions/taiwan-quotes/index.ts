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

async function fetchTwseQuotes(quotes: Record<string, number>) {
  const response = await fetch("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json");
  if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
  const data = await response.json();
  for (const row of data.data || []) {
    const code = String(row[0] || "").trim().toUpperCase();
    const price = parseNumber(row[7]);
    if (code && price) quotes[code] = price;
  }
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
