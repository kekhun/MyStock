import { escapeHtml as html, planImport } from "./import-core.js";
import { extractStockPlan } from "./stock-plan.js";

const fields = [
  ["symbol", "股票代號", ["symbol", "ticker", "股票代號", "證券代號", "代號", "股票代碼"]],
  ["shares", "目前總股數", ["shares", "quantity", "qty", "position", "股數", "庫存股數", "持股股數", "持有數量", "數量", "餘額股數"]],
  ["broker", "券商", ["broker", "券商", "券商名稱"]],
  ["name", "名稱", ["name", "description", "名稱", "證券名稱", "股票名稱"]],
  ["market", "市場", ["market", "市場"]],
  ["currency", "幣別", ["currency", "幣別", "幣種"]],
];
const labels = { new: "新增", update: "更新", unchanged: "不變", error: "待處理" };
const number = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 8 });
const normalizedHeader = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s_\-\ufeff]/g, "");
let libraryPromise;
function spreadsheetLibrary() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/xlsx.full.min.js";
    script.onload = () => resolve(globalThis.XLSX);
    script.onerror = () => { libraryPromise = null; script.remove(); reject(new Error("試算表元件載入失敗，請重試")); };
    document.head.append(script);
  });
  return libraryPromise;
}

export function setupImporter({ getPortfolio, refreshPortfolio, applyChanges, navigate }) {
  const $ = (id) => document.getElementById(id);
  let workbook = null;
  let grid = [];
  let staged = [];
  let sourceRows = null;
  let busy = false;
  let fileRevision = 0;
  let stockPlan = null;
  const message = (text, error = false) => { $("importMessage").textContent = text; $("importMessage").classList.toggle("import-error", error); };
  const defaults = () => ({ broker: $("importBroker").value.trim(), categoryId: $("importCategory").value, market: $("importMarket").value || undefined });
  function renderDefaults() {
    const portfolio = getPortfolio();
    if (!portfolio) return;
    const selected = $("importCategory").value;
    $("importCategory").innerHTML = '<option value="">選擇分類</option>' + portfolio.allCategories.filter((c) => !c.archived).map((c) => `<option value="${html(c.id)}">${html(c.name)}</option>`).join("");
    $("importCategory").value = selected;
    $("importBrokerList").innerHTML = [...new Set(portfolio.holdings.map((h) => h.broker))].map((broker) => `<option value="${html(broker)}"></option>`).join("");
  }
  function renderPreview() {
    $("importPreview").hidden = !staged.length;
    const selected = staged.filter((row) => row.selected && row.status !== "error");
    $("applyImport").disabled = busy || !selected.length;
    for (const id of ["selectImportRows", "clearImportRows", "recheckImport"]) $(id).disabled = busy;
    $("applyImport").textContent = busy ? "套用中…" : `確認套用 ${selected.length} 筆`;
    $("importCounts").textContent = Object.entries(labels).map(([key, label]) => `${label} ${staged.filter((row) => row.status === key).length}`).join(" · ");
    $("importRows").innerHTML = staged.map((row, index) => `<tr class="import-row-${row.status}">
      <td><input type="checkbox" data-import-row="${index}" aria-label="選取第 ${html(row.line)} 列" ${row.selected ? "checked" : ""} ${row.status === "error" || row.status === "unchanged" || busy ? "disabled" : ""}></td>
      <td>${html(row.line)}</td><td>${html(row.broker)}</td><td><strong>${html(row.symbol)}</strong></td>
      <td class="numeric">${row.before == null ? "—" : number.format(row.before)}</td>
      <td class="numeric">${row.status === "error" ? html(row.shares) : number.format(row.shares)}</td>
      <td class="numeric ${row.delta < 0 ? "import-negative" : "import-positive"}">${row.delta == null ? "—" : `${row.delta > 0 ? "+" : ""}${number.format(row.delta)}`}</td>
      <td><span class="import-badge">${labels[row.status]}</span>${row.error ? `<span class="import-row-error">${html(row.error)}</span>` : ""}</td>
    </tr>`).join("");
  }
  function buildPreview() {
    if (!sourceRows && !grid.length) return;
    try {
      let rows = sourceRows;
      if (!rows) {
        const mapping = Object.fromEntries(fields.map(([key]) => [key, $("map-" + key).value]));
        if (mapping.symbol === "" || mapping.shares === "") throw new Error("請選擇股票代號與股數欄位");
        rows = grid.slice(Number($("importHeader").value) + 1).map((cells, index) => ({ cells, line: Number($("importHeader").value) + index + 2 }))
          .filter(({ cells }) => cells.some((value) => String(value ?? "").trim()))
          .map(({ cells, line }) => ({ line, ...Object.fromEntries(fields.map(([key]) => [key, mapping[key] === "" ? "" : cells[Number(mapping[key])] ?? ""])) }));
      }
      const portfolio = getPortfolio();
      staged = planImport(rows, [...portfolio.holdings, ...portfolio.archivedHoldings], portfolio.allCategories, defaults());
      const context = stockPlan ? `Stock Plan：${stockPlan.summaries.map((item) => `${item.benefit} 可出售 ${number.format(item.shares)} 股`).join("；")}。只計 Sellable Qty.，不計未歸屬股份、選擇權與 Totals 列。` : "";
      message(context + (staged.some((row) => row.status === "error") ? "待處理列不會套用；請核對欄位、股數單位與市場。" : "尚未變更持股。未列於本次匯入的部位會保留，歷史快照不受影響。"));
    } catch (error) { staged = []; message(error.message, true); }
    renderPreview();
  }
  function mapColumns() {
    const header = grid[Number($("importHeader").value)] || [];
    for (const [key, , aliases] of fields) {
      const select = $("map-" + key);
      select.innerHTML = '<option value="">不指定</option>' + header.map((cell, index) => `<option value="${index}">${index + 1}. ${html(cell || "空白欄")}</option>`).join("");
      const guess = header.findIndex((cell) => aliases.some((alias) => normalizedHeader(cell) === normalizedHeader(alias)));
      select.value = guess < 0 ? "" : String(guess);
    }
    buildPreview();
  }
  function selectSheet() {
    const XLSX = globalThis.XLSX;
    const sheet = workbook.Sheets[$("importSheet").value];
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    if (range.e.r > 10000 || range.e.c > 100) throw new Error("工作表超過 10,000 列或 100 欄，請另存僅含持股的檔案");
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true, range: 0 });
    sourceRows = null;
    $("importHeader").innerHTML = grid.slice(0, 50).map((cells, index) => `<option value="${index}">第 ${index + 1} 列 · ${html(cells.slice(0, 4).join(" / ").slice(0, 80))}</option>`).join("");
    const guess = grid.slice(0, 50).findIndex((cells) => fields.slice(0, 2).every(([, , aliases]) => cells.some((cell) => aliases.some((alias) => normalizedHeader(alias) === normalizedHeader(cell)))));
    $("importHeader").value = String(Math.max(0, guess));
    $("importMapping").hidden = false;
    mapColumns();
  }
  async function readFile() {
    const revision = ++fileRevision;
    const file = $("positionFile").files?.[0];
    const encoding = $("importEncoding").value;
    staged = []; sourceRows = null; grid = []; workbook = null; stockPlan = null; renderPreview();
    $("importMapping").hidden = true;
    if (!file) { message("請選擇券商部位檔案"); return; }
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("檔案上限 10 MB");
      if (!/\.(csv|xlsx|xls)$/i.test(file.name)) throw new Error("請選擇 CSV、XLSX 或 XLS 檔案");
      message("正在讀取檔案…");
      const XLSX = await spreadsheetLibrary();
      const bytes = await file.arrayBuffer();
      if (revision !== fileRevision) return;
      const isCsv = /\.csv$/i.test(file.name);
      workbook = XLSX.read(isCsv ? new TextDecoder(encoding).decode(bytes) : bytes, { type: isCsv ? "string" : "array", raw: true, cellFormula: false, cellHTML: false, sheetRows: 10002 });
      const sheets = workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
        if (range.e.r > 10000 || range.e.c > 100) throw new Error("工作表超過 10,000 列或 100 欄，請另存僅含持股的檔案");
        return { name, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true, range: 0 }) };
      });
      stockPlan = extractStockPlan(sheets);
      if (stockPlan) {
        sourceRows = stockPlan.rows;
        buildPreview();
        return;
      }
      $("importSheet").innerHTML = workbook.SheetNames.map((name) => `<option>${html(name)}</option>`).join("");
      selectSheet();
    } catch (error) { if (revision === fileRevision) message(`讀取失敗：${error.message}`, true); }
  }
  $("importFields").innerHTML = fields.map(([key, label]) => `<label>${label}<select id="map-${key}" aria-label="${label}欄位"></select></label>`).join("");
  $("positionFile").addEventListener("change", readFile);
  $("importEncoding").addEventListener("change", readFile);
  $("importSheet").addEventListener("change", () => { try { selectSheet(); } catch (e) { staged = []; renderPreview(); message(e.message, true); } });
  $("importHeader").addEventListener("change", mapColumns);
  $("importFields").addEventListener("change", buildPreview);
  for (const id of ["importBroker", "importCategory", "importMarket"]) $(id).addEventListener("change", buildPreview);
  $("importRows").addEventListener("change", (event) => {
    if (!event.target.matches("[data-import-row]")) return;
    const row = staged[Number(event.target.dataset.importRow)];
    if (row && !["error", "unchanged"].includes(row.status)) row.selected = event.target.checked;
    renderPreview();
  });
  $("selectImportRows").addEventListener("click", () => { staged.forEach((row) => { row.selected = !["error", "unchanged"].includes(row.status); }); renderPreview(); });
  $("clearImportRows").addEventListener("click", () => { staged.forEach((row) => { row.selected = false; }); renderPreview(); });
  $("recheckImport").addEventListener("click", async () => { try { await refreshPortfolio(); renderDefaults(); buildPreview(); } catch (e) { message(e.message, true); } });
  $("applyImport").addEventListener("click", async () => {
    const changes = staged.filter((row) => row.selected && !["error", "unchanged"].includes(row.status)).map((row) => row.change);
    if (busy || !changes.length) return;
    if (!confirm(`確認套用 ${changes.length} 筆持股？股數將改為預覽中的目前總股數。未列出的持股保持不變；不會自動建立快照。`)) return;
    busy = true; renderPreview(); $("importControls").disabled = true;
    try {
      await applyChanges(changes);
      await refreshPortfolio();
      buildPreview();
      message(`已套用 ${changes.length} 筆持股。歷史快照未變更；需要記錄今天部位時再儲存快照。`);
    } catch (error) { message(`未完成：${error.message}。請重新比對後再確認。`, true); }
    finally { busy = false; $("importControls").disabled = false; renderPreview(); }
  });
  $("importPositions").addEventListener("click", () => { renderDefaults(); navigate(); });
  document.querySelector('[data-tab="import"]').addEventListener("click", renderDefaults);
  return {
    stageRows(rows) {
      if (busy) throw new Error("匯入正在套用中，請稍候");
      fileRevision++;
      stockPlan = null;
      renderDefaults(); sourceRows = rows; grid = []; staged = [];
      $("positionFile").value = ""; $("importMapping").hidden = true;
      buildPreview(); navigate();
      return { awaitingUserConfirmation: true, rows: staged.map(({ broker, symbol, before, shares, delta, status, error }) => ({ broker, symbol, before, shares, delta, status, error })), note: "尚未套用。新增持股缺少分類時，請在匯入頁選擇分類後重新預覽。" };
    },
  };
}
