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
    } catch (e) {
      // 網址解析失敗就忽略這次請求
    }
  }

  /** 目前記住的 pot 是否屬於指定影片 */
  function potMatches(videoId) {
    return !!potInfo && (!videoId || !potInfo.videoId || potInfo.videoId === videoId);
  }

  /**
   * 從 YouTube 播放器介面取得字幕是否為開啟狀態
   */
  function isCaptionButtonOn() {
    const btn = document.querySelector('.ytp-subtitles-button');
    return !!btn && btn.getAttribute('aria-pressed') === 'true';
  }

  /**
   * 催促播放器發出一次帶 pot 的 timedtext 請求。
   * 第一次先開啟字幕，之後改用重新載入字幕，因為剛開啟時播放器的簽章模組
   * 可能還沒準備好，第一個請求會沒有 pot。
   * @param attempt 第幾次嘗試，從 0 開始
   */
  function pokePlayer(attempt) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    try {
      if (attempt === 0) {
        if (typeof player.toggleSubtitlesOn === 'function') player.toggleSubtitlesOn();
      } else if (typeof player.setOption === 'function') {
        player.setOption('captions', 'reload', true);
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
          nextPokeAt = elapsed + 2000;
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
    if ((xhr.__ydsUrl || '').indexOf(PLAYER_API_PATH) !== -1) {
      xhr.addEventListener('load', () => {
        try {
          const json = JSON.parse(xhr.responseText);
          if (json && json.responseContext) extractTracksFromPlayerResponse(json);
        } catch (e) {
          // 忽略非 JSON 回應
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
      handleSubtitleFetch(ev.data.key, ev.data.baseUrl, ev.data.tlang);
    }
  });

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
  async function handleSubtitleFetch(key, baseUrl, tlang) {
    try {
      const videoId = videoIdOfUrl(baseUrl) || (cachedTracks && cachedTracks.videoId) || '';
      let body = '';

      for (let attempt = 0; attempt < 2 && !body; attempt++) {
        const pot = await obtainPot(videoId);
        if (!pot) throw new Error('no-pot');

        const url = new URL(baseUrl, window.location.origin);
        url.searchParams.set('fmt', 'json3');
        url.searchParams.set('pot', pot.pot);
        url.searchParams.set('potc', pot.potc);
        url.searchParams.set('c', pot.c);
        if (tlang) {
          url.searchParams.set('tlang', tlang);
        }

        body = await fetchTimedText(url.href);
        if (!body) {
          // 內容為空，丟棄目前的 pot，下一輪重新向播放器取得
          potInfo = null;
        }
      }

      if (!body) throw new Error(tlang ? 'empty-translate' : 'empty');
      sendToContent('yds:data', { key, ok: true, body, reason: '' });
    } catch (e) {
      sendToContent('yds:data', {
        key,
        ok: false,
        body: '',
        reason: String((e && e.message) || e)
      });
    }
  }
})();
