/**
 * content.js — 隔離世界（ISOLATED world）的 content script
 *
 * 職責：
 * 1. 與 bridge.js（MAIN world）溝通，取得字幕軌清單與字幕資料（json3）
 * 2. 依 chrome.storage.sync 的設定抓取並快取字幕：
 *    - 第一行：來源字幕軌（原字幕）
 *    - 第二行：優先使用影片原生第二種語言的字幕軌；
 *      若原生只有一種語言或使用者指定，才用 YouTube 內建機器翻譯
 * 3. 在播放器上建立雙字幕 overlay，隨影片時間同步顯示
 * 4. 回應 popup 的查詢
 */
(() => {
  'use strict';

  /** 抓取失敗後，同一份字幕在這段時間內不會自動重試（毫秒），避免觸發 YouTube 的 429 限流 */
  const ERROR_COOLDOWN_MS = 20000;

  /** 抓取失敗後自動重試的間隔（毫秒）與次數；第一輪 21 秒、第二輪 46 秒 */
  const RETRY_DELAYS_MS = [21000, 46000];

  /** 字幕快取最多保留的份數，超過時丟棄最舊的 */
  const CACHE_LIMIT = 20;

  // ---------------------------------------------------------------------------
  // 狀態
  // ---------------------------------------------------------------------------
  const state = {
    enabled: true, /** 開關（來自 storage） */
    targetLang: 'zh-Hant', /** 機器翻譯的目標語言（來自 storage） */
    sourceKey: null, /** 第一行來源字幕軌，格式 "languageCode|kind"；null = 自動 */
    secondKey: null, /** 第二行來源："track key" 指定原生軌、'translate' 指定機器翻譯；null/'' = 自動（原生雙語優先） */
    tracks: null, /** { videoId, tracks:[{baseUrl, languageCode, name, kind}] } */
    cache: new Map(), /** 已抓取成功的字幕，key 為 "影片編號|字幕軌|翻譯語言"，值為字幕事件陣列 */
    inflight: new Set(), /** 正在抓取中的 key，避免同一份字幕重複送出請求 */
    errors: new Map(), /** 抓取失敗的 key 與原因 { reason, at } */
    specs: new Map(), /** 每個 key 的抓取規格 { baseUrl, tlang }，重試時要用 */
    slotKeys: { main: null, second: null }, /** 兩行目前需要的字幕 key */
    mainEvents: null, /** 第一行字幕事件 [{tStartMs, dDurationMs, text}] */
    secondEvents: null /** 第二行字幕事件 */
  };

  /** 排程中的重試計時器，key 為字幕 key */
  const pendingRetries = new Map();

  // ---------------------------------------------------------------------------
  // 與 bridge.js 的訊息（window.postMessage）
  // ---------------------------------------------------------------------------
  function sendToBridge(event, extra) {
    window.postMessage({ __ydsContent: true, event, ...extra }, window.location.origin);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ydsBridge !== true) return;

    if (ev.data.event === 'yds:tracks') {
      state.tracks = ev.data.payload;
      // 收到新的字幕軌清單時，若已啟用就重新抓字幕（影片切換 / 初次載入）
      if (state.enabled) {
        startFetchCycle(false);
      }
    } else if (ev.data.event === 'yds:data') {
      handleFetchResult(ev.data.payload);
    } else if (ev.data.event === 'yds:captured') {
      handleCaptured(ev.data.payload);
    }
  });

  // ---------------------------------------------------------------------------
  // 字幕軌挑選
  // ---------------------------------------------------------------------------

  /** 依字幕軌的 languageCode 產生人類可讀的名稱（如 "en" → "英文"） */
  const languageDisplayNames = new Intl.DisplayNames(['zh-Hant'], { type: 'language' });
  function describeLanguage(languageCode) {
    try {
      return languageDisplayNames.of(languageCode) || languageCode;
    } catch (e) {
      return languageCode; // Intl 不可用時退回 ISO 代碼
    }
  }

  /** 以 "languageCode|kind" 格式組字幕軌 key */
  function trackKeyOf(track) {
    return track.languageCode + '|' + track.kind;
  }

  /** 在原生字幕軌中依自動規則挑一條（人工軌優先於 ASR） */
  function pickNativeTrack() {
    const tracks = state.tracks && state.tracks.tracks;
    if (!tracks || !tracks.length) return null;
    const manual = tracks.find((t) => t.kind !== 'asr');
    return manual || tracks[0];
  }

  /**
   * 依目前選擇決定第一行的內容來源。
   * type 為 'translate' 時，track 欄位是「翻譯基底軌」（抓該軌 baseUrl 加 tlang）。
   * @returns {{type:'native', track:object} | {type:'translate', track:object|null}}
   */
  function resolveMainSource() {
    const tracks = (state.tracks && state.tracks.tracks) || [];
    if (state.sourceKey === 'translate') {
      return { type: 'translate', track: pickNativeTrack() };
    }
    if (state.sourceKey) {
      const found = tracks.find((t) => trackKeyOf(t) === state.sourceKey);
      if (found) return { type: 'native', track: found };
    }
    // 自動：使用原生軌（人工軌優先）
    return { type: 'native', track: pickNativeTrack() };
  }

  /**
   * 決定第二行的內容來源。
   * 優先序：
   *   1. 使用者指定原生軌（secondKey 是 track key）
   *   2. 使用者指定機器翻譯（secondKey = 'translate'）
   *   3. 自動：第一行是原生軌時，挑語言不同的原生軌（人工軌優先於 ASR）；
   *            第一行是翻譯時，改顯示原生原字幕
   *   4. 自動且無原生軌可用 → 退回機器翻譯
   * @param {{type:string, track?:object}} mainRes - 第一行的解析結果
   */
  function resolveSecondSource(mainRes) {
    const tracks = (state.tracks && state.tracks.tracks) || [];
    const baseTrack = (mainRes && mainRes.track) || pickNativeTrack();

    if (state.secondKey === 'translate') {
      return { type: 'translate', track: baseTrack };
    }
    if (state.secondKey) {
      const found = tracks.find((t) => trackKeyOf(t) === state.secondKey);
      if (!found) {
        return { type: 'translate', track: baseTrack }; // 這支影片沒有該軌，退回翻譯
      }
      // 第一行是「原生軌」時，第二行不能選同一軌（顯示兩次沒意義）→ 退回翻譯；
      // 第一行是翻譯時，第二行選任何原生軌都不會重複
      const sameAsNativeMain =
        mainRes && mainRes.type === 'native' && trackKeyOf(found) === trackKeyOf(mainRes.track);
      if (!sameAsNativeMain) {
        return { type: 'native', track: found };
      }
      return { type: 'translate', track: baseTrack };
    }
    // 自動
    if (mainRes && mainRes.type === 'native') {
      const mainCode = mainRes.track.languageCode;
      const manualSecond = tracks.find(
        (t) => t.languageCode !== mainCode && t.kind !== 'asr'
      );
      if (manualSecond) return { type: 'native', track: manualSecond };
      const anySecond = tracks.find((t) => t.languageCode !== mainCode);
      if (anySecond) return { type: 'native', track: anySecond };
      return { type: 'translate', track: baseTrack }; // 原生只有一種語言 → 翻譯
    }
    // 第一行是翻譯 → 自動顯示原生原字幕（人工軌優先）
    const native = pickNativeTrack();
    if (native) return { type: 'native', track: native };
    return { type: 'translate', track: baseTrack }; // 沒有任何原生軌（理論上不會發生）
  }

  // ---------------------------------------------------------------------------
  // 字幕抓取流程
  // ---------------------------------------------------------------------------

  /** 把字幕事件指定給某一行 */
  function setSlotEvents(slot, events) {
    if (slot === 'main') {
      state.mainEvents = events;
    } else {
      state.secondEvents = events;
    }
  }

  /** 清空兩行的需求與顯示資料，快取與進行中的請求保留供之後重用 */
  function clearSlots() {
    state.slotKeys.main = null;
    state.slotKeys.second = null;
    state.mainEvents = null;
    state.secondEvents = null;
  }

  /**
   * 為單一行準備字幕：快取有就直接用，否則送出抓取請求。
   * 同一份字幕正在抓取、或剛失敗不久時不會重複送出請求。
   * @param slot - 'main' 或 'second'
   * @param res - 該行的來源解析結果
   * @param force - 為 true 時忽略失敗後的冷卻時間
   */
  function requestSlot(slot, res, force) {
    if (!res || !res.track || !res.track.baseUrl) {
      state.slotKeys[slot] = null;
      setSlotEvents(slot, null);
      return;
    }

    const tlang = res.type === 'translate' ? state.targetLang : '';
    const videoId = (state.tracks && state.tracks.videoId) || '';
    const key = videoId + '|' + trackKeyOf(res.track) + '|' + tlang;
    state.slotKeys[slot] = key;

    const cached = state.cache.get(key);
    if (cached) {
      setSlotEvents(slot, cached);
      return;
    }
    setSlotEvents(slot, null);

    if (state.inflight.has(key)) return;
    const failed = state.errors.get(key);
    if (failed && !force && Date.now() - failed.at < ERROR_COOLDOWN_MS) return;

    state.errors.delete(key);
    // 保留抓取規格，失敗後的自動重試需要
    state.specs.set(key, { baseUrl: res.track.baseUrl, tlang });
    state.inflight.add(key);
    // 翻譯時加 tlang，原生時直接抓
    sendToBridge('yds:fetch', { key, baseUrl: res.track.baseUrl, tlang });
  }

  /** 開始一輪抓取（第一行 ＋ 第二行，各自送出請求） */
  function startFetchCycle(force) {
    if (!state.tracks) return;

    const mainRes = resolveMainSource();
    if (!mainRes.track || !mainRes.track.baseUrl) return;

    requestSlot('main', mainRes, force);
    requestSlot('second', resolveSecondSource(mainRes), force);
  }

  /** 收到 timedtext 資料，依 key 對應到目前需要這份字幕的行 */
  function handleFetchResult(data) {
    if (!data || typeof data.key !== 'string') return;

    state.inflight.delete(data.key);

    if (!data.ok) {
      state.errors.set(data.key, { reason: data.reason || 'unknown', at: Date.now() });
      // 翻譯字幕常見的 429 節流是暫時性的，排程自動重試
      scheduleRetry(data.key);
      return;
    }

    // 成功就取消還沒執行的重試
    const retryTimer = pendingRetries.get(data.key);
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      pendingRetries.delete(data.key);
    }
    state.errors.delete(data.key);

    try {
      const events = parseCaptionBody(data.body);
      state.cache.set(data.key, events);
      if (state.cache.size > CACHE_LIMIT) {
        state.cache.delete(state.cache.keys().next().value);
      }
      // 換影片或改設定後，已不需要的字幕只會留在快取，不會被顯示
      if (state.slotKeys.main === data.key) state.mainEvents = events;
      if (state.slotKeys.second === data.key) state.secondEvents = events;
    } catch (e) {
      // 回應解析失敗則該行保持空資料，並記錄原因供 popup 顯示
      state.errors.set(data.key, { reason: 'parse', at: Date.now() });
    }
  }

  /**
   * 收到播放器自己抓的字幕回應（bridge 攔截而來）。
   * 播放器的翻譯字幕請求不受 tlang 節流限制，這是翻譯字幕最可靠的來源之一：
   * 使用者在播放器字幕設定開啟「自動翻譯」的瞬間，該份字幕就會經這裡進快取。
   * @param data { key, videoId, tlang, body }
   */
  function handleCaptured(data) {
    if (!data || typeof data.key !== 'string' || !data.body) return;
    try {
      const events = parseCaptionBody(data.body);
      if (!events.length) return;
      state.cache.set(data.key, events);
      if (state.cache.size > CACHE_LIMIT) {
        state.cache.delete(state.cache.keys().next().value);
      }
      if (state.slotKeys.main === data.key) setSlotEvents('main', events);
      if (state.slotKeys.second === data.key) setSlotEvents('second', events);
    } catch (e) {
      // 非字幕回應或不支援的格式，忽略
    }
  }

  /**
   * 抓取失敗後的自動重試排程。
   * 只重試「目前仍在需要這份字幕」的 key（換影片或改設定後不會再發），
   * 每個 key 最多重試 RETRY_DELAYS_MS.length 次。
   * @param key 失敗的字幕 key
   */
  function scheduleRetry(key) {
    if (pendingRetries.has(key)) return; // 已有排程在等
    // 找出這個 key 目前對應哪一行
    const slot = state.slotKeys.main === key ? 'main' : state.slotKeys.second === key ? 'second' : null;
    if (!slot) return; // 已不再是目前的顯示需求

    const run = (attempt) => {
      const timer = window.setTimeout(() => {
        pendingRetries.delete(key);
        // 需求已改變、已經被其他來源（如擷取）補上、或重試次數用完就停止
        if (state.slotKeys[slot] !== key) return;
        if ((state.cache.get(key) || []).length) return;
        if (attempt >= RETRY_DELAYS_MS.length) return;
        // 採用過快取但仍失敗時，重試也要考慮已被擷取補上的情況，故快取判斷放在前面
        const spec = state.specs.get(key);
        if (!spec) return;
        state.errors.delete(key);
        state.inflight.add(key);
        sendToBridge('yds:fetch', { key, baseUrl: spec.baseUrl, tlang: spec.tlang });
        run(attempt + 1);
      }, RETRY_DELAYS_MS[attempt] || 0);
      pendingRetries.set(key, timer);
    };
    run(0);
  }

  /** 把內部錯誤代碼轉成給使用者看的說明 */
  function describeError(reason) {
    if (reason === 'no-pot') return '取不到播放器的 pot 權杖，請確認影片可正常播放';
    if (reason === 'empty') return 'YouTube 回傳空內容';
    if (reason === 'empty-translate') return 'YouTube 對翻譯請求回傳空內容';
    if (reason === 'parse') return '字幕資料解析失敗';
    const m = /HTTP (\d+)/.exec(reason);
    if (m) return m[1] === '429' ? '請求過於頻繁（HTTP 429），請稍後再試' : 'HTTP 狀態 ' + m[1];
    return reason;
  }

  /** 產生某一行目前的狀態說明，供 popup 顯示 */
  function describeSlotStatus(slot) {
    const key = state.slotKeys[slot];
    if (!key) return '無';
    const cached = state.cache.get(key);
    if (cached) return cached.length + ' 句';
    if (state.inflight.has(key)) return '載入中';
    const failed = state.errors.get(key);
    if (failed) return '失敗，' + describeError(failed.reason);
    return '待處理';
  }

  /**
   * 解析 YouTube json3 字幕格式
   * json3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
   * @returns {Array<{tStartMs:number, dDurationMs:number, text:string}>}
   */
  function parseJson3(json) {
    if (!json || !Array.isArray(json.events)) return [];
    const events = [];
    for (const ev of json.events) {
      if (typeof ev.tStartMs !== 'number') continue;
      const text = (ev.segs || [])
        .map((seg) => (seg && typeof seg.utf8 === 'string' ? seg.utf8 : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      events.push({
        tStartMs: ev.tStartMs,
        dDurationMs: typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 5000,
        text
      });
    }
    // 依開始時間排序，方便查找
    events.sort((a, b) => a.tStartMs - b.tStartMs);
    return events;
  }

  /**
   * 解析 YouTube srv3 XML 字幕格式（播放器自己抓字幕時可能使用這個格式）
   * srv3: <timedtext><body><p t="毫秒" d="毫秒">文字…</p></body></timedtext>
   * @returns {Array<{tStartMs:number, dDurationMs:number, text:string}>}
   */
  function parseSrv3(xmlText) {
    try {
      const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
      const paragraphs = doc.getElementsByTagName('p');
      const events = [];
      for (const p of paragraphs) {
        const startAttr = p.getAttribute('t');
        if (startAttr === null) continue;
        const tStartMs = parseInt(startAttr, 10);
        if (Number.isNaN(tStartMs)) continue;
        const text = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const dAttr = p.getAttribute('d');
        events.push({
          tStartMs,
          dDurationMs: dAttr !== null && !Number.isNaN(parseInt(dAttr, 10)) ? parseInt(dAttr, 10) : 5000,
          text
        });
      }
      // 依開始時間排序，方便查找
      events.sort((a, b) => a.tStartMs - b.tStartMs);
      return events;
    } catch (e) {
      return [];
    }
  }

  /**
   * 依內容格式解析字幕回應：json3 起始於「{」，srv3 XML 是「<」。
   * @param {string} body timedtext 回應內容
   */
  function parseCaptionBody(body) {
    const text = String(body || '');
    if (!text.trim()) return [];
    const trimmed = text.trim();
    if (trimmed[0] === '{') {
      return parseJson3(JSON.parse(text));
    }
    return parseSrv3(text);
  }

  /**
   * 找出 currentTime 所在的字幕事件
   * 自動字幕的事件時間常會互相重疊，因此取「開始時間最晚且仍在顯示期間」的那一筆，
   * 開始時間已超過目前時間之後的事件不需要再往後檢查。
   * @returns {string} 目前顯示文字，没有命中回傳空字串
   */
  function textAt(events, currentMs) {
    if (!events || !events.length) return '';
    let hit = '';
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.tStartMs > currentMs) break;
      if (currentMs < ev.tStartMs + ev.dDurationMs) {
        hit = ev.text;
      }
    }
    return hit;
  }

  // ---------------------------------------------------------------------------
  // Overlay 顯示
  // ---------------------------------------------------------------------------
  let overlay = null;
  let mainLine = null;
  let secondLine = null;
  let rafId = 0;

  /** 建立或取得 overlay DOM（掛在播放器元素內） */
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;

    destroyOverlay();

    const player = document.querySelector('.html5-video-player');
    if (!player) return null;

    overlay = document.createElement('div');
    overlay.className = 'yds-overlay';

    mainLine = document.createElement('div');
    mainLine.className = 'yds-line yds-line-main';
    secondLine = document.createElement('div');
    secondLine.className = 'yds-line yds-line-second';

    overlay.appendChild(mainLine);
    overlay.appendChild(secondLine);
    player.appendChild(overlay);
    return overlay;
  }

  function destroyOverlay() {
    if (overlay && overlay.isConnected) overlay.remove();
    overlay = null;
    mainLine = null;
    secondLine = null;
  }

  /**
   * 雙字幕資料就緒後，替根節點加上 yds-active 類別，讓樣式隱藏 YouTube 原生字幕。
   * 資料還沒就緒或抓取失敗時不隱藏，避免使用者什麼字幕都看不到。
   */
  function syncNativeCaptionHiding() {
    const shouldHide = !!(state.enabled && state.mainEvents && state.mainEvents.length);
    const root = document.documentElement;
    if (root.classList.contains('yds-active') !== shouldHide) {
      root.classList.toggle('yds-active', shouldHide);
    }
  }

  /** 顯示循環：依影片時間更新 overlay 文字 */
  function renderLoop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      const dom = ensureOverlay();

      syncNativeCaptionHiding();

      if (state.enabled && video && dom && state.mainEvents) {
        const currentMs = video.currentTime * 1000;
        const mainText = textAt(state.mainEvents, currentMs);
        const secondText = state.secondEvents ? textAt(state.secondEvents, currentMs) : '';

        if (mainText) {
          mainLine.textContent = mainText;
          mainLine.style.display = 'inline-block';
          if (secondText) {
            secondLine.textContent = secondText;
            secondLine.classList.remove('yds-line-hint');
            secondLine.style.display = 'inline-block';
          } else {
            const secondKey = state.slotKeys.second;
            const failed =
              secondKey && !state.inflight.has(secondKey) ? state.errors.get(secondKey) : null;
            // 翻譯（tlang）抓取失敗時顯示提示，告知使用者自備播放器翻譯即可補上
            const blockedTranslate =
              failed && secondKey.slice(secondKey.lastIndexOf('|') + 1) === state.targetLang;
            if (blockedTranslate) {
              secondLine.textContent =
                '⚠ 翻譯字幕被 YouTube 節流，約 20 秒後自動重試；在播放器字幕設定開啟「自動翻譯」可立即取得';
              secondLine.classList.add('yds-line-hint');
              secondLine.style.display = 'inline-block';
            } else {
              secondLine.classList.remove('yds-line-hint');
              secondLine.style.display = 'none';
            }
          }
          overlay.classList.add('yds-show');
        } else {
          overlay.classList.remove('yds-show');
        }
      } else if (dom) {
        dom.classList.remove('yds-show');
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  renderLoop();

  // ---------------------------------------------------------------------------
  // 網頁導航清理（SPA 換影片）
  // ---------------------------------------------------------------------------
  window.addEventListener('yt-navigate-finish', () => {
    // 清空字幕軌與字幕資料，避免用上支影片的資料誤抓
    state.tracks = null;
    state.specs.clear();
    // 取消所有排程中的重試（舊影片的 key 已無意義）
    for (const timer of pendingRetries.values()) window.clearTimeout(timer);
    pendingRetries.clear();
    clearSlots();
    destroyOverlay();
    // 導航完成後播放器回應會由 bridge 攔截並主動送出 yds:tracks，
    // 那時會重新開始抓取；若延遲到來再補一次查詢。
    window.setTimeout(() => {
      if (state.enabled && !state.tracks) {
        sendToBridge('yds:query-tracks', {});
      }
    }, 1500);
  });

  // ---------------------------------------------------------------------------
  // 讀取與監聽設定
  // ---------------------------------------------------------------------------
  chrome.storage.sync.get(
    { enabled: true, targetLang: 'zh-Hant', sourceKey: null, secondKey: '' },
    (items) => {
      state.enabled = items.enabled;
      state.targetLang = items.targetLang;
      state.sourceKey = items.sourceKey;
      state.secondKey = items.secondKey || null;
      if (state.enabled) {
        sendToBridge('yds:query-tracks', {});
      }
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const settings = {};
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
    if (changes.targetLang) settings.targetLang = changes.targetLang.newValue;
    if (changes.sourceKey) settings.sourceKey = changes.sourceKey.newValue;
    if (changes.secondKey) settings.secondKey = changes.secondKey.newValue;
    applySettings(settings);
  });

  function applySettings(settings) {
    const needRefetch =
      settings.sourceKey !== undefined ||
      settings.secondKey !== undefined ||
      (settings.targetLang !== undefined && settings.targetLang !== state.targetLang);

    if (settings.enabled !== undefined) state.enabled = settings.enabled;
    if (settings.targetLang !== undefined) state.targetLang = settings.targetLang;
    if (settings.sourceKey !== undefined) state.sourceKey = settings.sourceKey || null;
    if (settings.secondKey !== undefined) state.secondKey = settings.secondKey || null;

    if (state.enabled) {
      if (needRefetch) {
        // 使用者主動改設定，忽略失敗冷卻時間直接重試
        startFetchCycle(true);
      } else {
        sendToBridge('yds:query-tracks', {});
      }
    } else {
      // 關閉時清空資料，overlay 會自動不顯示
      clearSlots();
    }
  }

  // ---------------------------------------------------------------------------
  // popup 查詢
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'YDS_QUERY') {
      const mainRes = resolveMainSource();
      sendResponse({
        ok: true,
        enabled: state.enabled,
        targetLang: state.targetLang,
        sourceKey: state.sourceKey,
        secondKey: state.secondKey || '',
        videoId: state.tracks ? state.tracks.videoId : null,
        statusMain: describeSlotStatus('main'),
        statusSecond: describeSlotStatus('second'),
        tracks:
          state.tracks && state.tracks.tracks
            ? state.tracks.tracks.map((t) => ({
                key: trackKeyOf(t),
                // YouTube 已開始對部分影片混淆字幕軌顯示名稱（亂數字串），
                // 名稱一律由 languageCode 產生，不採用 YouTube 給的 name
                label: describeLanguage(t.languageCode),
                languageCode: t.languageCode,
                kind: t.kind
              }))
            : [],
        usingMain:
          mainRes && mainRes.track
            ? mainRes.type === 'translate'
              ? 'translate'
              : trackKeyOf(mainRes.track)
            : null
      });
    } else if (msg && msg.type === 'YDS_SET') {
      // popup 一次只會設定一個 key
      const patch = {};
      if (msg.enabled !== undefined) patch.enabled = msg.enabled;
      if (msg.targetLang !== undefined) patch.targetLang = msg.targetLang;
      if (msg.sourceKey !== undefined) patch.sourceKey = msg.sourceKey;
      if (msg.secondKey !== undefined) patch.secondKey = msg.secondKey;
      chrome.storage.sync.set(patch, () => {
        sendResponse({ ok: true });
      });
      return true; // 非同步回應
    }
    return undefined;
  });
})();
