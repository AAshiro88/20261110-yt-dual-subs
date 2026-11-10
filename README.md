# YouTube 雙字幕 (MV3)

在 `www.youtube.com` 的影片上同時顯示「第一行＋第二行」雙字幕。
**第二行優先使用影片原生第二種語言的字幕軌**；原生只有一種語言（或使用者指定）時，
才使用 YouTube 內建的機器翻譯（baseUrl 加 `tlang` 參數）。
這是全新實作的 Manifest V3 擴充，非復刻「YouTube™ 雙字幕（dual-subtitles.com）」的原始碼（該擴充未開源）。

## 安裝（載入未封裝擴充）

1. 開啟 `chrome://extensions/`（Edge 為 `edge://extensions/`）
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇本資料夾（含 `manifest.json` 的這層）
4. 更新程式碼後，在擴充頁面按「重新載入」，並重新整理 YouTube 分頁

## 使用方式

1. 開啟 www.youtube.com 上任一有字幕的影片（僅支援 `www.youtube.com`）
2. 點工具列的擴充圖示開啟彈出視窗：
   - 開關雙字幕
   - **兩行的來源完全對等**，各自可選：
     - `自動`（第一行＝原字幕軌；第二行＝原生第二語言軌優先，沒有才機器翻譯）
     - `機器翻譯`（使用下方設定的語言，預設繁體中文）
     - 該影片任何一條原生字幕軌（含 ASR 自動字幕）
   - 視窗下方的狀態列會顯示兩行各自的抓取結果（句數、載入中、或失敗原因）

常見組合範例：
- 第一行「機器翻譯」＋第二行「自動」→ 中譯＋原字幕（原擴充的典型用法）
- 第一行「自動」＋第二行「機器翻譯」→ 原字幕＋中譯
- 第一行、第二行各選不同原生軌 → 純原生雙語（不經機器翻譯）

選擇會存進 `chrome.storage.sync`（全局設定），之後看的影片若沒有
你指定的軌道，會退回自動/翻譯行為。第二行若指定與第一行相同的
原生軌道，會自動改用機器翻譯（兩行重複顯示沒有意義）。

## 檔案結構

```
manifest.json      擴充定義（MV3）
src/bridge.js      MAIN world：攔截播放器回應取得字幕軌、擷取 pot 權杖、代理 timedtext 抓取
src/content.js     ISOLATED world：字幕軌挑選（原生雙語優先）、json3 解析、快取、overlay 顯示
src/overlay.css    overlay 樣式，以及雙字幕就緒後隱藏原生字幕的規則
popup/             彈出設定視窗（含抓取狀態顯示）
icons/             圖示
```

## 架構說明

- 字幕資料皆是向 `https://www.youtube.com/api/timedtext` 抓取（`fmt=json3`）：
  - 第一行：來源字幕軌的 baseUrl，不加 tlang（直接用原生字幕）
  - 第二行：原生第二語言軌的 baseUrl；或來源軌 baseUrl 加上 `tlang=<語言>`
    由 YouTube 自行翻譯
- timedtext 必須用頁面本身（同源）的憑證抓取，MV3 的 content script fetch 會被
  CORS 擋下，因此抓取由 `bridge.js`（MAIN world）代勞，再用
  `window.postMessage` 傳回 content script。
- **pot 權杖（0.2.0 起）**：YouTube 的 timedtext 現在要求請求帶有播放器產生的
  `pot` 簽章權杖（並搭配 `c=WEB`、`potc`），缺少時會回傳 HTTP 200 但內容為空。
  從播放器回應取得的 baseUrl 並不含 pot，因此舊版直接抓取會得到空內容，
  表現為原字幕與翻譯字幕都出不來。目前作法：
  1. `bridge.js` 在 `document_start` 攔截播放器自己發出的 timedtext 請求，記下 `pot`
  2. 若播放器尚未發出請求（使用者沒開字幕），主動呼叫播放器開啟字幕並重新載入，
     促使播放器發出帶 pot 的請求，取得後若原本字幕是關閉的會還原為關閉
  3. 代抓字幕時，把 `pot`、`potc`、`c` 套到來源軌 baseUrl 上，再加上 `fmt=json3` 與 `tlang`
  4. pot 與影片綁定，換影片會重新取得；回傳空內容時會丟棄 pot 重試一次
- 播放器為了產生 pot 必須保持字幕開啟，因此原生字幕改以樣式隱藏
  （雙字幕資料就緒時 `html` 會加上 `yds-active` 類別，見 `overlay.css`）。
- 抓取結果以「影片編號＋字幕軌＋翻譯語言」為 key 快取，同一份字幕不會重複請求；
  失敗後 20 秒內不自動重試（使用者主動改設定除外），避免觸發 HTTP 429 限流。
- 換影片（SPA 導航）時透過 `yt-navigate-finish` 事件重新抓取。

## 已知限制 / 風險

- 未經完整測試，僅靜態檢查；實際效果需載入瀏覽器驗證。
- YouTube 前端與 timedtext API 參數隨時可能改動而失效，pot 機制尤其可能再變。
- 機器翻譯（`tlang`）搭配 pot 是否一律被接受，目前沒有確切資料；
  若原字幕能顯示但翻譯出不來，popup 狀態列會顯示「對翻譯請求回傳空內容」。
- 短時間內大量請求 timedtext 會得到 HTTP 429，需等待一段時間。
- YouTube 已開始對部分影片的字幕軌顯示名稱做混淆（回傳亂數字串），
  因此選單中的語言名稱一律由字幕軌的 `languageCode` 透過
  `Intl.DisplayNames` 產生，不使用 YouTube 回傳的 name 欄位。
- 「原生第二種語言」的判斷依據字幕軌的 `languageCode`；同影片有同名多軌
  （例如 en 原文與 en ASR）時不算第二語言。
- 直播影片的字幕格式與點播不同，目前未處理。
- 隱藏 YouTube 原生字幕依賴 `.ytp-caption-window-container` selector，
  若 YouTube 改版類名改變，原生字幕會與雙字幕同時顯示。
- 開啟與還原播放器字幕依賴 `toggleSubtitlesOn`、`toggleSubtitles`、
  `setOption('captions','reload')` 這些播放器內部方法，YouTube 改版後可能失效。
