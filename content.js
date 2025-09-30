// ===== YAM content: умный поиск списка треков, сбор, пуш в SW, ответы попапу =====
console.log("[YAM content] boot:", (top===window) ? "TOP" : "IFRAME", location.href);

const YAM = { started:false, seen:new Set(), tracks:[], activeContainer:null, lastScore:0 };

// ---------- утилиты ----------
const norm = s => (s??"").toString().trim().replace(/\s+/g," ");
function safeUrl(href){ try { return new URL(href, location.origin).href; } catch { return ""; } }

// ---------- SMART детектор контейнера списка ----------
const SMART = (() => {
  const HREF_TRACK_RE = /\/(album|track|artist)\//i;
  const DURATION_RE = /\b[0-5]?\d:[0-5]\d\b/;
  const MAX_CHILD_CHECK = 100;
  const MIN_ROWS_FOR_ACCEPT = 3;

  function scoreRowCandidate(node){
    let score = 0;
    try {
      const txt = node.textContent || "";
      if (!txt || txt.length < 3) return 0;
      const cls = (node.className||"").toString();

      if (/(title|Meta_title|track-name|тре[кк])|_title__/i.test(cls)) score += 2;
      if (node.querySelector?.("[class*='title'],[data-qa*='track']")) score += 2;

      if (/(artist|Meta_artist|author|performer)/i.test(cls)) score += 2;
      if (node.querySelector?.("a[href*='/artist/']")) score += 2;

      if (DURATION_RE.test(txt)) score += 1;

      if (node.querySelector?.("button[aria-label*='Воспроизведение'], svg use[href*='play']")) score += 1;

      const a = node.querySelector?.("a[href]");
      if (a && HREF_TRACK_RE.test(a.getAttribute("href")||"")) score += 2;

      if (node.querySelector?.("img")) score += 1;

      if (node.getAttribute && /Трек/i.test(node.getAttribute("aria-label")||"")) score += 2;

      if (norm(txt).length > 10) score += 0.5;
    } catch {}
    return score;
  }

  function gatherContainers(){
    const s = new Set();
    const hints = ['virtuoso','virtual','PlaylistPage','Playlist','list','tracks','tracklist','items','container','content','cards','grid'];
    hints.forEach(h=>{
      document.querySelectorAll(`div[class*="${h}"],section[class*="${h}"],ul[class*="${h}"]`).forEach(n=>s.add(n));
    });
    document.querySelectorAll("[data-test-id],[data-qa]").forEach(n=>s.add(n));
    document.querySelectorAll("main,section,div").forEach(n=>{ if (n.children?.length>3) s.add(n); });
    return Array.from(s);
  }

  function scoreContainer(container){
    const direct = Array.from(container.children||[]).slice(0, MAX_CHILD_CHECK);
    if (!direct.length) return {score:0,rowsCount:0,rows:[]};

    const rows = [];
    for (const nd of direct){
      rows.push(nd);
      if (nd.children && nd.children.length>0){
        for (const c of Array.from(nd.children).slice(0,3)) rows.push(c);
      }
    }
    let total = 0, matched = 0;
    const parsedRows = [];
    const limit = Math.min(rows.length, MAX_CHILD_CHECK);
    for (let i=0;i<limit;i++){
      const r = rows[i];
      const s = scoreRowCandidate(r);
      total += s;
      if (s > 2.5){ matched++; parsedRows.push(r); }
    }
    const avg = total / Math.max(1, limit);
    const density = matched / Math.max(1, limit);
    const score = avg * (0.6 + 0.8 * density);
    return {score, avg, density, rowsCount: matched, rows: parsedRows};
  }

  function findBestTracksContainer(){
    const cand = gatherContainers();
    const results = [];
    for (const c of cand){
      const r = scoreContainer(c);
      if (r.rowsCount >= MIN_ROWS_FOR_ACCEPT || r.score > 1.5) results.push({ el:c, ...r });
    }
    if (!results.length) return null;
    results.sort((a,b)=>b.score - a.score);
    return results[0];
  }

  // --- извлечение треков из найденного контейнера (жестко берем из карточки) ---
  function closestCard(node) {
    return node.closest("[class*='CommonTrack_'],[class*='HorizontalCardContainer_'],[class*='TrackPlaylist_'],.d-track,[data-qa='track']");
  }
  function pickText(root, selList) {
    for (const sel of selList) {
      const el = root.querySelector(sel);
      if (el) {
        const t = (el.textContent || "").trim().replace(/\s+/g, " ");
        if (t) return t;
      }
    }
    return "";
  }
  function extractTracksFromContainer(container){
    const out = [];
    const nodes = container.querySelectorAll("div[data-index],[data-qa='track'],[role='listitem'],.d-track,li,div");
    for (const n of nodes){
      const card = closestCard(n) || n;

      let title = pickText(card, [
        "[class*='Meta_title__']",
        "a[href*='/track/'] [class*='Meta_text__']",
        "[data-qa='track-name']",
        ".d-track__name",
        "a[href*='/track/']"
      ]);

      let artist = pickText(card, [
        "[class*='Meta_artists__']",
        "[class*='SeparatedArtists_root']",
        "[data-qa='track-author']",
        ".d-track__artists",
        "a[href*='/artist/']"
      ]);

      if ((!title || !artist) && card.hasAttribute("aria-label")){
        const al = (card.getAttribute("aria-label")||"").trim();
        if (!title) {
          const m = al.match(/Трек\s+(.+?)\s*$/i);
          if (m) title = m[1].trim();
        }
        if (!artist && /—/.test(al)) {
          const [aPart] = al.split("—");
          if (aPart) artist = aPart.trim();
        }
      }

      let url = "";
      const link = card.querySelector("a[href*='/album/'][href*='/track/'], a[href^='/track/'], a[href^='/album/']");
      if (link) url = safeUrl(link.getAttribute("href"));

      // отбрасываем полупустые варианты
      if (!title) continue;
      if (!artist || artist === "—" || /^—\s*/.test(title)) continue;

      out.push({ artist, title, url, node: card });
    }
    return out;
  }

  return { findBestTracksContainer, extractTracksFromContainer };
})();

// ---------- сбор / наблюдение ----------
function pushTracksIfAdded(tracks, label="scan"){
  let added = 0;
  for (const t of tracks){
    const artist = (t.artist||"").trim();
    const title  = (t.title||"").trim();
    if (!artist || !title) continue;
    if (artist === "—" || /^—\s*/.test(title)) continue;

    const key = `${artist} — ${title}`;
    if (!YAM.seen.has(key)){
      YAM.seen.add(key);
      YAM.tracks.push({ artist, title, url: t.url||"" });
      added++;
    }
  }
  if (added){
    chrome.runtime.sendMessage({ type:"yam_tracks", tracks: YAM.tracks }).catch(()=>{});
    console.log("[YAM content]", label, "added", added, "total", YAM.tracks.length);
  }
}

function rescanActiveContainer(reason="rescan"){
  if (YAM.activeContainer){
    const rows = SMART.extractTracksFromContainer(YAM.activeContainer);
    const tracks = rows.map(r=>({ artist:r.artist, title:r.title, url:safeUrl(r.node.querySelector("a[href]")?.getAttribute("href")||"") }));
    pushTracksIfAdded(tracks, reason);
  } else {
    const rows = SMART.extractTracksFromContainer(document);
    const tracks = rows.map(r=>({ artist:r.artist, title:r.title, url:safeUrl(r.node.querySelector("a[href]")?.getAttribute("href")||"") }));
    pushTracksIfAdded(tracks, reason+"-fallback");
  }
}

function reselectContainerIfNeeded(trigger="auto"){
  const best = SMART.findBestTracksContainer();
  if (best && (best.score > YAM.lastScore*1.05 || !YAM.activeContainer)){
    YAM.activeContainer = best.el;
    YAM.lastScore = best.score;
    console.log("[YAM smart] selected container: score=", best.score, "rows≈", best.rowsCount);
    rescanActiveContainer("select");
  }
}

function startWatch(){
  if (YAM.started) return; YAM.started = true;

  reselectContainerIfNeeded("boot");
  rescanActiveContainer("bootstrap");

  let lastReselect = 0;
  const mo = new MutationObserver(() => {
    const now = performance.now();
    if (now - lastReselect > 800){ reselectContainerIfNeeded("mutation"); lastReselect = now; }
    rescanActiveContainer("mutation");
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });

  const tick = setInterval(()=>{ reselectContainerIfNeeded("tick"); rescanActiveContainer("tick"); }, 1500);

  let last = location.pathname + location.search;
  const spa = setInterval(()=>{
    const cur = location.pathname + location.search;
    if (cur !== last) {
      last = cur;
      YAM.seen.clear(); YAM.tracks = []; YAM.activeContainer = null; YAM.lastScore = 0;
      chrome.runtime.sendMessage({ type:"yam_tracks", tracks:[] }).catch(()=>{});
      reselectContainerIfNeeded("spa");
      rescanActiveContainer("spa");
    }
  }, 600);

  window.addEventListener("beforeunload", ()=>{
    mo.disconnect(); clearInterval(tick); clearInterval(spa);
  }, { once:true });
}

// ---------- сообщения ----------
chrome.runtime.onMessage.addListener((msg, _s, sendResponse)=>{
  if (msg?.type==="yam_manual_start"){ startWatch(); rescanActiveContainer("manual"); sendResponse?.({ok:true}); return true; }
  if (msg?.type==="yam_get_tracks"){ sendResponse?.({ok:true, tracks: YAM.tracks}); return true; }
});

startWatch();