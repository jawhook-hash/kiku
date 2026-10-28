/* 聴 PC 版 — 登録したフォルダの音声ファイルを、コピーせずにその場で再生する（Edge・Chrome 用）
 * IndexedDB "kiku-pc": folders＝登録したフォルダ（読む許可の鍵 handle を含む）
 *                      meta＝曲ごとの長さ・続きの位置（キーは「フォルダID/中の道筋/ファイル名」）
 * PC のファイルは読むだけで、書き換え・削除はしない。再生欄は ../player.js（iPhone 版と共通）。
 */
"use strict";

const ALL = "*";   // フォルダの絞り込み「すべて」
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|webm)$/i;   // Edge・Chrome が再生できるもの
const READ = { mode: "read" };

const settings = loadSettings("kiku-pc-settings", { folder: ALL });

/* ---------- IndexedDB ---------- */
const db = (() => {
  let conn = null;
  async function open() {
    if (conn) return conn;
    const r = indexedDB.open("kiku-pc", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("folders", { keyPath: "id" });
      r.result.createObjectStore("meta", { keyPath: "key" });
    };
    conn = await idbDone(r);
    return conn;
  }
  const store = async (name, mode) => (await open()).transaction(name, mode);
  const getAll = async name => idbDone((await store(name, "readonly")).objectStore(name).getAll());
  async function write(name, fn) {
    const tx = await store(name, "readwrite");
    fn(tx.objectStore(name));
    return idbFinished(tx);
  }
  return {
    allFolders: () => getAll("folders"),
    allMeta: () => getAll("meta"),
    putFolder: f => write("folders", s => s.put(f)),
    putMeta: m => write("meta", s => s.put(m)),
    /* フォルダの登録と、その中の曲の記録を消す（PC のファイルには触れない） */
    async forgetFolder(id) {
      await write("folders", s => s.delete(id));
      await write("meta", s => s.delete(IDBKeyRange.bound(id + "/", id + "/￿")));
    },
  };
})();

/* ---------- 曲の一覧 ---------- */
let folders = [];
let tracks = [];
let scanSeq = 0;

const SORTS = {
  name: (a, b) => collator.compare(a.dir + a.name, b.dir + b.name),
  modified: (a, b) => a.lastModified - b.lastModified,
  duration: (a, b) => a.duration - b.duration,
};
const findTrack = id => tracks.find(t => t.id === id);
const folderName = id => (folders.find(f => f.id === id) || {}).name || "";

/* 一覧に出す曲（フォルダで絞って並べ替えたもの）。「次へ」もこの順に進む */
function sortedTracks() {
  const cmp = SORTS[settings.sortKey] || SORTS.name;
  const dir = settings.sortDir === "desc" ? -1 : 1;
  const shown = settings.folder === ALL ? tracks : tracks.filter(t => t.folderId === settings.folder);
  return [...shown].sort((a, b) => dir * cmp(a, b) || collator.compare(a.dir + a.name, b.dir + b.name));
}

function saveMeta(t) {
  return db.putMeta({
    key: t.id, size: t.size, lastModified: t.lastModified, duration: t.duration, position: t.position,
  });
}

const player = createPlayer({
  settings,
  findTrack,
  sortedTracks,
  async loadUrl(t) { return URL.createObjectURL(await t.handle.getFile()); },
  saveMeta,
  onChange: () => renderList(),
  artwork: "../icon-512.png",
  missingMsg: "ファイルを読めませんでした（移動・削除されたかもしれません）。「再読み込み」を押してください",
});

function metaLine(t) {
  const parts = [t.duration ? fmtTime(t.duration) : "長さ…", fmtSize(t.size)];
  const where = [settings.folder === ALL ? folderName(t.folderId) : "", t.dir.replace(/\/$/, "")]
    .filter(Boolean).join("/");
  if (where) parts.push(where);
  if (settings.sortKey === "modified") parts.push("日付 " + fmtDate(t.lastModified));
  if (isResumable(t) && t.position > 0) parts.push("続き " + fmtTime(t.position));
  return parts.join(" · ");
}

function renderFolders() {
  if (settings.folder !== ALL && !folders.some(f => f.id === settings.folder)) {
    settings.folder = ALL;
    settings.save();
  }
  const sel = $("#folder");
  sel.replaceChildren(new Option("すべてのフォルダ", ALL), ...folders.map(f => new Option(f.name, f.id)));
  sel.value = settings.folder;
  sel.hidden = folders.length < 2;
  $("#unregister").hidden = !folders.length || (folders.length > 1 && settings.folder === ALL);
}

function renderList() {
  const shown = sortedTracks();
  $("#list").replaceChildren(...shown.map(t => trackRow(t, {
    now: t.id === player.currentId,
    meta: metaLine(t),
    onClick: () => player.play(t.id),
  })));
  $("#empty").hidden = folders.length > 0;
  $("#count").textContent = folders.length ? `${shown.length}曲` : "";
  $("#sortKey").value = settings.sortKey;
  $("#sortDir").textContent = settings.sortDir === "desc" ? "降順" : "昇順";
  renderDiag();
}

function refreshList() {
  renderFolders();
  renderList();
  player.preloadNext();
}

/* 長さを調べている間は描き直しを間引く */
let renderTimer = 0;
function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderList, 500);
}

/* ---------- フォルダを読む ---------- */
async function isGranted(f, ask) {
  try {
    if ((await f.handle.queryPermission(READ)) === "granted") return true;
    return ask && (await f.handle.requestPermission(READ)) === "granted";
  } catch {
    return false;
  }
}

/* フォルダの中（サブフォルダを含む）の音声ファイル */
async function listAudio(dirHandle, dir = "") {
  const out = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === "directory") out.push(...await listAudio(h, `${dir}${name}/`));
    else if (AUDIO_EXT.test(name)) out.push({ name, dir, handle: h });
  }
  return out;
}

async function scanFolder(f, metas) {
  const list = [];
  for (const e of await listAudio(f.handle)) {
    const file = await e.handle.getFile();
    const id = `${f.id}/${e.dir}${e.name}`;
    const m = metas.get(id);
    // 中身が変わったファイル（大きさか日付が違う）は長さと続きの位置を測り直す
    const same = m && m.size === file.size && m.lastModified === file.lastModified;
    list.push({
      id, name: e.name, dir: e.dir, folderId: f.id, handle: e.handle,
      size: file.size, lastModified: file.lastModified,
      duration: same ? m.duration : 0, position: same ? m.position : 0,
    });
  }
  return list;
}

async function rescan() {
  const seq = ++scanSeq;
  const metas = new Map((await db.allMeta()).map(m => [m.key, m]));
  const list = [];
  const denied = [];
  for (const f of folders) {
    if (!(await isGranted(f, false))) { denied.push(f); continue; }
    showMsg(`「${f.name}」を読んでいます…`, true);
    try {
      list.push(...await scanFolder(f, metas));
    } catch {
      showMsg(`「${f.name}」を読めませんでした（移動・削除されたかもしれません）`, true);
    }
  }
  if (seq !== scanSeq) return;
  tracks = list;
  showPermit(denied);
  refreshList();
  if (folders.length > denied.length) showMsg(`${list.length}曲を見つけました`);
  fillDurations(seq);
}

/* 長さの分からない曲を1曲ずつ調べて覚える */
async function fillDurations(seq) {
  const todo = tracks.filter(t => !t.duration);
  for (const [i, t] of todo.entries()) {
    if (seq !== scanSeq) return;
    $("#count").textContent = `長さを調べています ${i + 1}/${todo.length}`;
    try {
      const d = await readDuration(await t.handle.getFile());
      if (d) {
        t.duration = d;
        await saveMeta(t);
      }
    } catch {}
    renderSoon();
  }
  if (todo.length) renderSoon();
}

/* 起動のたびにブラウザが読む許可を求める（押す操作がないと許可を聞けない） */
function showPermit(denied) {
  $("#permit").hidden = denied.length === 0;
  $("#permitText").textContent = denied.length
    ? `${denied.map(f => `「${f.name}」`).join("")}を読むには許可が要ります。` : "";
}
async function grantAll() {
  for (const f of folders) await isGranted(f, true);
  rescan();
}

async function pickFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "kiku-pc", mode: "read" });
  } catch (err) {
    if (err.name !== "AbortError") showMsg("フォルダを開けませんでした: " + err.name);
    return;
  }
  await addFolderHandle(handle);
}
async function addFolderHandle(handle) {
  for (const f of folders) {
    if (await f.handle.isSameEntry(handle)) { showMsg(`「${f.name}」は登録済みです`); return; }
  }
  const f = { id: crypto.randomUUID(), name: handle.name, handle };
  await db.putFolder(f);
  folders.push(f);
  settings.folder = f.id;
  settings.save();
  await rescan();
}

async function unregister() {
  const f = folders.find(x => x.id === settings.folder) || (folders.length === 1 ? folders[0] : null);
  if (!f) return;
  if (!confirm(`「${f.name}」を一覧から外します。\n（フォルダとファイルはそのまま残ります）`)) return;
  const cur = findTrack(player.currentId);
  if (cur && cur.folderId === f.id) player.stop();
  await db.forgetFolder(f.id);
  folders = folders.filter(x => x.id !== f.id);
  tracks = tracks.filter(t => t.folderId !== f.id);
  refreshList();
}

/* ---------- 情報 ---------- */
function renderDiag() {
  $("#diag").textContent = [
    "キー: スペース＝再生/停止　←→＝10秒（Shift で30秒）　↑↓＝速度　A・B＝区間　Esc＝区間を解除",
    `フォルダ: ${folders.map(f => f.name).join("、") || "なし"}`,
    `曲数: ${tracks.length}（長さ未確認 ${tracks.filter(t => !t.duration).length}）`,
    `フォルダを読む仕組み: ${"showDirectoryPicker" in window ? "あり" : "なし（Edge か Chrome で開いてください）"}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");
}

/* ---------- 起動 ---------- */
function bindEvents() {
  $("#addFolder").addEventListener("click", pickFolder);
  $("#reload").addEventListener("click", rescan);
  $("#permitBtn").addEventListener("click", grantAll);
  $("#unregister").addEventListener("click", unregister);
  const changeSetting = (key, value) => { settings[key] = value; settings.save(); refreshList(); };
  $("#folder").addEventListener("change", e => changeSetting("folder", e.target.value));
  $("#sortKey").addEventListener("change", e => changeSetting("sortKey", e.target.value));
  $("#sortDir").addEventListener("click", () => changeSetting("sortDir", settings.sortDir === "desc" ? "asc" : "desc"));
}

async function init() {
  bindEvents();
  if (!("showDirectoryPicker" in window)) {
    $("#addFolder").disabled = true;
    showMsg("このブラウザではフォルダを読めません。Edge か Chrome で開いてください。", true);
  }
  folders = await db.allFolders();
  refreshList();
  await rescan();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});
}
init();
