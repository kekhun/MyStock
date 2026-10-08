import { importShares, importSymbol } from "./import-core.js";

const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s_.-]/g, "");
const benefitTypes = new Map([["restrictedstock", "RS"], ["espp", "ESPP"]]);

export function brokerAccountLabel(broker) {
  return String(broker).replace(/^E\*TRADE Stock Plan \((RS|ESPP)\)$/, "E*TRADE $1");
}

export function extractStockPlan(sheets) {
  const candidates = sheets.filter(({ name }) => benefitTypes.has(normalized(name)));
  if (!candidates.some(({ rows }) => rows.some((row) => row.some((cell) => normalized(cell) === "sellableqty")))) return null;
  const positions = [];
  const summaries = [];
  for (const { name, rows } of candidates) {
    const benefit = benefitTypes.get(normalized(name));
    const headerIndex = rows.findIndex((row) => ["recordtype", "symbol", "sellableqty"].every((field) => row.some((cell) => normalized(cell) === field)));
    if (headerIndex < 0) throw new Error(`${name} 缺少 Record Type、Symbol 或 Sellable Qty. 欄位`);
    const header = rows[headerIndex].map(normalized);
    const typeColumn = header.indexOf("recordtype");
    const symbolColumn = header.indexOf("symbol");
    const quantityColumn = header.indexOf("sellableqty");
    const bySymbol = new Map();
    let declaredTotal = null;
    let count = 0;
    for (const [index, row] of rows.slice(headerIndex + 1).entries()) {
      if (row.every((cell) => String(cell ?? "").trim() === "")) continue;
      const type = normalized(row[typeColumn]);
      if (type === "totals" || type === "total") {
        if (declaredTotal != null) throw new Error(`${name} 有多筆 Totals，請確認檔案格式`);
        declaredTotal = importShares(row[quantityColumn]);
        continue;
      }
      if (!["grant", "purchase"].includes(type)) throw new Error(`${name} 第 ${headerIndex + index + 2} 列的 Record Type 無法辨識`);
      const symbol = importSymbol(row[symbolColumn]);
      if (!symbol) throw new Error(`${name} 第 ${headerIndex + index + 2} 列缺少股票代號`);
      const shares = importShares(row[quantityColumn]);
      bySymbol.set(symbol, Number(((bySymbol.get(symbol) || 0) + shares).toFixed(8)));
      count++;
    }
    if (!count) throw new Error(`${name} 沒有可核對的 Grant / Purchase 明細`);
    const total = [...bySymbol.values()].reduce((sum, shares) => sum + shares, 0);
    if (declaredTotal != null && Math.abs(declaredTotal - total) > 1e-8) throw new Error(`${name} 的 Sellable Qty. 明細加總與 Totals 不符，未建立預覽`);
    summaries.push({ benefit, shares: total, records: count });
    for (const [symbol, shares] of bySymbol) positions.push({ broker: `E*TRADE Stock Plan (${benefit})`, symbol, shares, market: "US", currency: "USD" });
  }
  return { rows: positions, summaries };
}
