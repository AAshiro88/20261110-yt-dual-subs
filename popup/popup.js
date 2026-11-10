/**
 * popup.js — 擴充快捷選單
 *
 * 控制：開關、第一行來源（自動 / 機器翻譯 / 原生軌）、第二行來源（同左三種）、
 *       機器翻譯的目標語言。
 * 設定以 chrome.storage.sync 保存，content script 監聽變更即時套用。
 */

/** 提供的機器翻譯目標語言（YouTube 內建翻譯支援的常用語言） */
const TARGET_LANGS = [
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'zh-Hans', label: '簡體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' }
];

/** 只允許這個 host */
const ALLOWED_HOST = 'www.youtube.com';

const toggleEl = document.getElementById('toggle');
const sourceEl = document.getElementById('source');
const secondEl = document.getElementById('second');
const targetEl = document.getElementById('target');
const statusEl = document.getElementById('status');

/** 目前操作到的分頁 */
let activeTabId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

/** 開關只畫狀態，不觸發事件 */
function drawToggle(on) {
  toggleEl.classList.toggle('on', on);
}

/** 頁面網址是否為允許的 YouTube 網站 */
function isAllowedUrl(url) {
  try {
    return new URL(url).hostname === ALLOWED_HOST;
  } catch (e) {
    return false;
  }
}

/** 填入字幕軌選項；asr 表示 YouTube 自動語音辨識產生的字幕 */
function asrMark(kind) {
  return kind === 'asr' ? '（自動）' : '';
}

/** 取得目前分頁並查詢 content script 狀態 */
async function init() {
  // 填入機器翻譯語言選項
  for (const lang of TARGET_LANGS) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    targetEl.appendChild(opt);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !isAllowedUrl(tab.url)) {
    drawToggle(false);
    setStatus('僅支援 ' + ALLOWED_HOST + ' 網址');
    return;
  }
  activeTabId = tab.id;

  let state;
  try {
    state = await chrome.tabs.sendMessage(activeTabId, { type: 'YDS_QUERY' });
  } catch (e) {
    state = null;
  }

  if (!state || !state.ok) {
    drawToggle(false);
    setStatus('無法連線到頁面，請重新載入 YouTube 分頁');
    return;
  }

  drawToggle(state.enabled);

  if (state.tracks.length === 0) {
    // 此影片沒有字幕軌：兩個選單都鎖住
    const disabledOpt = document.createElement('option');
    disabledOpt.value = '';
    disabledOpt.textContent = '此影片沒有可用字幕';
    disabledOpt.disabled = true;
    sourceEl.textContent = '';
    sourceEl.appendChild(disabledOpt);

    secondEl.textContent = '';
    const noTrack = document.createElement('option');
    noTrack.value = '';
    noTrack.textContent = '—';
    noTrack.disabled = true;
    secondEl.appendChild(noTrack);

    setStatus('此影片沒有字幕軌');
    return;
  }

  const trackOptions = () => state.tracks.map((track) => ({
    value: track.key,
    label: `${track.label} ${asrMark(track.kind)}`
  }));

  // 第一行：自動（原字幕軌）+ 機器翻譯 + 各原生字幕軌，全部可選
  sourceEl.textContent = '';
  const autoMainOpt = document.createElement('option');
  autoMainOpt.value = '';
  autoMainOpt.textContent = '自動（原字幕軌）';
  sourceEl.appendChild(autoMainOpt);

  const transMainOpt = document.createElement('option');
  transMainOpt.value = 'translate';
  transMainOpt.textContent = '機器翻譯（使用下方語言）';
  sourceEl.appendChild(transMainOpt);
  for (const optInfo of trackOptions()) {
    const opt = document.createElement('option');
    opt.value = optInfo.value;
    opt.textContent = optInfo.label;
    sourceEl.appendChild(opt);
  }
  // 顯示「使用者實際儲存的選擇」，目前影片沒有該軌時退回自動（避免空白選項）
  sourceEl.value = state.sourceKey || '';
  if (sourceEl.selectedIndex === -1) sourceEl.value = '';

  // 第二行：自動 / 機器翻譯 / 各原生字幕軌
  secondEl.textContent = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = '自動（原生雙語優先，否則機器翻譯）';
  secondEl.appendChild(autoOpt);

  const transOpt = document.createElement('option');
  transOpt.value = 'translate';
  transOpt.textContent = '機器翻譯（使用下方語言）';
  secondEl.appendChild(transOpt);

  for (const optInfo of trackOptions()) {
    const opt = document.createElement('option');
    opt.value = optInfo.value;
    opt.textContent = optInfo.label;
    secondEl.appendChild(opt);
  }
  secondEl.value = state.secondKey || '';
  if (secondEl.selectedIndex === -1) secondEl.value = '';

  targetEl.value = state.targetLang || 'zh-Hant';
  if (targetEl.selectedIndex === -1) targetEl.value = 'zh-Hant';
  setStatus(state.enabled ? '運作中' : '已停用');
}

/** 送設定到 content script */
function postSetting(patch) {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'YDS_SET', ...patch }).catch(() => {});
}

toggleEl.addEventListener('click', () => {
  const next = !toggleEl.classList.contains('on');
  drawToggle(next);
  setStatus(next ? '運作中' : '已停用');
  postSetting({ enabled: next });
});

sourceEl.addEventListener('change', () => {
  postSetting({ sourceKey: sourceEl.value });
});

secondEl.addEventListener('change', () => {
  postSetting({ secondKey: secondEl.value });
});

targetEl.addEventListener('change', () => {
  postSetting({ targetLang: targetEl.value });
});

init();
