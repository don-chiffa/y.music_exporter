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

// clear badges on tabs that are not music.yandex.ru to avoid stale counts
chrome.tabs.query({}, (tabs) => {
  for (const t of tabs) {
    try {
      if (!t.url || !YAM_MATCH.test(t.url)) {
        chrome.action.setBadgeText({ tabId: t.id, text: '' });
      }
    } catch (e) {}
  }
});

// простое хранилище по вкладке
const STATE = new Map();
const st = id => (STATE.get(id) || { tracks: [] });

function setCount(tabId, n) {
  try {
    // ensure tab still exists
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return;
      if (!t) return;
      if (!n) {
        chrome.action.setBadgeText({ tabId, text: '' });
      } else {
        chrome.action.setBadgeText({ tabId, text: String(n) });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#0b6' });
      }
    });
  } catch (e) {
    // ignore
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // keep existing state when tabs update; content script will send yam_tracks when ready
  if (info.status === "loading" && tab?.url && YAM_MATCH.test(tab.url)) {
    STATE.set(tabId, { tracks: [] });
  }
});
chrome.tabs.onRemoved.addListener(tabId => STATE.delete(tabId));

// When optional host permissions are granted, inject content script into existing tabs
chrome.permissions.onAdded.addListener(async (p) => {
  try {
    if (!p || !p.origins) return;
    const matched = p.origins.some(o => MATCHES.includes(o) || o === 'https://music.yandex.ru/*');
    if (!matched) return;
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    for (const t of tabs) {
      try {
        if (t?.url && YAM_MATCH.test(t.url)) {
          // inject content script into all frames
          await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
          // Ask the tab for current tracks via message; if there's no listener yet, fall back to executing a small DOM extractor
          let asked = false;
          try {
            chrome.tabs.sendMessage(t.id, { type: 'yam_get_tracks' }, (resp) => {
              asked = true;
              if (chrome.runtime.lastError) return;
              if (resp && Array.isArray(resp.tracks)) {
                STATE.set(t.id, { tracks: resp.tracks });
                const n = resp.tracks.length;
                setCount(t.id, n);
                chrome.runtime.sendMessage({ type: 'yam_progress_broadcast', tabId: t.id, count: n }, () => void chrome.runtime.lastError);
              }
            });
          } catch (e) { /* ignore */ }

          // If tabs.sendMessage didn't reach a listener (asked===false after a tick), try executeScript fallback
          try {
            if (!asked) {
              const res = await chrome.scripting.executeScript({
                target: { tabId: t.id, allFrames: false },
                func: () => {
                  const out = [];
                  try {
                    const nodes = Array.from(document.querySelectorAll("[data-qa='track'], .d-track, li, div[class*='track'], [data-test-id*='track']"));
                    for (const n of nodes) {
                      try {
                        const pick = (sels) => {
                          for (const s of sels) {
                            const el = n.querySelector(s);
                            if (el && el.textContent) return el.textContent.trim().replace(/\s+/g, ' ');
                          }
                          return '';
                        };
                        const title = pick(["[data-qa='track-name']","[class*='Meta_title__']","a[href*='/track/']",".d-track__name"]);
                        const artist = pick(["[data-qa='track-author']","[class*='Meta_artists__']","a[href*='/artist/']",".d-track__artists"]);
                        const link = n.querySelector("a[href*='/track/'], a[href^='/track/'], a[href*='/album/']");
                        const url = link ? (new URL(link.getAttribute('href'), location.origin).href) : '';
                        if (title && artist) out.push({ artist, title, url });
                      } catch (e) {}
                    }
                  } catch (e) {}
                  return out;
                }
              }).catch(() => []);
              const collected = [];
              for (const r of (res || [])) {
                if (r && r.result && Array.isArray(r.result)) {
                  for (const it of r.result) collected.push(it);
                }
              }
              if (collected.length) {
                // dedupe
                const seen = new Set();
                const dedup = [];
                for (const item of collected) {
                  const k = `${item.artist} — ${item.title}`;
                  if (!seen.has(k)) { seen.add(k); dedup.push(item); }
                }
                STATE.set(t.id, { tracks: dedup });
                setCount(t.id, dedup.length);
                chrome.runtime.sendMessage({ type: 'yam_progress_broadcast', tabId: t.id, count: dedup.length }, () => void chrome.runtime.lastError);
              }
            }
          } catch (e) { /* ignore fallback errors */ }
        }
      } catch (e) { /* ignore per-tab errors */ }
    }
  } catch (e) {}
});

// сообщения
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id ?? msg?.tabId;

  if (msg?.type === "yam_tracks") {
    console.log('[YAM sw] received yam_tracks from', tabId, 'count=', Array.isArray(msg.tracks) ? msg.tracks.length : 0);
    STATE.set(tabId, { tracks: Array.isArray(msg.tracks) ? msg.tracks : [] });
    const n = st(tabId).tracks.length;
    // only set badge if tab URL matches music.yandex.ru
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t || !t.url || !YAM_MATCH.test(t.url)) {
        // clear badge to avoid stale counts
        setCount(tabId, 0);
      } else {
        setCount(tabId, n);
      }
    });
  chrome.runtime.sendMessage({ type: "yam_progress_broadcast", tabId, count: n }, () => void chrome.runtime.lastError);
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