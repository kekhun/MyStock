export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function importSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/^(NASDAQ|NYSE|AMEX|TPE|TPEX):/, "").replace(/\.(TW|TWO)$/, "");
}

function text(value, label) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 120 || /[\u0000-\u001f]/.test(result)) throw new Error(`${label}不可空白，且須少於 120 字`);
  return result;
}

export function importShares(value) {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > 1e12 || Number(value.toFixed(8)) !== value)) throw new Error("股數須為非負數，最多 8 位小數");
  const raw = typeof value === "number" ? value.toFixed(8) : String(value ?? "").trim();
  // Only accept plain decimal numbers and properly grouped thousands separators.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,8})?$/.test(raw)) throw new Error("股數須為非負數，最多 8 位小數；不可使用張數或公式");
  const shares = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(shares) || shares > 1e12) throw new Error("股數超過可接受範圍");
  return shares;
}

const keyOf = (row) => JSON.stringify([String(row.broker).trim(), importSymbol(row.symbol)]);

export function planImport(rows, holdings, categories, defaults = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error("請提供 1 至 2,000 筆持股");
  const plan = rows.map((source, index) => {
    const row = { index, line: source.line ?? index + 1, broker: source.broker || defaults.broker || "", symbol: source.symbol || "", shares: source.shares, selected: false };
    try {
      row.broker = text(row.broker, "券商");
      if (Object.hasOwn(Object.prototype, row.broker)) throw new Error("請使用其他券商名稱");
      row.symbol = importSymbol(text(row.symbol, "股票代號"));
      const rawMarket = String(source.market || "").trim().toUpperCase();
      const rawCurrency = String(source.currency || "").trim().toUpperCase();
      if (rawMarket && !["TW", "US", "台股", "美股", "台灣", "美國"].includes(rawMarket)) throw new Error("市場只支援 TW / US");
      if (rawCurrency && !["USD", "TWD", "NTD", "台幣", "美元"].includes(rawCurrency)) throw new Error("幣別只支援 USD / TWD");
      const inferred = /^\d{1,6}[A-Z]?$/.test(row.symbol) ? "TW" : "US";
      const market = rawMarket ? (["TW", "台股", "台灣"].includes(rawMarket) ? "TW" : "US") : rawCurrency ? (["USD", "美元"].includes(rawCurrency) ? "US" : "TW") : defaults.market || inferred;
      if (market === "TW" && /^\d{1,3}$/.test(row.symbol)) row.symbol = row.symbol.padStart(4, "0");
      if (!/^[A-Z0-9][A-Z0-9.\-^=]{0,23}$/.test(row.symbol)) throw new Error("股票代號格式不正確");
      const currency = market === "TW" ? "TWD" : "USD";
      if (rawCurrency && (["USD", "美元"].includes(rawCurrency) ? "USD" : "TWD") !== currency) throw new Error("市場與幣別不一致");
      row.shares = importShares(source.shares);
      const matches = holdings.filter((holding) => keyOf(holding) === keyOf(row));
      if (matches.length > 1) throw new Error("現有持股有重複券商／代號，請先整理");
      const existing = matches[0];
      if (existing?.archived) throw new Error("這筆持股已停用，請先確認是否要恢復追蹤");
      if (existing && ((rawMarket && existing.market !== market) || (rawCurrency && existing.currency !== currency))) throw new Error("市場／幣別與現有持股不同");
      const sameSymbol = holdings.find((holding) => !holding.archived && importSymbol(holding.symbol) === row.symbol);
      const categoryId = existing?.categoryId || source.categoryId || sameSymbol?.categoryId || defaults.categoryId;
      if (!existing && !categories.some((category) => category.id === categoryId && !category.archived)) throw new Error("請選擇新增持股的分類");
      row.before = existing ? Number(existing.shares) : null;
      row.delta = row.shares - (row.before ?? 0);
      row.status = existing ? (row.delta === 0 ? "unchanged" : "update") : "new";
      row.selected = row.status !== "unchanged";
      row.change = {
        id: existing?.id || null, expectedShares: row.before, broker: row.broker, symbol: row.symbol,
        shares: row.shares, name: existing?.name || text(source.name || row.symbol, "名稱"),
        quoteSymbol: existing?.quoteSymbol || row.symbol, market: existing?.market || market,
        currency: existing?.currency || currency, categoryId,
      };
    } catch (error) {
      row.status = "error";
      row.error = error.message;
      row.selected = false;
    }
    return row;
  });
  const counts = new Map();
  for (const row of plan) if (row.status !== "error") counts.set(keyOf(row), (counts.get(keyOf(row)) || 0) + 1);
  for (const row of plan) if (counts.get(keyOf(row)) > 1) Object.assign(row, { status: "error", error: "檔案中券商／股票代號重複，請勿重複計入", selected: false });
  return plan;
}

export function applyImport(holdings, categories, changes, makeId) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) throw new Error("請選取要套用的持股");
  const plan = planImport(changes, holdings, categories);
  // Validate the entire batch before changing anything, including stale previews.
  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    const change = changes[i];
    if (row.status === "error") throw new Error(`${row.symbol}：${row.error}`);
    if (change.id !== row.change.id || change.expectedShares !== row.before) throw new Error(`${row.symbol} 的持股已變動，請重新預覽`);
  }
  const result = holdings.map((holding) => ({ ...holding }));
  for (const row of plan) {
    if (row.change.id) result.find((holding) => holding.id === row.change.id).shares = row.shares;
    else {
      const { expectedShares, id, ...holding } = row.change;
      result.push({ ...holding, id: makeId("holding"), archived: false });
    }
  }
  return result;
}
