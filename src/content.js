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

  // ---------------------------------------------------------------------------
  // 狀態
  // ---------------------------------------------------------------------------
  const state = {
    enabled: true, /** 開關（來自 storage） */
    targetLang: 'zh-Hant', /** 機器翻譯的目標語言（來自 storage） */
    sourceKey: null, /** 第一行來源字幕軌，格式 "languageCode|kind"；null = 自動 */
    secondKey: null, /** 第二行來源："track key" 指定原生軌、'translate' 指定機器翻譯；null/'' = 自動（原生雙語優先） */
    tracks: null, /** { videoId, tracks:[{baseUrl, languageCode, name, kind}] } */
    fetchGen: 0, /** 抓取輪次，過期的抓取回應會被忽略 */
    mainEvents: null, /** 第一行字幕事件 [{tStartMs, dDurationMs, text}] */
    secondEvents: null /** 第二行字幕事件 */
  };

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
        startFetchCycle();
      }
    } else if (ev.data.event === 'yds:data') {
      handleFetchResult(ev.data.payload);
    }
  });

  // ---------------------------------------------------------------------------
  // 字幕軌挑選
  // ---------------------------------------------------------------------------

  /** 以 "languageCode|kind" 格式組字幕軌 key */
  function trackKeyOf(track) {
    return track.languageCode + '|' + track.kind;
  }

  /** 依目前選擇決定第一行要使用的字幕軌 */
  function pickMainTrack() {
    const tracks = state.tracks && state.tracks.tracks;
    if (!tracks || !tracks.length) return null;

    if (state.sourceKey) {
      const found = tracks.find((t) => trackKeyOf(t) === state.sourceKey);
      if (found) return found;
    }
    // 自動選擇：優先人工字幕（kind 不是 asr），否則第一軌
    const manual = tracks.find((t) => t.kind !== 'asr');
    return manual || tracks[0];
  }

  /**
   * 決定第二行的內容來源。
   * 優先序：
   *   1. 使用者指定原生軌（secondKey 是 track key）
   *   2. 使用者指定機器翻譯（secondKey = 'translate'）
   *   3. 自動：影片原生有第二種語言的字幕軌 → 直接使用（人工軌優先於 ASR）
   *   4. 自動且原生只有一種語言 → 退回機器翻譯
   * @param {{languageCode:string}} mainTrack
   * @returns {{type:'native', track:object} | {type:'translate'}}
   */
  function resolveSecondSource(mainTrack) {
    const tracks = (state.tracks && state.tracks.tracks) || [];

    if (state.secondKey === 'translate') {
      return { type: 'translate' };
    }
    if (state.secondKey) {
      const found = tracks.find((t) => trackKeyOf(t) === state.secondKey);
      if (found && (!mainTrack || trackKeyOf(found) !== trackKeyOf(mainTrack))) {
        return { type: 'native', track: found };
      }
    }
    if (mainTrack) {
      // 自動：挑一個與主軌語言不同的原生軌，人工字幕優先
      const manualSecond = tracks.find(
        (t) => t.languageCode !== mainTrack.languageCode && t.kind !== 'asr'
      );
      if (manualSecond) return { type: 'native', track: manualSecond };
      const anySecond = tracks.find((t) => t.languageCode !== mainTrack.languageCode);
      if (anySecond) return { type: 'native', track: anySecond };
    }
    return { type: 'translate' };
  }

  // ---------------------------------------------------------------------------
  // 字幕抓取流程
  // ---------------------------------------------------------------------------
  /** 開始一輪抓取（第一行 ＋ 第二行，各自送出請求） */
  function startFetchCycle() {
    const mainTrack = pickMainTrack();
    if (!mainTrack || !mainTrack.baseUrl || !state.tracks) return;

    // 新輪次：舊的過期回應一律忽略
    state.fetchGen += 1;
    const gen = state.fetchGen;
    state.mainEvents = null;
    state.secondEvents = null;

    sendToBridge('yds:fetch', {
      gen,
      slot: 'main',
      baseUrl: mainTrack.baseUrl,
      tlang: ''
    });

    const second = resolveSecondSource(mainTrack);
    if (second.type === 'native') {
      sendToBridge('yds:fetch', {
        gen,
        slot: 'second',
        baseUrl: second.track.baseUrl,
        tlang: ''
      });
    } else {
      sendToBridge('yds:fetch', {
        gen,
        slot: 'second',
        baseUrl: mainTrack.baseUrl,
        tlang: state.targetLang
      });
    }
  }

  /** 收到 timedtext 資料（依 gen 判斷是否過期） */
  function handleFetchResult(data) {
    if (!data || typeof data.gen !== 'number' || data.gen !== state.fetchGen) return;

    if (!data.ok) return;

    try {
      const json = JSON.parse(data.body);
      const events = parseJson3(json);
      if (data.slot === 'main') {
        state.mainEvents = events;
      } else if (data.slot === 'second') {
        state.secondEvents = events;
      }
    } catch (e) {
      // 回應解析失敗則該行保持空資料
    }
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
   * 找出 currentTime 所在的字幕事件
   * @returns {string} 目前顯示文字，没有命中回傳空字串
   */
  function textAt(events, currentMs) {
    if (!events || !events.length) return '';
    // 線性掃描即可（事件數通常數百），保持簡單可靠
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (currentMs >= ev.tStartMs && currentMs < ev.tStartMs + ev.dDurationMs) {
        return ev.text;
      }
    }
    return '';
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

  /** 顯示循環：依影片時間更新 overlay 文字 */
  function renderLoop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      const dom = ensureOverlay();

      if (state.enabled && video && dom && state.mainEvents) {
        const currentMs = video.currentTime * 1000;
        const mainText = textAt(state.mainEvents, currentMs);
        const secondText = state.secondEvents ? textAt(state.secondEvents, currentMs) : '';

        if (mainText) {
          mainLine.textContent = mainText;
          mainLine.style.display = 'inline-block';
          // 第二行資料還沒到或該時段沒有字幕時隱藏
          secondLine.style.display = secondText ? 'inline-block' : 'none';
          if (secondText) secondLine.textContent = secondText;
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
    state.mainEvents = null;
    state.secondEvents = null;
    state.fetchGen += 1; // 使所有在途請求失效
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
    if (settings.sourceKey !== undefined) state.sourceKey = settings.sourceKey;
    if (settings.secondKey !== undefined) state.secondKey = settings.secondKey || null;

    if (state.enabled) {
      if (needRefetch) {
        startFetchCycle();
      } else {
        sendToBridge('yds:query-tracks', {});
      }
    } else {
      // 關閉時清空資料，overlay 會自動不顯示
      state.mainEvents = null;
      state.secondEvents = null;
      state.fetchGen += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // popup 查詢
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'YDS_QUERY') {
      const mainTrack = pickMainTrack();
      sendResponse({
        ok: true,
        enabled: state.enabled,
        targetLang: state.targetLang,
        sourceKey: state.sourceKey,
        secondKey: state.secondKey || '',
        videoId: state.tracks ? state.tracks.videoId : null,
        tracks:
          state.tracks && state.tracks.tracks
            ? state.tracks.tracks.map((t) => ({
                key: trackKeyOf(t),
                label: t.name,
                languageCode: t.languageCode,
                kind: t.kind
              }))
            : [],
        usingMain: mainTrack ? trackKeyOf(mainTrack) : null
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
