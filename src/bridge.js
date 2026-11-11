/**
 * bridge.js — 執行於頁面上下文的腳本（Strict Isolation: MAIN world）
 *
 * 職責：
 * 1. 攔截 fetch / XMLHttpRequest，從 /youtubei/v1/player 回應中取得字幕軌清單
 *    （captionTracks 含 baseUrl），丟給隔離世界的 content script。
 * 2. 代替 content script 向 YouTube timedtext API 抓取字幕資料
 *    （原始字幕＋加入 tlang 參數的內建翻譯字幕）。
 * 3. 擷取播放器自己發出的 timedtext 請求所帶的 pot 簽章權杖，供代抓字幕時使用。
 *    YouTube 目前對沒有 pot 的 timedtext 請求一律回傳 HTTP 200 但內容為空，
 *    這是翻譯字幕與原字幕都出不來的主要原因。
 *
 * 必須在 MAIN world 執行的原因：
 * - timedtext API 需要頁面本身的使用者憑證與環境，content script（ISOLATED world）
 *   在 MV3 中發出的 fetch 會被視為跨來源而被 CORS 擋下。
 * - 需要在頁面自身發出請求前掛上攔截，因此 run_at 為 document_start。
 */
(() => {
  'use strict';

  const PLAYER_API_PATH = '/youtubei/v1/player';

  /** timedtext API 的路徑，用來辨識播放器發出的字幕請求 */
  const TIMEDTEXT_PATH = '/api/timedtext';

  /** 等待播放器產生 pot 權杖的最長時間（毫秒） */
  const POT_TIMEOUT_MS = 12000;

  /** 最後一次看到的字幕軌資訊（來自播放器回應） */
  let cachedTracks = null; // { videoId, tracks: [{ baseUrl, languageCode, name, kind }] }

  /**
   * 最後一次從播放器的 timedtext 請求中擷取到的簽章資訊。
   * pot 與影片綁定，換影片後必須重新取得。
   */
  let potInfo = null; // { videoId, pot, potc, c }

  /** 正在等待 pot 的影片，同一支影片只會同時有一個等待流程 */
  const potPromises = new Map();

  /**
   * 播放器對各字幕軌發出的完整 timedtext 網址（含 pot 與所有簽章參數）。
   * key 格式為 影片編號、語言代碼、kind 以直線符號相連。
   * 翻譯字幕以播放器的完整網址為基礎再加 tlang，比自己用 baseUrl 拼湊更可靠。
   */
  const playerUrls = new Map();

  /** 送訊息給隔離世界的 content script */
  function sendToContent(event, payload) {
    try {
      window.postMessage({ __ydsBridge: true, event, payload }, window.location.origin);
    } catch (e) {
      // postMessage 失敗不影響頁面本身
    }
  }

  /** 從任意網址取出影片編號參數 v，取不到回傳空字串 */
  function videoIdOfUrl(rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin).searchParams.get('v') || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 若是播放器發出且帶有 pot 的 timedtext 請求，就記下簽章資訊。
   * 本擴充自己的請求使用未被改寫的 fetch，不會經過這裡，因此不會被誤抓。
   * @param rawUrl 播放器正要發出的請求網址
   */
  function capturePot(rawUrl) {
    try {
      if (!rawUrl || rawUrl.indexOf(TIMEDTEXT_PATH) === -1) return;
      const u = new URL(rawUrl, window.location.origin);
      const pot = u.searchParams.get('pot');
      if (!pot) return; // 沒帶 pot 的請求回傳空內容，沒有參考價值
      potInfo = {
        videoId: u.searchParams.get('v') || '',
        pot,
        potc: u.searchParams.get('potc') || '1',
        c: u.searchParams.get('c') || 'WEB'
      };
      // 除錯資訊：可在頁面主控台確認 pot 的擷取來源與時間
      console.debug(
        '[yds] pot captured',
        { videoId: potInfo.videoId, lang: u.searchParams.get('lang'), kind: u.searchParams.get('kind') }
      );
      // 同時記下這條字幕軌的完整網址，供翻譯請求使用
      playerUrls.set(
        potInfo.videoId + '|' + (u.searchParams.get('lang') || '') + '|' + (u.searchParams.get('kind') || ''),
        u.href
      );
      if (playerUrls.size > 30) {
        playerUrls.delete(playerUrls.keys().next().value);
      }
    } catch (e) {
      // 網址解析失敗就忽略這次請求
    }
  }

  /**
   * 把播放器自己抓到的字幕回應轉傳給 content script 快取重用。
   * 特別是翻譯字幕：播放器自己的請求帶有正確簽章，且不受 tlang 節流限制，
   * 使用者在播放器字幕設定開啟「自動翻譯」後，這裡就能取得完整翻譯字幕。
   * 擴充自己代抓的請求使用未被改寫的 fetch，不會經過這裡。
   * @param rawUrl 播放器發出的請求網址
   * @param text 回應內容（json3 或 srv3 XML）
   */
  function captureTimedTextResponse(rawUrl, text) {
    try {
      if (!text || !text.trim() || text.length > 2000000) return;
      const u = new URL(rawUrl, window.location.origin);
      const videoId = u.searchParams.get('v') || (cachedTracks && cachedTracks.videoId) || '';
      const lang = u.searchParams.get('lang') || '';
      const kind = u.searchParams.get('kind') || '';
      const tlang = u.searchParams.get('tlang') || '';
      // 與 content script 的 key 格式維持一致：影片編號|語言|kind|翻譯語言
      const key = videoId + '|' + lang + '|' + kind + '|' + tlang;
      sendToContent('yds:captured', { key, videoId, tlang, body: text });
    } catch (e) {
      // 網址解析失敗就忽略這次回應
    }
  }

  /** 目前記住的 pot 是否屬於指定影片 */
  function potMatches(videoId) {
    return !!potInfo && (!videoId || !potInfo.videoId || potInfo.videoId === videoId);
  }

  /**
   * 從 DOM 的 <track src> 擷取字幕請求網址。
   * CC 開啟時 YouTube 會在 <video> 內放入 <track> 元素，其 src 就是完整
   * 的 timedtext 網址（含 pot 等所有簽章參數）。播放器的字幕請求不一定
   * 經過可攔截的 fetch/XHR（部分走 Web Worker 等內部管線），因此抓不到
   * pot 時改從這裡取得，是最不依賴播放器內部實作的來源。
   */
  function scanCaptionTrackElements() {
    try {
      const trackEls = document.querySelectorAll('track[src]');
      for (const el of trackEls) {
        capturePot(el.getAttribute('src'));
      }
    } catch (e) {
      // DOM 查詢失敗就忽略，下一輪再試
    }
  }

  /**
   * 監聽整個文件的新增節點，看到 <track> 就立刻擷取其 src。
   * 這樣 CC 剛開啟的瞬間就能抓到，不用等輪詢。
   */
  const trackObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'TRACK') {
          capturePot(node.getAttribute('src'));
        } else if (node.querySelectorAll) {
          const trackEls = node.querySelectorAll('track[src]');
          for (const el of trackEls) capturePot(el.getAttribute('src'));
        }
      }
    }
  });

  function startTrackObserver() {
    if (document.documentElement) {
      trackObserver.observe(document.documentElement, { childList: true, subtree: true });
      scanCaptionTrackElements(); // 觀察前就存在的 <track> 也要掃一次
    } else {
      window.setTimeout(startTrackObserver, 200);
    }
  }

  startTrackObserver();

  /**
   * 從 YouTube 播放器介面取得字幕是否為開啟狀態
   */
  function isCaptionButtonOn() {
    const btn = document.querySelector('.ytp-subtitles-button');
    return !!btn && btn.getAttribute('aria-pressed') === 'true';
  }

  /**
   * 催促播放器發出一次帶 pot 的 timedtext 請求。
   * 主要手段：直接點擊 CC 按鈕。這與使用者手動開啟字幕是同一條路徑，
   * 播放量器一定會重新請求字幕軌（這次請求會帶 pot）。
   * 備援：player.loadModule('captions') 與 setOption reload。
   * 注意：不要依賴 player.toggleSubtitlesOn 之類的方法，它們不保證存在，
   * typeof 檢查失敗時 poke 會默默無效，pot 永遠拿不到。
   * @param attempt 第幾次嘗試，從 0 開始
   */
  function pokePlayer(attempt) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    try {
      const ccBtn = document.querySelector('.ytp-subtitles-button');
      const ccDisabled = ccBtn && ccBtn.getAttribute('aria-disabled') === 'true';
      const ccOn = isCaptionButtonOn();
      console.debug('[yds] poke', { attempt, ccBtn: !!ccBtn, ccOn, ccDisabled });

      if (attempt === 0) {
        if (ccBtn && !ccDisabled && typeof ccBtn.click === 'function') {
          // 模擬使用者點 CC：關閉的開啟它；已開啟的關閉再開啟（強迫重新請求）
          ccBtn.click();
          if (ccOn) {
            window.setTimeout(() => {
              try {
                const btn = document.querySelector('.ytp-subtitles-button');
                if (btn && btn.getAttribute('aria-pressed') !== 'true' && typeof btn.click === 'function') {
                  btn.click();
                }
              } catch (e) {
                // 重新開啟失敗於下一輪再試
              }
            }, 700);
          }
        } else if (typeof player.toggleSubtitles === 'function') {
          player.toggleSubtitles();
        }
      } else {
        // 後續嘗試：載入字幕模組並要求重新載入字幕設定
        if (typeof player.loadModule === 'function') {
          player.loadModule('captions');
        }
        if (typeof player.setOption === 'function') {
          player.setOption('captions', 'reload', true);
        }
      }
    } catch (e) {
      // 播放器方法不存在或呼叫失敗，等下一輪再試
    }
  }

  /** 若原本字幕是關閉的，取得 pot 後把播放器字幕還原為關閉 */
  function restoreCaptionState() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    try {
      if (isCaptionButtonOn() && typeof player.toggleSubtitles === 'function') {
        player.toggleSubtitles();
      }
    } catch (e) {
      // 還原失敗不影響字幕顯示，原生字幕已由樣式隱藏
    }
  }

  /**
   * 取得指定影片的 pot 簽章資訊。
   * 播放器已經發過請求就直接回傳；否則定時催促播放器發出請求並等待擷取。
   * @param videoId 影片編號
   * @returns 取得的簽章資訊，逾時回傳 null
   */
  function obtainPot(videoId) {
    if (potMatches(videoId)) return Promise.resolve(potInfo);
    if (potPromises.has(videoId)) return potPromises.get(videoId);

    const wasOn = isCaptionButtonOn();
    const promise = new Promise((resolve) => {
      const startedAt = Date.now();
      let attempt = 0;
      let nextPokeAt = 0;

      const finish = (result) => {
        window.clearInterval(timer);
        potPromises.delete(videoId);
        if (result && !wasOn) {
          window.setTimeout(restoreCaptionState, 500);
        }
        resolve(result);
      };

      const timer = window.setInterval(() => {
        // 輪詢時同步掃描 DOM 的 <track src>，CC 開著時這裡通常一次就抓到 pot
        scanCaptionTrackElements();
        const elapsed = Date.now() - startedAt;
        if (potMatches(videoId)) {
          finish(potInfo);
          return;
        }
        if (elapsed >= POT_TIMEOUT_MS) {
          finish(null);
          return;
        }
        if (elapsed >= nextPokeAt) {
          pokePlayer(attempt);
          attempt += 1;
          // 播放器每次發請求也算 timedtext 流量，poke 太密集會造成 HTTP 429
          nextPokeAt = elapsed + 2500;
        }
      }, 300);
    });

    potPromises.set(videoId, promise);
    return promise;
  }

  /**
   * 從 playerResponse 抽出字幕軌清單
   * @param {object} pr - /youtubei/v1/player 的 JSON 回應
   */
  function extractTracksFromPlayerResponse(pr) {
    try {
      const renderer = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      const rawTracks = renderer && renderer.captionTracks;
      if (!rawTracks || !rawTracks.length) return;

      const videoId = (pr.videoDetails && pr.videoDetails.videoId) || (renderer.audioTracks && renderer.audioTracks[0] && renderer.audioTracks[0].id) || null;

      const tracks = rawTracks.map((t) => ({
        baseUrl: t.baseUrl || '',
        languageCode: t.languageCode || '',
        name:
          (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) ||
          t.languageCode ||
          'unknown',
        kind: t.kind || '' // 'asr' = 自動語音辨識字幕
      }));

      cachedTracks = { videoId, tracks };
      sendToContent('yds:tracks', cachedTracks);
    } catch (e) {
      // 解析失敗就等待下一次攔截
    }
  }

  // ---------------------------------------------------------------------------
  // 攔截 fetch
  // ---------------------------------------------------------------------------
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    let url = '';
    try {
      const target = args[0];
      url = typeof target === 'string' ? target : (target && target.url) || '';
    } catch (e) {
      url = '';
    }

    // 在請求送出前先記下播放器的 pot
    capturePot(url);

    const response = await originalFetch.apply(this, args);

    if (url.indexOf(PLAYER_API_PATH) !== -1) {
      try {
        const json = await response.clone().json();
        if (json && json.responseContext) extractTracksFromPlayerResponse(json);
      } catch (e) {
        // 非預期的回應格式，忽略
      }
    } else if (url.indexOf(TIMEDTEXT_PATH) !== -1) {
      // 播放器自己抓字幕的回應整份收集起來（含翻譯字幕），供快取重用
      try {
        const text = await response.clone().text();
        captureTimedTextResponse(url, text);
      } catch (e) {
        // 取不到回應內容就忽略
      }
    }

    return response;
  };

  // ---------------------------------------------------------------------------
  // 攔截 XMLHttpRequest
  // ---------------------------------------------------------------------------
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSend = xhrProto.send;

  xhrProto.open = function (method, url, ...rest) {
    /** @private 本次請求的 URL，供 send 判斷是否要解析 */
    this.__ydsUrl = String(url || '');
    // 播放器的字幕請求也可能走 XHR，同樣要記下 pot
    capturePot(this.__ydsUrl);
    return originalOpen.call(this, method, url, ...rest);
  };

  xhrProto.send = function (...args) {
    const xhr = this;
    const requestUrl = xhr.__ydsUrl || '';
    const isPlayerApi = requestUrl.indexOf(PLAYER_API_PATH) !== -1;
    const isTimedText = requestUrl.indexOf(TIMEDTEXT_PATH) !== -1;
    if (isPlayerApi || isTimedText) {
      xhr.addEventListener('load', () => {
        try {
          if (isTimedText) {
            // 播放器自己抓字幕的回應整份收集起來（含翻譯字幕），供快取重用
            captureTimedTextResponse(requestUrl, xhr.responseText);
          } else {
            const json = JSON.parse(xhr.responseText);
            if (json && json.responseContext) extractTracksFromPlayerResponse(json);
          }
        } catch (e) {
          // 忽略非預期格式或取不到 responseText 的情況
        }
      });
    }
    return originalSend.apply(this, args);
  };

  // ---------------------------------------------------------------------------
  // 頁面載入完成後，從 ytInitialPlayerResponse 補抓一次字幕軌
  // （涵蓋暖機流程沒被抓到的情況）
  // ---------------------------------------------------------------------------
  function readInitialPlayerResponse(attempt) {
    try {
      // MDN: window.ytInitialPlayerResponse 可能尚未指派，輪詢最多 20 次（約 10 秒）
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.captions) {
        extractTracksFromPlayerResponse(pr);
        return;
      }
    } catch (e) {
      // 讀取失敗，繼續輪詢
    }
    if (attempt < 20) {
      window.setTimeout(() => readInitialPlayerResponse(attempt + 1), 500);
    }
  }

  window.addEventListener('DOMContentLoaded', () => readInitialPlayerResponse(0));

  // ---------------------------------------------------------------------------
  // 提供 timedtext 抓取服務：content script 把 baseUrl 丟過來，這裡抓完再回傳
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ydsContent !== true) return;

    // content script 要求重新回報目前快取的字幕軌（SPA 導航補救用）
    if (ev.data.event === 'yds:query-tracks') {
      if (cachedTracks) sendToContent('yds:tracks', cachedTracks);
      return;
    }

    if (ev.data.event === 'yds:fetch') {
      handleSubtitleFetch(ev.data.key, ev.data.baseUrl, ev.data.tlang, ev.data.lang, ev.data.kind);
    }
  });

  // ---------------------------------------------------------------------------
  // timedtext 請求序列化：自身請求全部經過同一個隊列並保持最小間距。
  // 短時間內多筆請求（第一行、第二行、pot 重試）會被 YouTube 判定頻繁而 HTTP 429。
  // ---------------------------------------------------------------------------
  const TT_MIN_GAP_MS = 900;
  const timedTextQueue = [];
  let lastTimedTextAt = 0;
  let queueRunning = false;

  function runTimedTextQueue() {
    if (queueRunning) return;
    queueRunning = true;
    const step = () => {
      const item = timedTextQueue.shift();
      if (!item) {
        queueRunning = false;
        return;
      }
      const wait = TT_MIN_GAP_MS - (Date.now() - lastTimedTextAt);
      window.setTimeout(() => {
        lastTimedTextAt = Date.now();
        item.task().then(item.resolve, item.reject).then(step, step);
      }, wait > 0 ? wait : 0);
    };
    step();
  }

  /** 把一個會回傳 timedtext 內容的任務排進序列，保證請求之間有最小間距 */
  function enqueueTimedText(task) {
    return new Promise((resolve, reject) => {
      timedTextQueue.push({ task, resolve, reject });
      runTimedTextQueue();
    });
  }

  // ---------------------------------------------------------------------------
  // InnerTube 字幕稿端點（get_transcript）
  //
  // 與 timedtext 不同：此端點不帶 pot、也有完整的翻譯支援（回應的語言選單
  // 內含各翻譯語言自己的 continuation params），且不走 timedtext 的 tlang
  // 節流桶。翻譯字幕優先走這條路，失敗才退回 timedtext 流程。
  // proto 結構參考 Invidious 的 Transcript.generate_param 實作。
  // ---------------------------------------------------------------------------

  const GET_TRANSCRIPT_URL = 'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false';

  /** 從頁面取得 InnerTube 的公開金鑰與 context（本來就內嵌在頁面中） */
  function getInnertubeConfig() {
    try {
      if (!window.ytcfg || typeof window.ytcfg.get !== 'function') return null;
      const apiKey = window.ytcfg.get('INNERTUBE_API_KEY');
      const context = window.ytcfg.get('INNERTUBE_CONTEXT');
      if (!apiKey || !context) return null;
      return { apiKey, context, client: context.client || {} };
    } catch (e) {
      return null;
    }
  }

  /** 計算 SHA-1 hex（供登入使用者的 SAPISIDHASH 授權用） */
  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  /**
   * 組登入使用者的授權標頭；未登入回傳 null。
   * 此值等同頁面自己呼叫 InnerTube 時的 Authorization，僅送進請求，
   * 不寫入任何記錄或訊息，避免知名的雜湊值外流。
   */
  async function buildAuthHeader() {
    try {
      const match = document.cookie.match(/SAPISID=([A-Za-z0-9_-]+)/);
      if (!match) return null;
      const sapisid = match[1];
      const timestamp = Math.floor(Date.now() / 1000);
      const hashHex = await sha1Hex(timestamp + ' ' + sapisid + ' ' + window.location.origin);
      return 'SAPISIDHASH ' + timestamp + '_' + hashHex;
    } catch (e) {
      return null;
    }
  }

  /** protobuf varint 編碼 */
  function pbVarint(value) {
    const out = [];
    let v = value;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return out;
  }

  /** 合併多段 Uint8Array */
  function pbConcat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /** 字串欄位（wire type 2） */
  function pbStringField(field, str) {
    const bytes = new TextEncoder().encode(str);
    return pbConcat([pbVarint((field << 3) | 2), pbVarint(bytes.length), bytes]);
  }

  /** 位元組串欄位（wire type 2，內嵌訊息用） */
  function pbBytesField(field, bytes) {
    return pbConcat([pbVarint((field << 3) | 2), pbVarint(bytes.length), bytes]);
  }

  /** varint 欄位（wire type 0） */
  function pbVarintField(field, value) {
    return new Uint8Array(pbVarint((field << 3) | 0).concat(pbVarint(value)));
  }

  /** bytes → base64 */
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    }
    return btoa(bin);
  }

  /**
   * 產生 get_transcript 的 params。
   * 結構為 Invidious 實測過的編碼：
   * { 1: videoId, 2: {1: kind, 2: languageCode, 3: ""}, 3: 1,
   *   5: 面板名稱, 6: 1, 7: 1, 8: 1 }
   */
  function buildTranscriptParams(videoId, languageCode, kind) {
    const inner = pbConcat([
      pbStringField(1, kind || ''),
      pbStringField(2, languageCode || ''),
      pbStringField(3, '')
    ]);
    const outer = pbConcat([
      pbStringField(1, videoId),
      pbBytesField(2, inner),
      pbVarintField(3, 1),
      pbStringField(5, 'engagement-panel-searchable-transcript-search-panel'),
      pbVarintField(6, 1),
      pbVarintField(7, 1),
      pbVarintField(8, 1)
    ]);
    return encodeURIComponent(bytesToBase64(outer));
  }

  /** 解開 params base64（容忍百分比編碼），供語言比對用 */
  function decodeParamBytes(paramsStr) {
    try {
      let s = String(paramsStr || '');
      try {
        s = decodeURIComponent(s);
      } catch (e) {
        // 原本就是純 base64
      }
      s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (e) {
      return null;
    }
  }

  /** 在位元組陣列中搜尋另一組位元組（用來確認 params 內含目標語言代碼） */
  function bytesContain(bytes, needle) {
    if (!bytes || !needle || !needle.length || bytes.length < needle.length) return false;
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  /** 取得字幕稿面板核心節點（失敗回傳 null） */
  function extractTranscriptPanel(json) {
    try {
      return json.actions[0].updateEngagementPanelAction.content.transcriptRenderer.content
        .transcriptSearchPanelRenderer;
    } catch (e) {
      return null;
    }
  }

  /** 從面板抽出字幕段落（跳過章節標題行） */
  function parseTranscriptSegments(panel) {
    const segList = panel && panel.body && panel.body.transcriptSegmentListRenderer;
    const initial = (segList && segList.initialSegments) || [];
    const events = [];
    for (const item of initial) {
      const seg = item && item.transcriptSegmentRenderer;
      if (!seg) continue; // transcriptSectionHeaderRenderer 等標題行不當字幕
      const start = parseInt(seg.startMs, 10);
      const end = parseInt(seg.endMs, 10);
      const runs = (seg.snippet && seg.snippet.runs) || [];
      const text = runs.map((r) => (r && r.text) || '').join('').replace(/\s+/g, ' ').trim();
      if (Number.isNaN(start) || !text) continue;
      events.push({
        tStartMs: start,
        dDurationMs: !Number.isNaN(end) && end > start ? end - start : 5000,
        text
      });
    }
    events.sort((a, b) => a.tStartMs - b.tStartMs);
    return events;
  }

  /** 廣泛尋找節點內的 getTranscriptEndpoint.params（不綁定特定 JSON 形狀） */
  function pickNestedParams(value) {
    const stack = [value];
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (const x of v) stack.push(x);
        continue;
      }
      for (const key of Object.keys(v)) {
        const val = v[key];
        if (key === 'getTranscriptEndpoint' && val && typeof val.params === 'string') return val.params;
        if (val && typeof val === 'object') stack.push(val);
      }
    }
    return null;
  }

  /** 從面板抽出語言選單各項（含各翻譯語言自己的 params） */
  function extractLanguageMenuItems(panel) {
    try {
      const items =
        panel.footer.transcriptFooterRenderer.languageMenu.sortFilterSubMenuRenderer.subMenuItems || [];
      return items
        .filter((item) => item)
        .map((item) => ({ title: item.title || '', params: pickNestedParams(item) }));
    } catch (e) {
      return [];
    }
  }

  /**
   * 在語言選單中找出「翻譯到 tlang」的選項。
   * 主判斷：params 解碼後的位元組含 tlang 代碼；備援：以 Intl.DisplayNames
   * 產生的語言名稱比對選項標題。
   */
  function findTranslatedMenuItem(items, tlang, uiLang) {
    const needle = new TextEncoder().encode(tlang);
    const titleCandidates = [];
    for (const langTag of [uiLang || 'en', 'zh-Hant', 'en']) {
      try {
        const dn = new Intl.DisplayNames([langTag], { type: 'language' });
        const name = (dn.of(tlang) || '').toLowerCase();
        if (name) titleCandidates.push(name);
      } catch (e) {
        // Intl 不可用時忽略
      }
    }
    for (const item of items) {
      if (!item || !item.params) continue;
      const bytes = decodeParamBytes(item.params);
      if (bytes && bytesContain(bytes, needle)) return item;
      const title = String(item.title || '').toLowerCase().trim();
      if (title && titleCandidates.indexOf(title) !== -1) return item;
    }
    return null;
  }

  /** 等待指定的毫秒 */
  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * 字幕稿面板快取：同一軌的基礎字幕稿（含語言選單）抓一次即可。
   * key 為 影片編號、語言代碼、kind；翻譯與原生行共用。
   */
  const transcriptPanels = new Map();

  async function getTranscriptPanelCached(videoId, languageCode, kind) {
    const cacheKey = videoId + '|' + languageCode + '|' + kind;
    if (transcriptPanels.has(cacheKey)) return transcriptPanels.get(cacheKey);
    const panel = await fetchTranscriptPanel(buildTranscriptParams(videoId, languageCode, kind));
    transcriptPanels.set(cacheKey, panel);
    if (transcriptPanels.size > 6) {
      transcriptPanels.delete(transcriptPanels.keys().next().value);
    }
    return panel;
  }

  /**
   * 向 InnerTube get_transcript 查詢字幕面板。
   * @param params 直接可用的請求 params
   */
  async function fetchTranscriptPanel(params) {
    const cfg = getInnertubeConfig();
    if (!cfg) throw new Error('no-innertube-config');
    const headers = { 'Content-Type': 'application/json' };
    // 登入使用者需要 SAPISIDHASH 授權；未登入不需要
    const auth = await buildAuthHeader();
    if (auth) headers.Authorization = auth;
    if (cfg.client.visitorData) headers['X-Goog-Visitor-Id'] = cfg.client.visitorData;
    const response = await originalFetch.call(window, GET_TRANSCRIPT_URL + '&key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ context: cfg.context, params })
    });
    if (!response.ok) throw new Error('transcript HTTP ' + response.status);
    const json = await response.json();
    const panel = extractTranscriptPanel(json);
    if (!panel) throw new Error('transcript-no-panel');
    return panel;
  }

  /** 向 timedtext 發出同源請求並回傳文字內容 */
  async function fetchTimedText(url) {
    const response = await originalFetch.call(window, url, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (!response.ok) {
      throw new Error('timedtext HTTP ' + response.status);
    }
    return response.text();
  }

  /**
   * 抓取指定字幕軌的字幕（fmt=json3）；有 tlang 時由 YouTube 內建翻譯。
   * 請求必須帶上播放器產生的 pot，否則 YouTube 會回傳空內容。
   * 內容為空時視為 pot 可能失效，會丟棄後重新取得並再試一次。
   * @param key - content script 指定的請求識別字串，原樣回傳，由 content script 對應到要顯示的行
   * @param baseUrl - subtitle 軌的 baseUrl
   * @param tlang - 目標翻譯語言（空字串表示直接使用原生字幕軌）
   */
  async function handleSubtitleFetch(key, baseUrl, tlang, lang, kind) {
    try {
      const videoId = videoIdOfUrl(baseUrl) || (cachedTracks && cachedTracks.videoId) || '';
      /** 組出請求網址；pot 為 null 時不帶簽章參數，與舊版行為相同 */
      const trackUrl = new URL(baseUrl, window.location.origin);
      const trackLang = lang || trackUrl.searchParams.get('lang') || '';
      const trackKind = kind || trackUrl.searchParams.get('kind') || '';
      const playerUrlKey = videoId + '|' + trackLang + '|' + trackKind;
      let usedExact = false;

      const buildUrl = (pot) => {
        // 播放器對同一字幕軌發出過的完整網址已內含正確簽章參數（含 pot），
        // 有就用它為基礎，比用 baseUrl 重新拼參數更可靠；
        // 沒有才使用 baseUrl 並視 potInfo 有無決定要不要補簽章參數
        const exact = playerUrls.get(playerUrlKey);
        const url = exact ? new URL(exact) : new URL(baseUrl, window.location.origin);
        usedExact = !!exact;
        url.searchParams.set('fmt', 'json3');
        if (!exact && pot) {
          url.searchParams.set('pot', pot.pot);
          url.searchParams.set('potc', pot.potc);
          url.searchParams.set('c', pot.c);
        }
        // 播放器網址若原本帶有翻譯參數，先移除，只依本次需求決定
        url.searchParams.delete('tlang');
        if (tlang) {
          url.searchParams.set('tlang', tlang);
        }
        return url.href;
      };

      // 字幕稿端點路徑（主路徑）：原生與翻譯都優先走這條，
      // 不需要 pot、不走 timedtext 的節流桶。
      // 基礎字幕稿（原生語言）抓一次後也會餵給「同一軌、無翻譯」的行，
      // 讓「翻譯＋原字幕」成對的請求減少重複。
      try {
        const basePanel = await getTranscriptPanelCached(videoId, trackLang, trackKind);
        const baseEvents = parseTranscriptSegments(basePanel);
        if (!baseEvents.length) {
          console.debug('[yds] transcript empty', { key, tlang });
        } else if (!tlang) {
          // 原生請求直接使用基礎字幕稿
          console.debug('[yds] transcript used', { key, tlang: '', segments: baseEvents.length });
          sendToContent('yds:data', { key, ok: true, body: JSON.stringify(baseEvents), reason: '' });
          return;
        } else {
          // 翻譯請求：同軌原生稿先送進快取（content 端 key 不含 tlang 的行會命中）
          sendToContent('yds:captured', {
            key: videoId + '|' + trackLang + '|' + trackKind + '|',
            videoId,
            tlang: '',
            body: JSON.stringify(baseEvents)
          });
          const cfg = getInnertubeConfig();
          const menuItems = extractLanguageMenuItems(basePanel);
          const target = findTranslatedMenuItem(menuItems, tlang, cfg && cfg.client.hl);
          let events = [];
          if (target && target.params) {
            await delay(400); // 兩次 InnerTube 請求錯開
            const translatedPanel = await fetchTranscriptPanel(target.params);
            events = parseTranscriptSegments(translatedPanel);
          } else {
            console.debug('[yds] transcript menu miss', { key, tlang, menuSize: menuItems.length });
          }
          if (events.length) {
            console.debug('[yds] transcript used', { key, tlang, segments: events.length });
            sendToContent('yds:data', { key, ok: true, body: JSON.stringify(events), reason: '' });
            return;
          }
          // 選單查無翻譯目標或其他問題時，退回 timedtext 流程（下方）
          console.debug('[yds] transcript fallback to timedtext', { key, tlang });
        }
      } catch (transcriptError) {
        console.debug('[yds] transcript path failed', {
          key,
          tlang,
          error: String((transcriptError && transcriptError.message) || transcriptError)
        });
      }

      // 第一步：先照舊版方式抓取，已經擷取到 pot 就帶上，沒有就直接抓。
      // 部分影片不需要 pot，這樣可以避免為了等 pot 而卡住不顯示。
      let body = await enqueueTimedText(() => fetchTimedText(buildUrl(potMatches(videoId) ? potInfo : null)));

      // 第二步：內容為空才向播放器取得 pot 後重試，最多一次（降低請求量避免 429）
      for (let attempt = 0; attempt < 1 && !body; attempt++) {
        const pot = await obtainPot(videoId);
        if (!pot) throw new Error('no-pot');

        body = await enqueueTimedText(() => fetchTimedText(buildUrl(pot)));
        if (!body) {
          // 內容仍為空，丟棄目前的 pot，下次重新向播放器取得
          potInfo = null;
          playerUrls.delete(playerUrlKey);
        }
      }

      // 除錯資訊：在頁面的開發人員工具主控台可看到每次抓取的結果
      console.debug('[yds] timedtext', { key, tlang, usedExact, bodyLength: body ? body.length : 0 });

      if (!body) throw new Error(tlang ? 'empty-translate' : 'empty');
      sendToContent('yds:data', { key, ok: true, body, reason: '' });
    } catch (e) {
      const reason = String((e && e.message) || e);
      // 除錯資訊：429 等節流問題可在此看到發生的時間點
      console.debug('[yds] timedtext error', { key, reason });
      sendToContent('yds:data', {
        key,
        ok: false,
        body: '',
        reason
      });
    }
  }
})();
