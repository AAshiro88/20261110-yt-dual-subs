/**
 * bridge.js — 執行於頁面上下文的腳本（Strict Isolation: MAIN world）
 *
 * 職責：
 * 1. 攔截 fetch / XMLHttpRequest，從 /youtubei/v1/player 回應中取得字幕軌清單
 *    （captionTracks 含 baseUrl），丟給隔離世界的 content script。
 * 2. 代替 content script 向 YouTube timedtext API 抓取字幕資料
 *    （原始字幕＋加入 tlang 參數的內建翻譯字幕）。
 *
 * 必須在 MAIN world 執行的原因：
 * - timedtext API 需要頁面本身的使用者憑證與環境，content script（ISOLATED world）
 *   在 MV3 中發出的 fetch 會被視為跨來源而被 CORS 擋下。
 * - 需要在頁面自身發出請求前掛上攔截，因此 run_at 為 document_start。
 */
(() => {
  'use strict';

  const PLAYER_API_PATH = '/youtubei/v1/player';

  /** 最後一次看到的字幕軌資訊（來自播放器回應） */
  let cachedTracks = null; // { videoId, tracks: [{ baseUrl, languageCode, name, kind }] }

  /** 送訊息給隔離世界的 content script */
  function sendToContent(event, payload) {
    try {
      window.postMessage({ __ydsBridge: true, event, payload }, window.location.origin);
    } catch (e) {
      // postMessage 失敗不影響頁面本身
    }
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
      handleSubtitleFetch(ev.data.gen, ev.data.slot, ev.data.baseUrl, ev.data.tlang);
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
   * 兩行字幕各自呼叫一次（slot 'main' / 'second'）。
   * @param {number} gen - content script 的抓取輪次，原樣回傳，過期請求由 content script 丟棄
   * @param {string} slot - 顯示哪一行（'main' 或 'second'）
   * @param {string} baseUrl - subtitle 軌的 baseUrl
   * @param {string} tlang - 目標翻譯語言（空字串表示直接使用原生字幕軌）
   */
  async function handleSubtitleFetch(gen, slot, baseUrl, tlang) {
    try {
      const url = new URL(baseUrl, window.location.origin);
      url.searchParams.set('fmt', 'json3');
      if (tlang) {
        url.searchParams.set('tlang', tlang);
      }
      const body = await fetchTimedText(url.href);
      sendToContent('yds:data', { gen, slot, ok: true, body });
    } catch (e) {
      sendToContent('yds:data', {
        gen,
        slot,
        ok: false,
        body: String((e && e.message) || e)
      });
    }
  }
})();
