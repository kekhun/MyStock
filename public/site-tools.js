import { importSymbol } from "./import-core.js";

const snapshotTime = (snapshot) => snapshot.createdAt || `${snapshot.date}T00:00:00`;
export const sortedSnapshots = (snapshots) => [...snapshots].sort((a, b) => snapshotTime(a).localeCompare(snapshotTime(b)));

export function compareSnapshots(snapshots, startId, endId) {
  const sorted = sortedSnapshots(snapshots);
  if (sorted.length < 2) throw new Error("至少需要兩筆快照才能比較；不會回推未記錄的部位");
  const start = startId ? sorted.find((item) => item.id === startId) : sorted.at(-2);
  const end = endId ? sorted.find((item) => item.id === endId) : sorted.at(-1);
  if (!start || !end || start.id === end.id || snapshotTime(start) > snapshotTime(end)) throw new Error("請選擇由早到晚的兩筆不同快照");
  const valueChange = end.totals.twd - start.totals.twd;
  const hasDetails = start.bySymbol != null && end.bySymbol != null;
  const symbols = hasDetails ? [...new Set([...Object.keys(start.bySymbol), ...Object.keys(end.bySymbol)])] : [];
  return {
    start: { id: start.id, date: start.date, createdAt: start.createdAt || null, valueTwd: start.totals.twd },
    end: { id: end.id, date: end.date, createdAt: end.createdAt || null, valueTwd: end.totals.twd },
    valueChangeTwd: valueChange, changeRatio: start.totals.twd ? valueChange / start.totals.twd : null,
    note: "資產變化包含股數、股價與匯率變化，不等於投資報酬或損益。",
    detailStatus: hasDetails ? "available" : "總額歷史缺少持股明細，無法比較單股變化",
    stocks: hasDetails ? symbols.map((symbol) => {
      const a = start.bySymbol[symbol]; const b = end.bySymbol[symbol];
      return { symbol, sharesBefore: a?.shares ?? 0, sharesAfter: b?.shares ?? 0, sharesChange: (b?.shares ?? 0) - (a?.shares ?? 0), valueTwdBefore: a?.valueTwd ?? 0, valueTwdAfter: b?.valueTwd ?? 0, valueNativeBefore: a?.valueNative ?? 0, valueNativeAfter: b?.valueNative ?? 0, currency: b?.currency || a?.currency, priceBefore: a?.price ?? null, priceAfter: b?.price ?? null, brokersBefore: a?.brokers || {}, brokersAfter: b?.brokers || {} };
    }) : null,
  };
}

export function portfolioView(portfolio, filters = {}) {
  const holdings = portfolio.holdings.filter((h) => (!filters.broker || h.broker === filters.broker) && (!filters.symbol || importSymbol(h.symbol) === importSymbol(filters.symbol)));
  const merged = new Map();
  const native = { USD: 0, TWD: 0 };
  for (const holding of holdings) {
    const symbol = importSymbol(holding.symbol);
    const item = merged.get(symbol) || { symbol, currency: holding.currency, shares: 0, valueTwd: 0, valueNative: 0, brokers: [] };
    item.shares += holding.shares; item.valueTwd += holding.valueTwd; item.valueNative += holding.valueNative;
    item.brokers.push({ id: holding.id, broker: holding.broker, shares: holding.shares, valueTwd: holding.valueTwd });
    native[holding.currency] = (native[holding.currency] || 0) + holding.valueNative;
    merged.set(symbol, item);
  }
  return {
    valueTwd: holdings.reduce((sum, h) => sum + h.valueTwd, 0), valueNative: native,
    fx: portfolio.prices.fx.USDTWD,
    holdings: holdings.map(({ id, broker, symbol, name, shares, market, currency, categoryId, price, priceAsOf, priceSource, valueNative, valueTwd }) => ({ id, broker, symbol, name, shares, market, currency, categoryId, price, priceAsOf, priceSource, valueNative, valueTwd })),
    merged: [...merged.values()], categories: portfolio.allCategories.map(({ id, name, archived }) => ({ id, name, archived })),
    note: "價格為最近取得的報價，可能延遲或尚未更新；無報價的持股估值為 0，不代表沒有價值。",
  };
}

export function createSiteTools({ getPortfolio, showAdjustment, previewImport }) {
  const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const string = { type: "string" };
  const define = (name, description, inputSchema, execute, readOnly = true) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false }, execute: async (args = {}) => {
    try { return await execute(args); } catch (error) { return { error: error.message }; }
  } });
  return [
    define("mystock_get_positions", "查詢目前持股、跨券商合併股數與估值。可依股票或券商篩選。不提供密鑰，也不更新股價。", schema({ symbol: string, broker: string }), async (args) => portfolioView(await getPortfolio(), args)),
    define("mystock_list_snapshots", "列出已儲存快照及日期，標明只有總額的舊歷史。", schema(), async () => ({ snapshots: sortedSnapshots((await getPortfolio()).snapshots).map((s) => ({ id: s.id, date: s.date, createdAt: s.createdAt || null, valueTwd: s.totals.twd, hasStockDetails: s.bySymbol != null })) })),
    define("mystock_compare_snapshots", "比較指定兩筆快照；省略 ID 時比較最新兩筆。總額歷史不推算單股股數；變化不等於報酬。", schema({ startId: string, endId: string }), async ({ startId, endId }) => compareSnapshots((await getPortfolio()).snapshots, startId, endId)),
    define("mystock_preview_adjustment", "預覽一筆持股加碼或減碼，打開確認視窗。須使用查詢取得的 holdingId；不儲存，必須由使用者在網頁確認。", schema({ holdingId: string, direction: { enum: ["increase", "decrease"], type: "string" }, amount: { type: "number", exclusiveMinimum: 0 } }, ["holdingId", "direction", "amount"]), async (args) => {
      const portfolio = await getPortfolio();
      const holding = portfolio.holdings.find((h) => h.id === args.holdingId);
      if (!holding || !["increase", "decrease"].includes(args.direction) || !Number.isFinite(args.amount) || args.amount <= 0 || args.amount > 1e12) throw new Error("持股或調整股數不正確");
      const next = Number((holding.shares + (args.direction === "increase" ? args.amount : -args.amount)).toFixed(8));
      if (next < 0 || args.amount !== Number(args.amount.toFixed(4))) throw new Error("減碼不可超過目前股數；調整最多 4 位小數");
      showAdjustment(holding, args.direction, args.amount);
      return { awaitingUserConfirmation: true, broker: holding.broker, symbol: holding.symbol, sharesBefore: holding.shares, sharesAfter: next };
    }, false),
    define("mystock_preview_import", "將已擷取的券商部位送至差異預覽；shares 是目前總股數，不是交易增加數。不得自行推算張數。只預覽，需由使用者在網頁勾選、確認套用。", schema({ rows: { type: "array", minItems: 1, maxItems: 2000, items: schema({ broker: string, symbol: string, shares: { type: "number", minimum: 0 }, name: string, market: { type: "string", enum: ["US", "TW"] }, currency: { type: "string", enum: ["USD", "TWD"] }, categoryId: string }, ["broker", "symbol", "shares"]) } }, ["rows"]), async ({ rows }) => { await getPortfolio(); return previewImport(rows); }, false),
  ];
}

export async function registerSiteTools(callbacks, context = globalThis.document?.modelContext) {
  if (typeof context?.registerTool !== "function") return false;
  for (const tool of createSiteTools(callbacks)) await context.registerTool(tool);
  return true;
}
