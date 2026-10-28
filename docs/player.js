/* 聴 — iPhone 版（index.html）と PC 版（pc/index.html）が共通で使う部品
 * ・表示用の小道具（時間・大きさ・日付・メッセージ）
 * ・再生欄（速度・シーク・±秒・区間リピート・次へ・続きから再生・ロック画面／メディアキー・キーボード）
 * 曲の置き場所（取り込んだ Blob か PC のファイルか）は createPlayer に渡す loadUrl が隠す。
 */
"use strict";

const RESUME_MIN_SEC = 600;   // これより長い曲だけ続きから再生する
const RESUME_BACK_SEC = 3;    // 再開するとき少し戻す
const SAVE_EVERY_MS = 5000;   // 再生中に位置を保存する間隔
const RATE_MIN = 0.5, RATE_MAX = 3, RATE_STEP = 0.05;

const $ = sel => document.querySelector(sel);
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/* ---------- 設定（端末内の小さな記録） ---------- */
function loadSettings(key, defaults) {
  const s = { rate: 1, sortKey: "name", sortDir: "asc", autoNext: false, ...defaults };
  try { Object.assign(s, JSON.parse(localStorage.getItem(key) || "{}")); } catch {}
  s.save = () => { try { localStorage.setItem(key, JSON.stringify(s)); } catch {} };
  return s;
}

/* ---------- IndexedDB の小道具 ---------- */
const idbDone = r => new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
const idbFinished = tx => new Promise((ok, ng) => {
  tx.oncomplete = () => ok();
  tx.onerror = tx.onabort = () => ng(tx.error);
});

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
const isResumable = t => !!t && t.duration >= RESUME_MIN_SEC;

let msgTimer = 0;
function showMsg(text, keep = false) {
  const el = $("#msg");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  if (!keep) msgTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* 音声の長さ（秒）を読む。読めなければ 0 */
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

/* 曲の一覧の1行。onMore を渡すと右端に「…」ボタンを付ける */
function trackRow(t, { now, meta, check, onClick, onMore }) {
  const li = document.createElement("li");
  li.classList.toggle("now", now);
  if (check !== undefined) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "check";
    box.checked = check;
    box.tabIndex = -1;
    li.append(box);
  }
  const info = document.createElement("div");
  info.className = "info";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = baseName(t.name);
  const sub = document.createElement("div");
  sub.className = "meta";
  sub.textContent = meta;
  info.append(name, sub);
  li.append(info);
  if (onMore) {
    const more = document.createElement("button");
    more.className = "del";
    more.type = "button";
    more.textContent = "…";
    more.setAttribute("aria-label", "操作");
    more.addEventListener("click", e => { e.stopPropagation(); onMore(); });
    li.append(more);
  }
  li.addEventListener("click", onClick);
  return li;
}

/* ---------- 再生欄 ---------- */
const PLAYER_HTML = `
<div class="player-inner">
  <div id="nowTitle" class="now">（未選択）</div>
  <div class="seek">
    <span id="tCur">0:00</span>
    <input id="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="再生位置">
    <span id="tDur">0:00</span>
  </div>
  <div class="controls">
    <button class="btn" data-skip="-30" type="button">-30</button>
    <button class="btn" data-skip="-10" type="button">-10</button>
    <button id="playBtn" class="btn play" type="button" aria-label="再生">▶</button>
    <button class="btn" data-skip="10" type="button">+10</button>
    <button class="btn" data-skip="30" type="button">+30</button>
  </div>
  <div class="speed">
    <span id="rateVal" class="rate">1.00×</span>
    <input id="rate" type="range" min="${RATE_MIN}" max="${RATE_MAX}" step="${RATE_STEP}" value="1" aria-label="速度">
  </div>
  <div class="presets">
    <button class="btn" data-rate="0.8" type="button">0.8</button>
    <button class="btn" data-rate="1" type="button">1.0</button>
    <button class="btn" data-rate="1.25" type="button">1.25</button>
    <button class="btn" data-rate="1.5" type="button">1.5</button>
    <button class="btn" data-rate="2" type="button">2.0</button>
    <label class="auto"><input id="autoNext" type="checkbox"> 次へ</label>
  </div>
  <div class="ab">
    <button id="abA" class="btn" type="button">A</button>
    <button id="abB" class="btn" type="button">B</button>
    <button id="abClear" class="btn" type="button">解除</button>
    <span id="abText" class="muted"></span>
  </div>
  <audio id="audio" preload="auto"></audio>
</div>`;

/* h（アプリ側が渡すもの）:
 *   settings      … rate・autoNext を持つ設定（save() つき）
 *   findTrack(id) / sortedTracks() … 曲を探す・いま一覧に出ている順
 *   loadUrl(t)    … 曲を再生できる object URL にする（失敗なら例外か null）
 *   saveMeta(t)   … 長さ・続きの位置が変わった曲を保存する
 *   onChange()    … 一覧を描き直す
 *   artwork       … ロック画面に出す画像
 *   missingMsg    … 曲を読めなかったときの知らせ（省略可）
 */
function createPlayer(h) {
  const footer = document.createElement("footer");
  footer.className = "player";
  footer.innerHTML = PLAYER_HTML;
  document.body.append(footer);
  const audio = $("#audio");

  let curUrl = null;
  let currentId = null;
  let pendingStart = false;   // 続きの位置へ移る前は位置を保存しない
  let lastSave = 0;
  let next = { id: null, url: null };
  let preloadSeq = 0;
  let seekDragging = false;
  let ab = { a: null, b: null };

  /* --- 速度 --- */
  function applyRate() {
    audio.defaultPlaybackRate = h.settings.rate;
    audio.playbackRate = h.settings.rate;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    $("#rate").value = h.settings.rate;
    $("#rateVal").textContent = h.settings.rate.toFixed(2) + "×";
    for (const b of document.querySelectorAll("[data-rate]")) {
      b.classList.toggle("on", Number(b.dataset.rate) === h.settings.rate);
    }
    updatePositionState();
  }
  function setRate(r) {
    h.settings.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(r * 100) / 100));
    h.settings.save();
    applyRate();
  }

  /* --- 続きから再生 --- */
  function savePosition(force = false) {
    const t = h.findTrack(currentId);
    if (!isResumable(t) || pendingStart || audio.readyState < 1) return;
    const now = Date.now();
    if (!force && now - lastSave < SAVE_EVERY_MS) return;
    lastSave = now;
    t.position = audio.ended ? 0 : audio.currentTime;
    Promise.resolve(h.saveMeta(t)).catch(() => {});
  }
  function startPosition(t) {
    if (!isResumable(t) || !t.position || t.position > t.duration - 5) return 0;
    return Math.max(0, t.position - RESUME_BACK_SEC);
  }

  /* --- 次の曲 --- */
  function neighbor(step) {
    const list = h.sortedTracks();
    const i = list.findIndex(t => t.id === currentId);
    return i < 0 ? null : list[i + step] || null;
  }
  function releaseNext() {
    if (next.url) URL.revokeObjectURL(next.url);
    next = { id: null, url: null };
  }
  /* 画面を消したまま次の曲へ進めるよう、次の曲を先に読み込んでおく */
  async function preloadNext() {
    const seq = ++preloadSeq;
    const n = h.settings.autoNext ? neighbor(1) : null;
    if (!n) { releaseNext(); return; }
    if (next.id === n.id) return;
    let url = null;
    try { url = await h.loadUrl(n); } catch {}
    if (!url) return;
    if (seq !== preloadSeq) { URL.revokeObjectURL(url); return; }
    releaseNext();
    next = { id: n.id, url };
  }

  /* --- 再生・停止 --- */
  /* 次の曲を読み込み済みなら await を通らずに play() まで進む（iOS の制約対策） */
  async function play(id) {
    const t = h.findTrack(id);
    if (!t) return;
    savePosition(true);
    let url;
    if (next.id === id) {
      url = next.url;
      next = { id: null, url: null };
    } else {
      try { url = await h.loadUrl(t); } catch {}
      if (!url) { showMsg(h.missingMsg || "曲のデータが見つかりません"); return; }
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
    h.onChange();
    audio.play().catch(err => showMsg("再生できませんでした: " + (err && err.name)));
  }
  function stop() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (curUrl) URL.revokeObjectURL(curUrl);
    curUrl = null;
    currentId = null;
    clearAB();
    renderNow(null);
  }
  function togglePlay() {
    if (!curUrl) { const first = h.sortedTracks()[0]; if (first) play(first.id); return; }
    audio.paused ? audio.play() : audio.pause();
  }
  function skip(sec) {
    if (!curUrl) return;
    const d = isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(d, Math.max(0, audio.currentTime + sec));
    updatePositionState();
  }

  /* --- 区間リピート --- */
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

  /* --- 表示 --- */
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

  /* --- ロック画面・イヤホン・メディアキー --- */
  function setMetadata(t) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: baseName(t.name),
      artist: "聴",
      artwork: [{ src: h.artwork, sizes: "512x512", type: "image/png" }],
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

  /* --- キーボード（PC 用。入力欄にいるときは効かない） --- */
  const KEYS = {
    " ": () => togglePlay(),
    ArrowLeft: e => skip(e.shiftKey ? -30 : -10),
    ArrowRight: e => skip(e.shiftKey ? 30 : 10),
    ArrowUp: () => setRate(h.settings.rate + RATE_STEP),
    ArrowDown: () => setRate(h.settings.rate - RATE_STEP),
    a: () => setA(),
    b: () => setB(),
    Escape: () => clearAB(),
  };
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input:not([type=range]), select, textarea, dialog")) return;
    const fn = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!fn) return;
    e.preventDefault();
    fn(e);
  }

  /* --- つなぐ --- */
  $("#autoNext").checked = h.settings.autoNext;
  $("#autoNext").addEventListener("change", e => {
    h.settings.autoNext = e.target.checked; h.settings.save(); preloadNext();
  });
  $("#playBtn").addEventListener("click", togglePlay);
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
  document.addEventListener("keydown", onKey);

  // 一覧の最後が再生欄に隠れないよう、下の余白を再生欄の高さに合わせる
  new ResizeObserver(() => {
    document.body.style.paddingBottom = footer.offsetHeight + 16 + "px";
  }).observe(footer);

  const seek = $("#seek");
  seek.addEventListener("input", () => { seekDragging = true; $("#tCur").textContent = fmtTime(Number(seek.value)); });
  seek.addEventListener("change", () => {
    seekDragging = false;
    if (curUrl) { audio.currentTime = Number(seek.value); updatePositionState(); }
  });

  audio.addEventListener("loadedmetadata", () => {
    const t = h.findTrack(currentId);
    if (t && !t.duration && isFinite(audio.duration)) {
      t.duration = audio.duration;
      Promise.resolve(h.saveMeta(t)).catch(() => {});
    }
    applyRate();
    renderTime();
  });
  audio.addEventListener("play", () => { $("#playBtn").textContent = "❚❚"; applyRate(); });
  audio.addEventListener("playing", () => { updatePositionState(); preloadNext(); });
  audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; savePosition(true); h.onChange(); });
  audio.addEventListener("timeupdate", () => { loopAB(); renderTime(); savePosition(); });
  audio.addEventListener("ended", () => {
    if (loopAB()) { audio.play(); return; }   // B が曲の終わりにある区間リピート
    const n = h.settings.autoNext ? neighbor(1) : null;
    if (n) play(n.id);
    else h.onChange();
  });

  const flush = () => savePosition(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);

  setupMediaSession();
  applyRate();

  return {
    audio,
    play,
    stop,
    preloadNext,
    get currentId() { return currentId; },
  };
}
