# MyStock 股票部位追蹤

本機 Web App，用來追蹤多券商股票部位、分類配置、總資產時間軸與單一股票的股數/總值變化。

## 啟動

```bash
node server.mjs
```

打開：

```text
http://127.0.0.1:3000
```

本機預設使用 `data/` 內的 JSON 檔。若設定 `DATABASE_URL`，會改用 PostgreSQL，並在資料庫第一次啟動時自動從 `data/*.json` 匯入初始資料。

## 匯入券商部位

在「持股 → 匯入部位」或「匯入」頁籤選擇 CSV、XLSX 或 XLS。檔案在瀏覽器解析，不會上傳原始文件；確認後只送出勾選的部位資料。

1. 選擇工作表、欄位名稱所在列，以及「股票代號」「目前總股數」對應欄位。台灣券商 CSV 若有亂碼，可切換 Big5。
2. 檔案沒有券商欄時填預設券商；新增持股可沿用相同代號的現有分類，或選預設分類。市場可手動指定，預設以數字代號判定台股、其他判定美股。
3. 在差異預覽核對原股數、新總股數及增減量，取消不需要套用的列，再確認套用。

股數必須是「股」，不是「張」；不會猜測或乘以 1,000。同券商同代號更新總股數，不累加；未列出的持股保留。重複列、已停用部位、負股數、缺少分類等會標為待處理且不套用。清倉可匯入 0 股；不會自動停用。這不是交易紀錄匯入，價格、分類、歷史快照均不覆寫，也不自動建立快照。套用時若股數已與預覽不同，整批拒絕並要求重新比對。

支援最多 2,000 筆持股、10 MB 檔案；工作表上限 10,000 列、100 欄。各券商格式不同，仍需確認欄位、券商與股數單位。

### E*TRADE Stock Plan

Stock Plan 的 `ByBenefitType` Excel 可直接匯入。工具會分別加總 `Restricted Stock`（RS）與 `ESPP` 工作表各筆明細的 `Sellable Qty.`，以 `E*TRADE Stock Plan (RS)`、`E*TRADE Stock Plan (ESPP)` 保存。若有 Totals，會核對明細加總，但不重複計入 Totals。空白股數、缺少代號或加總不符時停止預覽，不猜測數字。

一般帳戶沿用 `E*TRADE`。總覽與單股頁會合併同代號的股數及市值，各來源仍可分開調整。未歸屬股份、待釋出股份、未行使選擇權與表內估計市值不匯入；估值使用工具的最新價格。以前手動合併的持股須先停用，避免與分帳戶部位重複計入；這不會修改舊快照。

## ChatGPT Site tools

已提供 5 項 WebMCP 工具：查詢持股（含跨券商合併）、列出快照、比較兩筆快照、預覽加減碼、預覽匯入。它們不提供 API key，不會自動下單、更新價格、建立快照或直接修改持股。修改須在網頁確認；匯入沿用相同的差異預覽與驗證流程。只有總額的舊快照不會推算單股歷史，資產變化也不當作投資報酬。

在支援 Site tools 的 ChatGPT 桌面內建瀏覽器開啟 MyStock 並登入後，地址列的 Site tools 可列出工具。可詢問「合併各券商的 VOO 股數」或「比較最新兩筆快照」。功能依客戶端、模型、工作區政策與推出狀態而定；一般瀏覽器可正常使用網頁，但不一定提供對話工具。設定頁會顯示連線狀態。關閉頁面後，工具不再可用。

官方說明：<https://learn.chatgpt.com/docs/webmcp>。試算表解析使用本機隨附的 SheetJS CE 0.20.3，授權位於 `public/vendor/SheetJS-LICENSE.txt`，不依賴遠端 CDN。

## 登入保護

部署到公開網址前請設定：

```bash
APP_PASSWORD=你的登入密碼
```

有設定 `APP_PASSWORD` 時，首頁和 API 都需要先登入。沒有設定時，本機開發會維持免登入。

## 免費雲端部署：Supabase Free + GitHub Pages

Koyeb 註冊時如果只給 Pro plan 結帳頁，就不要繼續。這個專案改用 Supabase Free 儲存資料，GitHub Pages 放前端網頁。整體流程是：

```text
本機 MyStock 資料夾 -> GitHub -> GitHub Pages 靜態網頁 -> Supabase 資料庫 -> 手機瀏覽器登入使用
```

注意：GitHub Free 的 GitHub Pages 只能從 public repository 發佈。這個專案已用 `.gitignore` 排除 `data/*.json`，不要把本機資產資料推到 GitHub。

上傳到 GitHub 前可以用這個指令確認本機資料沒有被追蹤：

```bash
git ls-files data
```

如果沒有任何輸出，代表 `data/*.json` 沒有被 commit。

### 0. 需要先準備

- GitHub 帳號
- Supabase 帳號：https://supabase.com
- 這個專案資料夾：`/Users/kai/Documents/CodexProject/MyStock`

### 1. 把專案放到 GitHub

GitHub Pages 會從 GitHub repo 發佈網頁。完全沒用過 Git 的話，建議用 GitHub Desktop：

1. 下載並安裝 GitHub Desktop：https://desktop.github.com
2. 打開 GitHub Desktop 並登入 GitHub。
3. 選 `File` -> `Add Local Repository...`。
4. 選這個資料夾：

```text
/Users/kai/Documents/CodexProject/MyStock
```

5. 如果 GitHub Desktop 提示這不是 git repository，選 `create a repository`。
6. Repository name 可填：

```text
mystock-tracker
```

7. 按 `Publish repository`。
8. 如果要使用 GitHub Free 的 GitHub Pages，repository 需要是 `Public`。

完成後，確認 GitHub 網站上看得到這個 repo。

### 2. 建立 Supabase 專案

1. 打開 Supabase：https://supabase.com
2. 登入後按 `New project`。
3. Organization 選你的帳號。
4. Project name 可填：

```text
mystock-tracker
```

5. 設定一組 database password，自己保存好。
6. Region 選離你近的地區。
7. Plan 選 `Free`。
8. 建立後等 Supabase 初始化完成。

### 3. 建立資料表和安全規則

1. 進入 Supabase 專案。
2. 左側選 `SQL Editor`。
3. 按 `New query`。
4. 打開本專案的檔案：

```text
supabase/schema.sql
```

5. 複製整份 SQL，貼到 Supabase SQL Editor。
6. 按 `Run`。

這會建立 `mystock_documents` 資料表，並啟用 Row Level Security。每個登入使用者只能讀寫自己的資料。

### 4. 取得 Supabase 前端設定

1. 在 Supabase 專案左側選 `Project Settings`。
2. 找 `API`。
3. 複製：
   - Project URL
   - anon public key
4. 回到本機專案，打開：

```text
public/config.js
```

5. 填入你的 Supabase 設定：

```js
window.MYSTOCK_CONFIG = {
  supabaseUrl: "https://你的專案.supabase.co",
  supabaseAnonKey: "你的 anon public key",
};
```

`supabaseUrl` 請使用專案根網址，不要加 `/rest/v1/`。正確範例：

```text
https://sranxapozauqyidneilt.supabase.co
```

錯誤範例：

```text
https://sranxapozauqyidneilt.supabase.co/rest/v1/
```

`anon public key` 可以放在前端和 public GitHub repo，真正保護資料的是 Supabase 的登入和 Row Level Security。不要使用或公開 `service_role` / `secret` key。

### 5. 部署報價 Edge Functions

GitHub Pages 是靜態網頁，瀏覽器直接抓 TPEx 櫃買資料或美股報價時可能會被 CORS 擋住。這個專案用 Supabase Edge Functions 幫忙抓價：

- `taiwan-quotes`：台股 / 櫃買報價，例如 `00679B`、`00719B`
- `us-quotes`：美股報價，優先用 Finnhub，缺漏時用 Stooq，最後才回到 Alpha Vantage 備援

先安裝 Supabase CLI：

```bash
brew install supabase/tap/supabase
```

登入 Supabase：

```bash
supabase login
```

到 Supabase 專案頁面，複製 project ref。Project ref 是 Project URL 裡 `.supabase.co` 前面那串，例如：

```text
https://sranxapozauqyidneilt.supabase.co
        ^^^^^^^^^^^^^^^^^^^^
```

在本機專案資料夾連結 Supabase 專案：

```bash
supabase link --project-ref 你的-project-ref
```

申請 Finnhub 免費 API key：

1. 到 [Finnhub](https://finnhub.io/) 建立帳號。
2. 登入後複製 API key。
3. 在本機專案資料夾把 key 存成 Supabase Secret：

```bash
supabase secrets set FINNHUB_API_KEY=你的-finnhub-api-key
```

這個 key 不能放進 `public/config.js`，也不要 commit 到 GitHub。`FINNHUB_API_KEY` 會存在 Supabase 專案裡，只給 `us-quotes` Edge Function 使用。

部署 functions：

```bash
supabase functions deploy taiwan-quotes
supabase functions deploy us-quotes
```

部署完成後，可以測試台股報價：

```bash
curl https://你的-project-ref.supabase.co/functions/v1/taiwan-quotes \
  -H "Authorization: Bearer 你的-anon-public-key"
```

回傳 JSON 裡應該會有：

```text
"00679B": 26.16
"00719B": 30.92
```

數字會依當日收盤價不同而變動。

也可以測試美股批次報價：

```bash
curl "https://你的-project-ref.supabase.co/functions/v1/us-quotes?symbols=VOO,QQQM,SCHD" \
  -H "Authorization: Bearer 你的-anon-public-key"
```

回傳 JSON 裡應該會看到 `VOO`、`QQQM`、`SCHD` 的價格，且每檔會有 `source`。正常會是 `finnhub`；如果 Finnhub 缺漏，可能會看到 `stooq-batch`。部署 `us-quotes` 後，GitHub Pages 版會優先用它更新美股；只有缺漏時才用 Alpha Vantage 備援。

### 6. 發佈 GitHub Pages

這個專案已經包含 GitHub Actions workflow：

```text
.github/workflows/pages.yml
```

操作步驟：

1. 在 GitHub Desktop commit 目前修改。
2. Push 到 GitHub。
3. 到 GitHub repo 網頁。
4. 進入 `Settings` -> `Pages`。
5. Source 選 `GitHub Actions`。
6. 到 `Actions` 分頁，確認 `Deploy GitHub Pages` 有跑成功。
7. 成功後 GitHub 會顯示網址，通常像：

```text
https://你的帳號.github.io/mystock-tracker/
```

如果 Actions 顯示 `Get Pages site failed` 或 `Not Found`，確認：

- repository 已經是 `Public`，或你的 GitHub plan 支援 private Pages。
- `Settings` -> `Pages` 的 Source 是 `GitHub Actions`。
- `.github/workflows/pages.yml` 裡的 `actions/configure-pages` 有 `enablement: true`。

### 7. 第一次登入和匯入資料

1. 打開 GitHub Pages 網址。
2. 會看到 Supabase 登入畫面。
3. 第一次使用按 `建立帳號`。
4. 如果 Supabase 要求 email confirmation，先去信箱確認。
5. 登入後，資料一開始會是空的。
6. 回到本機版 MyStock，打開：

```text
http://127.0.0.1:3000
```

7. 到「設定」->「資料備份 / 匯入」。
8. 按「匯出完整備份」，下載 `mystock-backup-日期.json`。
9. 回到 GitHub Pages 雲端版。
10. 到「設定」->「資料備份 / 匯入」。
11. 按「匯入完整備份」，選剛剛下載的 JSON。
12. 匯入後重新整理，確認資料還在。

注意：完整備份不會包含 Alpha Vantage API key。雲端版匯入後，請到「設定」重新貼上 API key。

如果建立帳號時看到 `over_email_send_rate_limit`，代表 Supabase 內建寄信短時間超過限制。私人使用可在 Supabase `Authentication` -> `Sign In / Providers` -> `Email` 暫時關閉 email confirmation，建立好帳號後再視需要打開。

帳號建立成功、確認自己能登入後，建議關閉公開註冊：

```text
Supabase -> Authentication -> Sign In / Providers -> Email -> 關閉 Allow sign ups
```

關閉後，別人就不能隨便註冊新帳號消耗你的免費額度。就算未關閉，Row Level Security 仍會限制別人只能看到自己的資料，看不到你的資料。

### 8. 手機使用

1. 用手機打開 GitHub Pages 網址。
2. 用同一組 Supabase email / password 登入。
3. 可以看資料、新增/編輯持股、儲存快照。

### 9. 重要限制

- GitHub Pages 是靜態網頁，免費版 repo 必須 public。請確認 `data/*.json` 沒有被 commit。
- `public/config.js` 會公開 Supabase Project URL 和 anon public key，這是 Supabase 前端用法允許的；不能公開的是 `service_role` / `secret` key。
- 本機 `http://127.0.0.1:3000` 會使用本機 `data/*.json`，GitHub Pages 網址才會使用 Supabase。
- 「匯出 CSV」只能下載持股表格；要搬資料到雲端請用「設定」裡的「匯出完整備份」。
- 雲端版直接從瀏覽器抓股價；如果某個資料來源因 CORS 擋住，價格更新可能失敗，但手動編輯和快照仍可用。
- Supabase Free 目前包含 500 MB database、5 GB egress、50,000 monthly active users、2 個 active projects、unlimited API requests；專案 1 週沒使用可能會暫停，重新打開 Supabase 後台可恢復。
- Supabase Free 沒有自動備份，建議定期用「匯出完整備份」下載 JSON。
- 不要公開 Supabase `service_role` key。

## 使用流程

1. 到「設定」貼上 Alpha Vantage API key。
2. 按「更新價格」抓最新股價與 USD/TWD 匯率。
3. 有需要記錄當下狀態時，按「儲存快照」。
4. 後續可在「持股」新增/編輯/停用股票，在「分類」新增/改名/停用分類。

## 股數增加時怎麼填

- 同一券商同一檔股票加碼：到「持股」按該列「編輯」，把「股數」改成目前總股數，不是只填增加的股數。
- 換券商買同一檔股票：按「新增持股」，券商填新的券商，股票代號填同一個代號。總覽和單一股票頁會自動合併同 ticker。
- 改完股數後，按「儲存快照」才會把這次股數與總價變化記到時間軸。

## 資料檔

資料都保存在 `data/`：

- `holdings.json`：持股清單
- `categories.json`：分類設定
- `prices.json`：最新價格與匯率
- `snapshots.json`：手動快照歷史
- `settings.json`：API key 與快取設定

分類和持股停用後不會刪除歷史資料。
