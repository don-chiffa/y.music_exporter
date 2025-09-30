// ===== SW: регистрация content.js + состояние + зеленый бейдж =====
const CS_ID = "yam-content-auto";
const MATCHES = ["https://music.yandex.ru/*", "https://music.yandex.ru/iframe/*"];
const YAM_MATCH = /(^https:\/\/music\.yandex\.ru\/)|(^https:\/\/music\.yandex\.ru\/iframe\/)/;

async function ensureCSRegistered() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CS_ID] }).catch(() => []);
  if (existing && existing.length) return;
  await chrome.scripting.unregisterContentScripts({ ids: [CS_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: CS_ID,
    matches: MATCHES,
    js: ["content.js"],
    runAt: "document_end",
    allFrames: true,
    persistAcrossSessions: true
  }]);
  console.log("[YAM sw] content script registered:", MATCHES);
}
chrome.runtime.onInstalled.addListener(ensureCSRegistered);
chrome.runtime.onStartup.addListener(ensureCSRegistered);
ensureCSRegistered();

// простое хранилище по вкладке
const STATE = new Map();
const st = id => (STATE.get(id) || { tracks: [] });

function setCount(tabId, n) {
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#0b6" }); // зеленый
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" && tab?.url && YAM_MATCH.test(tab.url)) {
    STATE.set(tabId, { tracks: [] });
    setCount(tabId, 0);
  }
});
chrome.tabs.onRemoved.addListener(tabId => STATE.delete(tabId));

// сообщения
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id ?? msg?.tabId;

  if (msg?.type === "yam_tracks") {
    STATE.set(tabId, { tracks: Array.isArray(msg.tracks) ? msg.tracks : [] });
    const n = st(tabId).tracks.length;
    setCount(tabId, n);
    chrome.runtime.sendMessage({ type: "yam_progress_broadcast", tabId, count: n });
    sendResponse?.({ ok: true, count: n });
    return true;
  }

  if (msg?.type === "yam_get_state") {
    sendResponse?.({ ok: true, tracks: st(msg.tabId).tracks });
    return true;
  }

  if (msg?.type === "yam_reset") {
    STATE.set(tabId, { tracks: [] });
    setCount(tabId, 0);
    sendResponse?.({ ok: true });
    return true;
  }
});