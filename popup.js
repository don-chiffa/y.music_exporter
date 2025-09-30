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
        refresh();
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