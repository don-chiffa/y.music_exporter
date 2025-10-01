// ==== настройки ====
const SITE_ORIGINS = ["https://music.yandex.ru/*", "https://music.yandex.ru/iframe/*"];

// ==== helpers ====
async function hasSitePerms() { return await chrome.permissions.contains({ origins: SITE_ORIGINS }); }
async function requestSitePerms() { return await chrome.permissions.request({ origins: SITE_ORIGINS }); }
async function activeTab() { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t || null; }
async function bgState(tabId) { return new Promise(r => chrome.runtime.sendMessage({ type: "yam_get_state", tabId }, x => { void chrome.runtime.lastError; r(x || {}); })); }
function downloadFile(filename, data, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename, saveAs: true, conflictAction: "uniquify" },
    () => URL.revokeObjectURL(url)
  );
}

// ==== состояние попапа ====
let __prevCount = 0;
let __scrollEl = null; // <main>

// ==== рендер со склейкой к низу при приросте ====
function render(tracks) {
  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  const n = Array.isArray(tracks) ? tracks.length : 0;

  const scrollEl = __scrollEl || document.querySelector("main");
  const grew = n > __prevCount;
  const nearBottom = scrollEl
    ? (scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight)) < 120
    : false;

  document.getElementById("count-badge").textContent = n;
  document.getElementById("exportTxt").disabled = n === 0;
  document.getElementById("exportTsv").disabled = n === 0;

  list.innerHTML = "";
  if (n === 0) {
    empty.style.display = "block";
    __prevCount = n;
    return;
  }
  empty.style.display = "none";

  for (const t of tracks.slice(0, 600)) {
    const div = document.createElement("div");
    div.className = "track";
    div.innerHTML = `<div class="tline"><span class="artist">${t.artist || ""}</span> — <span class="title">${t.title || ""}</span></div>
                     <div class="link">${t.url ? `<a href="${t.url}" target="_blank" rel="noopener">ссылка</a>` : ""}</div>`;
    list.appendChild(div);
  }
  if (n > 600) {
    const more = document.createElement("div"); more.className = "empty"; more.textContent = `…и еще ${n - 600}`;
    list.appendChild(more);
  }

  if (grew && nearBottom && scrollEl) {
    requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });
  }

  __prevCount = n;
}

// ==== обновление из фона с фоллбеком к контенту ====
async function refresh() {
  const tab = await activeTab(); if (!tab) return;
  const tabId = tab.id;

  const st = await bgState(tabId);
  const tracks = Array.isArray(st?.tracks) ? st.tracks : [];
  render(tracks);

  if (tracks.length === 0) {
    chrome.tabs.sendMessage(tabId, { type: "yam_manual_start" }, () => void chrome.runtime.lastError);
    chrome.tabs.sendMessage(tabId, { type: "yam_get_tracks" }, () => void chrome.runtime.lastError);
    // If no response from content script, try to scrape DOM via scripting as a fallback
    try {
      const framesResults = await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, func: () => {
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
      } }).catch(() => []);

      const collected = [];
      for (const r of (framesResults || [])) {
        if (r && r.result && Array.isArray(r.result)) {
          for (const it of r.result) collected.push(it);
        }
      }
      if (collected.length) {
        const seen = new Set();
        const dedup = [];
        for (const item of collected) {
          const k = `${item.artist} — ${item.title}`;
          if (!seen.has(k)) { seen.add(k); dedup.push(item); }
        }
        // update badge immediately
        try { chrome.action.setBadgeText({ tabId, text: dedup.length ? String(dedup.length) : '' }); if (dedup.length) chrome.action.setBadgeBackgroundColor({ tabId, color: '#0b6' }); } catch(e){}
        // persist to background
        chrome.runtime.sendMessage({ type: 'yam_tracks', tracks: dedup, tabId }, () => void chrome.runtime.lastError);
        if (Array.isArray(dedup) && dedup.length) render(dedup);
        return;
      }
    } catch (e) {}

    setTimeout(async () => {
      const st2 = await bgState(tabId);
      render(Array.isArray(st2?.tracks) ? st2.tracks : []);
    }, 300);
  }
}

// ==== init ====
document.addEventListener("DOMContentLoaded", async () => {
  __scrollEl = document.querySelector("main");

  // выдача прав / видимость карточек
  const havePerms = await hasSitePerms();
  document.getElementById("grant-card").hidden = havePerms;
  document.getElementById("list-card").hidden = !havePerms;
  document.getElementById("hint").hidden = !havePerms ? true : false;

  const grantBtn = document.getElementById("grant");
  if (grantBtn) {
    grantBtn.onclick = async () => {
      const ok = await requestSitePerms();
      if (ok) {
        document.getElementById("grant-card").hidden = true;
        document.getElementById("list-card").hidden = false;
        document.getElementById("hint").hidden = false;
        // hide any previous error
        const prev = document.getElementById("grant-error"); if (prev) { prev.hidden = true; prev.textContent = ""; }
        refresh();
        // Inject content script into existing music.yandex.ru tabs so no page reload is required
        try {
          const tabs = await chrome.tabs.query({});
          const cur = await activeTab();
          let responded = false;
          for (const t of tabs) {
            try {
              if (t.url && t.url.startsWith('https://music.yandex.ru/')) {
                // inject content script into all frames to ensure listeners exist
                await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
                // Attempt to scrape DOM in all frames directly (executeScript with func)
                try {
                  const framesResults = await chrome.scripting.executeScript({
                    target: { tabId: t.id, allFrames: true },
                    func: () => {
                      const out = [];
                      // simple extractor — mirrors common patterns used on Yandex.Music
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
                        } catch (e) { }
                      }
                      return out;
                    }
                  });

                  // framesResults is an array of InjectionResult objects; collect results
                  const collected = [];
                  for (const r of framesResults || []) {
                    if (r && r.result && Array.isArray(r.result)) {
                      for (const it of r.result) collected.push(it);
                    }
                  }
                  // dedupe by artist — title
                  const seen = new Set();
                  const dedup = [];
                  for (const item of collected) {
                    const k = `${item.artist} — ${item.title}`;
                    if (!seen.has(k)) { seen.add(k); dedup.push(item); }
                  }
                  // update badge immediately from popup so user sees result without reload
                  try {
                    const text = dedup.length ? String(dedup.length) : '';
                    chrome.action.setBadgeText({ tabId: t.id, text });
                    if (dedup.length) chrome.action.setBadgeBackgroundColor({ tabId: t.id, color: '#0b6' });
                  } catch (e) {}
                  // send collected tracks to background for persistent state
                  chrome.runtime.sendMessage({ type: 'yam_tracks', tracks: dedup, tabId: t.id }, () => {});
                  if (cur && t.id === cur.id) { render(dedup); responded = true; }
                } catch (e) {
                  // fallback: tell content script to start; we'll refresh later
                  chrome.tabs.sendMessage(t.id, { type: 'yam_manual_start' }, () => void chrome.runtime.lastError);
                  chrome.tabs.sendMessage(t.id, { type: 'yam_get_tracks' }, (resp) => {
                    if (chrome.runtime.lastError) return;
                    if (resp && Array.isArray(resp.tracks)) {
                      if (cur && t.id === cur.id) { render(resp.tracks); responded = true; }
                    }
                  });
                }
              } else if (typeof t.id === 'number') {
                // clear badge on non-music tabs to remove stale counts
                chrome.action.setBadgeText({ tabId: t.id, text: '' });
              }
            } catch (e) { /* ignore per-tab errors */ }
          }
          // if we didn't get an immediate response for the active tab, refresh after short delay
          if (!responded) setTimeout(refresh, 500);
        } catch (e) {
          // ignore global errors, fallback to refresh
          setTimeout(refresh, 500);
        }
      } else {
        const errEl = document.getElementById("grant-error");
        if (errEl) {
          errEl.hidden = false;
          const last = chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null;
          errEl.textContent = last ? `Ошибка выдачи прав: ${last}` : `Доступ не предоставлен.`;
        }
      }
    };
  }

  // экспорт
  const support = document.getElementById("support");
  // TXT
  document.getElementById("exportTxt").onclick = async () => {
    const tab = await activeTab(); if (!tab) return;
    const st = await bgState(tab.id);
    const tracks = Array.isArray(st?.tracks) ? st.tracks : [];
    const txt = tracks.map(t => `${t.artist || ""} — ${t.title || ""}`).join("\n") + "\n";
    downloadFile("tracks.txt", txt, "text/plain;charset=utf-8");
    document.getElementById("support").hidden = false;
  };

  // TSV
  document.getElementById("exportTsv").onclick = async () => {
    const tab = await activeTab(); if (!tab) return;
    const st = await bgState(tab.id);
    const tracks = Array.isArray(st?.tracks) ? st.tracks : [];
    const header = "artist\ttitle\turl\n";
    const body = tracks.map(t => `${t.artist || ""}\t${t.title || ""}\t${t.url || ""}`).join("\n") + "\n";
    const data = "\ufeff" + header + body; // BOM для Excel/Numbers
    downloadFile("tracks_with_links.tsv", data, "text/tab-separated-values;charset=utf-8");
    document.getElementById("support").hidden = false;
  };

  // слушаем обновления
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "yam_progress_broadcast") refresh();
    if (msg?.type === "yam_tracks") render(msg.tracks || []);
  });

  if (havePerms) refresh();
});