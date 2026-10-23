/* 聴 — 取り込んだ音声ファイルを選んで再生する PWA（試作）
 * 曲は IndexedDB に保存する（tracks＝曲の情報 / blobs＝音声そのもの）。
 */
"use strict";

const RESUME_MIN_SEC = 600;   // これより長い曲だけ続きから再生する
const RESUME_BACK_SEC = 3;    // 再開するとき少し戻す
const SAVE_EVERY_MS = 5000;   // 再生中に位置を保存する間隔
const RATE_MIN = 0.5, RATE_MAX = 3;
const ALL = "*";              // グループの絞り込み「すべて」（未分類は空文字）

const $ = sel => document.querySelector(sel);
const audio = $("#audio");
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/* ---------- 設定（端末内の小さな記録） ---------- */
const settings = (() => {
  const KEY = "kiku-settings";
  let s = { rate: 1, sortKey: "name", sortDir: "asc", autoNext: false, group: ALL };
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
  s.save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  return s;
})();

/* ---------- IndexedDB ---------- */
const db = (() => {
  let conn = null;
  const done = r => new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
  const finished = tx => new Promise((ok, ng) => {
    tx.oncomplete = () => ok();
    tx.onerror = tx.onabort = () => ng(tx.error);
  });
  async function open() {
    if (conn) return conn;
    const r = indexedDB.open("kiku", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("tracks", { keyPath: "id" });
      r.result.createObjectStore("blobs");
    };
    conn = await done(r);
    return conn;
  }
  async function store(names, mode) {
    return (await open()).transaction(names, mode);
  }
  return {
    async allTracks() { return done((await store("tracks", "readonly")).objectStore("tracks").getAll()); },
    async getBlob(id) { return done((await store("blobs", "readonly")).objectStore("blobs").get(id)); },
    async putMeta(meta) {
      const tx = await store("tracks", "readwrite");
      tx.objectStore("tracks").put(meta);
      return finished(tx);
    },
    async add(meta, blob) {
      const tx = await store(["tracks", "blobs"], "readwrite");
      tx.objectStore("blobs").put(blob, meta.id);
      tx.objectStore("tracks").put(meta);
      return finished(tx);
    },
    async remove(id) {
      const tx = await store(["tracks", "blobs"], "readwrite");
      tx.objectStore("blobs").delete(id);
      tx.objectStore("tracks").delete(id);
      return finished(tx);
    },
  };
})();

/* ---------- 表示用の小道具 ---------- */
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + "MB";
  return Math.max(1, Math.round(bytes / 1e3)) + "KB";
}
function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
const baseName = name => name.replace(/\.[^.]+$/, "");

let msgTimer = 0;
function showMsg(text, keep = false) {
  const el = $("#msg");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  if (!keep) msgTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---------- 曲の一覧 ---------- */
let tracks = [];
let currentId = null;

const SORTS = {
  name: (a, b) => collator.compare(a.name, b.name),
  imported: (a, b) => a.importedAt - b.importedAt,
  modified: (a, b) => a.lastModified - b.lastModified,
  duration: (a, b) => a.duration - b.duration,
};
const groupOf = t => t.group || "";

/* 一覧に出す曲（グループで絞って並べ替えたもの）。「次へ」もこの順に進む */
function sortedTracks() {
  const cmp = SORTS[settings.sortKey] || SORTS.name;
  const dir = settings.sortDir === "desc" ? -1 : 1;
  const shown = settings.group === ALL ? tracks : tracks.filter(t => groupOf(t) === settings.group);
  return [...shown].sort((a, b) => dir * cmp(a, b) || collator.compare(a.name, b.name));
}
const findTrack = id => tracks.find(t => t.id === id);
const isResumable = t => t && t.duration >= RESUME_MIN_SEC;

function renderGroups() {
  const names = [...new Set(tracks.map(groupOf).filter(Boolean))].sort(collator.compare);
  const hasNone = tracks.some(t => !groupOf(t));
  if (settings.group !== ALL && !names.includes(settings.group) && !(settings.group === "" && hasNone)) {
    settings.group = ALL;
    settings.save();
  }
  const opts = [[ALL, "すべて"], ...names.map(n => [n, n])];
  if (hasNone && names.length) opts.push(["", "未分類"]);
  const sel = $("#group");
  sel.replaceChildren(...opts.map(([value, label]) => new Option(label, value)));
  sel.value = settings.group;
  sel.hidden = names.length === 0;
}

function metaLine(t) {
  const parts = [t.duration ? fmtTime(t.duration) : "長さ不明", fmtSize(t.size)];
  if (settings.group === ALL && groupOf(t)) parts.push(groupOf(t));
  if (settings.sortKey === "imported") parts.push("取込 " + fmtDate(t.importedAt));
  if (settings.sortKey === "modified") parts.push("日付 " + fmtDate(t.lastModified));
  if (isResumable(t) && t.position > 0) parts.push("続き " + fmtTime(t.position));
  return parts.join(" · ");
}

function renderList() {
  const ul = $("#list");
  ul.replaceChildren();
  for (const t of sortedTracks()) {
    const li = document.createElement("li");
    li.classList.toggle("now", t.id === currentId);
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = baseName(t.name);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = metaLine(t);
    info.append(name, meta);
    const more = document.createElement("button");
    more.className = "del";
    more.type = "button";
    more.textContent = "…";
    more.setAttribute("aria-label", "操作");
    more.addEventListener("click", e => { e.stopPropagation(); openSheet(t); });
    li.append(info, more);
    li.addEventListener("click", () => playTrack(t.id));
    ul.append(li);
  }
  $("#empty").hidden = tracks.length > 0;
  $("#sortKey").value = settings.sortKey;
  $("#sortDir").textContent = settings.sortDir === "desc" ? "降順" : "昇順";
}

/* 曲の「…」: グループを変える／削除 */
function openSheet(t) {
  const sheet = $("#sheet");
  $("#sheetTitle").textContent = baseName(t.name);
  sheet.returnValue = "";
  sheet.addEventListener("close", () => {
    if (sheet.returnValue === "group") changeGroup(t);
    if (sheet.returnValue === "delete") deleteTrack(t);
  }, { once: true });
  sheet.showModal();
}

function askGroup(current) {
  const g = prompt("グループ名（空欄なら未分類）", current);
  return g === null ? null : g.trim();
}

async function changeGroup(t) {
  const g = askGroup(groupOf(t));
  if (g === null || g === groupOf(t)) return;
  t.group = g;
  await db.putMeta(t);
  refreshList();
}

async function deleteTrack(t) {
  if (!confirm(`「${baseName(t.name)}」をアプリから削除します。\n（Dropbox などの元のファイルは残ります）`)) return;
  if (t.id === currentId) stopPlayback();
  await db.remove(t.id);
  tracks = tracks.filter(x => x.id !== t.id);
  refreshList();
  showStorage();
}

/* 曲の集まりや絞り込みが変わったとき */
function refreshList() {
  renderGroups();
  renderList();
  preloadNext();
}

/* ---------- 取り込み ---------- */
function readDuration(blob) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = d => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      a.removeAttribute("src");
      resolve(isFinite(d) && d > 0 ? d : 0);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 15000);
    a.src = url;
  });
}

async function importFiles(files) {
  const list = [...files];
  // 「すべて」表示中ならグループ名を聞く。絞り込み中はそのグループに入れる
  const group = settings.group === ALL ? askGroup("") : settings.group;
  if (group === null) return;
  let added = 0, skipped = 0;
  for (const [i, f] of list.entries()) {
    if (tracks.some(t => t.name === f.name && t.size === f.size)) { skipped++; continue; }
    showMsg(`取り込み中 ${i + 1}/${list.length}: ${f.name}`, true);
    const meta = {
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      type: f.type,
      lastModified: f.lastModified || 0,
      importedAt: Date.now(),
      duration: await readDuration(f),
      position: 0,
      group,
    };
    try {
      await db.add(meta, f);
    } catch (err) {
      showMsg(`保存できませんでした（容量不足かもしれません）: ${f.name} / ${err && err.name}`, true);
      break;
    }
    tracks.push(meta);
    added++;
    renderList();
  }
  showMsg(`${added}曲を取り込みました` + (skipped ? `（同じ曲 ${skipped} 件は飛ばしました）` : ""));
  refreshList();
  showStorage();
}

/* ---------- 再生 ---------- */
let curUrl = null;
let pendingStart = false;   // 続きの位置へ移る前は位置を保存しない
let lastSave = 0;
let next = { id: null, url: null };
let preloadSeq = 0;

function applyRate() {
  audio.defaultPlaybackRate = settings.rate;
  audio.playbackRate = settings.rate;
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
  $("#rate").value = settings.rate;
  $("#rateVal").textContent = settings.rate.toFixed(2) + "×";
  for (const b of document.querySelectorAll("[data-rate]")) {
    b.classList.toggle("on", Number(b.dataset.rate) === settings.rate);
  }
  updatePositionState();
}
function setRate(r) {
  settings.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(r * 100) / 100));
  settings.save();
  applyRate();
}

function savePosition(force = false) {
  const t = findTrack(currentId);
  if (!isResumable(t) || pendingStart || audio.readyState < 1) return;
  const now = Date.now();
  if (!force && now - lastSave < SAVE_EVERY_MS) return;
  lastSave = now;
  t.position = audio.ended ? 0 : audio.currentTime;
  db.putMeta(t).catch(() => {});
}

function startPosition(t) {
  if (!isResumable(t) || !t.position || t.position > t.duration - 5) return 0;
  return Math.max(0, t.position - RESUME_BACK_SEC);
}

function releaseNext() {
  if (next.url) URL.revokeObjectURL(next.url);
  next = { id: null, url: null };
}

/* 画面を消したまま次の曲へ進めるよう、次の曲を先に読み込んでおく */
async function preloadNext() {
  const seq = ++preloadSeq;
  const n = settings.autoNext ? neighbor(1) : null;
  if (!n) { releaseNext(); return; }
  if (next.id === n.id) return;
  const blob = await db.getBlob(n.id);
  if (seq !== preloadSeq || !blob) return;
  releaseNext();
  next = { id: n.id, url: URL.createObjectURL(blob) };
}

function neighbor(step) {
  const list = sortedTracks();
  const i = list.findIndex(t => t.id === currentId);
  return i < 0 ? null : list[i + step] || null;
}

/* 次の曲を読み込み済みなら await を通らずに play() まで進む（iOS の制約対策） */
async function playTrack(id) {
  const t = findTrack(id);
  if (!t) return;
  savePosition(true);
  let url;
  if (next.id === id) {
    url = next.url;
    next = { id: null, url: null };
  } else {
    const blob = await db.getBlob(id);
    if (!blob) { showMsg("曲のデータが見つかりません"); return; }
    url = URL.createObjectURL(blob);
  }
  const old = curUrl;
  curUrl = url;
  currentId = id;
  clearAB();
  const start = startPosition(t);
  pendingStart = start > 0;
  audio.src = url;
  if (old) URL.revokeObjectURL(old);
  applyRate();
  if (pendingStart) {
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = start;
      pendingStart = false;
    }, { once: true });
  }
  setMetadata(t);
  renderNow(t);
  renderList();
  audio.play().catch(err => showMsg("再生できませんでした: " + (err && err.name)));
}

function stopPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = null;
  currentId = null;
  renderNow(null);
}

function skip(sec) {
  if (!curUrl) return;
  const d = isFinite(audio.duration) ? audio.duration : Infinity;
  audio.currentTime = Math.min(d, Math.max(0, audio.currentTime + sec));
  updatePositionState();
}

/* ---------- 区間リピート ---------- */
let ab = { a: null, b: null };

function setA() {
  if (!curUrl) return;
  ab.a = audio.currentTime;
  if (ab.b !== null && ab.b <= ab.a) ab.b = null;
  renderAB();
}
function setB() {
  if (!curUrl) return;
  if (ab.a === null) { showMsg("先に A を押してください"); return; }
  if (audio.currentTime <= ab.a + 0.5) { showMsg("B は A より後の位置で押してください"); return; }
  ab.b = audio.currentTime;
  audio.currentTime = ab.a;
  renderAB();
}
function clearAB() {
  ab = { a: null, b: null };
  renderAB();
}
/* B を過ぎたら A へ戻す。戻したら true */
function loopAB() {
  if (ab.b === null || audio.currentTime < ab.b) return false;
  audio.currentTime = ab.a;
  return true;
}
function renderAB() {
  $("#abA").classList.toggle("on", ab.a !== null);
  $("#abB").classList.toggle("on", ab.b !== null);
  $("#abText").textContent = ab.a === null ? ""
    : `A ${fmtTime(ab.a)} – ` + (ab.b === null ? "" : `B ${fmtTime(ab.b)}`);
}

function renderNow(t) {
  $("#nowTitle").textContent = t ? baseName(t.name) : "（未選択）";
  if (!t) { $("#seek").max = 0; $("#tCur").textContent = $("#tDur").textContent = "0:00"; }
}

function renderTime() {
  if (seekDragging) return;
  const d = isFinite(audio.duration) ? audio.duration : 0;
  $("#seek").max = d;
  $("#seek").value = audio.currentTime;
  $("#tCur").textContent = fmtTime(audio.currentTime);
  $("#tDur").textContent = fmtTime(d);
}

/* ---------- ロック画面・イヤホン ---------- */
function setMetadata(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: baseName(t.name),
    artist: "聴",
    artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
  });
}
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      position: Math.min(d, audio.currentTime),
      playbackRate: audio.playbackRate || 1,
    });
  } catch {}
}
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    seekbackward: d => skip(-(d.seekOffset || 10)),
    seekforward: d => skip(d.seekOffset || 30),
    seekto: d => { audio.currentTime = d.seekTime; updatePositionState(); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

/* ---------- 容量・確認用 ---------- */
let persisted = "未確認";
async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  $("#storage").textContent = `使用 ${fmtSize(usage)} / 空き ${fmtSize(Math.max(0, quota - usage))}`;
  renderDiag(usage, quota);
}
function renderDiag(usage, quota) {
  const sameAsImport = tracks.filter(t => Math.abs(t.lastModified - t.importedAt) < 120000).length;
  $("#diag").textContent = [
    `ホーム画面から起動: ${navigator.standalone === true ? "はい" : "いいえ（Safari）"}`,
    `保存の固定(persist): ${persisted}`,
    `容量: 使用 ${fmtSize(usage)} / 上限 ${fmtSize(quota)}`,
    `曲数: ${tracks.length}（長さ不明 ${tracks.filter(t => !t.duration).length}）`,
    `ファイルの日付＝取り込んだ時刻の曲: ${sameAsImport}/${tracks.length}`,
    `声の高さ保持: ${"preservesPitch" in audio ? "preservesPitch" : ("webkitPreservesPitch" in audio ? "webkitPreservesPitch" : "なし")}`,
    `MediaSession: ${"mediaSession" in navigator ? "あり" : "なし"}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");
}

/* ---------- イベント ---------- */
let seekDragging = false;

function bindEvents() {
  $("#picker").addEventListener("change", e => {
    const files = e.target.files;
    if (files && files.length) importFiles(files).finally(() => { e.target.value = ""; });
  });
  const changeSetting = (key, value) => { settings[key] = value; settings.save(); refreshList(); };
  $("#group").addEventListener("change", e => changeSetting("group", e.target.value));
  $("#sortKey").addEventListener("change", e => changeSetting("sortKey", e.target.value));
  $("#sortDir").addEventListener("click", () => changeSetting("sortDir", settings.sortDir === "desc" ? "asc" : "desc"));
  $("#autoNext").checked = settings.autoNext;
  $("#autoNext").addEventListener("change", e => {
    settings.autoNext = e.target.checked; settings.save(); preloadNext();
  });

  $("#playBtn").addEventListener("click", () => {
    if (!curUrl) { const first = sortedTracks()[0]; if (first) playTrack(first.id); return; }
    audio.paused ? audio.play() : audio.pause();
  });
  for (const b of document.querySelectorAll("[data-skip]")) {
    b.addEventListener("click", () => skip(Number(b.dataset.skip)));
  }
  for (const b of document.querySelectorAll("[data-rate]")) {
    b.addEventListener("click", () => setRate(Number(b.dataset.rate)));
  }
  $("#rate").addEventListener("input", e => setRate(Number(e.target.value)));
  $("#abA").addEventListener("click", setA);
  $("#abB").addEventListener("click", setB);
  $("#abClear").addEventListener("click", clearAB);

  // 一覧の最後が再生欄に隠れないよう、下の余白を再生欄の高さに合わせる
  const player = $(".player");
  new ResizeObserver(() => {
    document.body.style.paddingBottom = player.offsetHeight + 16 + "px";
  }).observe(player);

  const seek = $("#seek");
  seek.addEventListener("input", () => { seekDragging = true; $("#tCur").textContent = fmtTime(Number(seek.value)); });
  seek.addEventListener("change", () => {
    seekDragging = false;
    if (curUrl) { audio.currentTime = Number(seek.value); updatePositionState(); }
  });

  audio.addEventListener("loadedmetadata", () => {
    const t = findTrack(currentId);
    if (t && !t.duration && isFinite(audio.duration)) { t.duration = audio.duration; db.putMeta(t).catch(() => {}); }
    applyRate();
    renderTime();
  });
  audio.addEventListener("play", () => { $("#playBtn").textContent = "❚❚"; applyRate(); });
  audio.addEventListener("playing", () => { updatePositionState(); preloadNext(); });
  audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; savePosition(true); renderList(); });
  audio.addEventListener("timeupdate", () => { loopAB(); renderTime(); savePosition(); });
  audio.addEventListener("ended", () => {
    if (loopAB()) { audio.play(); return; }   // B が曲の終わりにある区間リピート
    const n = settings.autoNext ? neighbor(1) : null;
    if (n) playTrack(n.id);
    else renderList();
  });

  const flush = () => savePosition(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}

/* ---------- 起動 ---------- */
async function init() {
  bindEvents();
  setupMediaSession();
  applyRate();
  tracks = await db.allTracks();
  renderGroups();
  renderList();
  if (navigator.storage && navigator.storage.persist) {
    try { persisted = (await navigator.storage.persist()) ? "はい" : "いいえ"; } catch { persisted = "失敗"; }
  }
  showStorage();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
