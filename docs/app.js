/* 聴 iPhone 版 — 取り込んだ音声ファイルを選んで再生する PWA
 * 曲は IndexedDB に保存する（tracks＝曲の情報 / blobs＝音声そのもの）。
 * 再生欄と小道具は player.js（PC 版と共通）。
 */
"use strict";

const ALL = "*";              // グループの絞り込み「すべて」（未分類は空文字）
const KEEP_ORIGINAL = "（Dropbox などの元のファイルは残ります）";

const settings = loadSettings("kiku-settings", { group: ALL });

/* ---------- IndexedDB ---------- */
const db = (() => {
  let conn = null;
  async function open() {
    if (conn) return conn;
    const r = indexedDB.open("kiku", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("tracks", { keyPath: "id" });
      r.result.createObjectStore("blobs");
    };
    conn = await idbDone(r);
    return conn;
  }
  const tx = async (names, mode) => (await open()).transaction(names, mode);
  return {
    async allTracks() { return idbDone((await tx("tracks", "readonly")).objectStore("tracks").getAll()); },
    async getBlob(id) { return idbDone((await tx("blobs", "readonly")).objectStore("blobs").get(id)); },
    async putMeta(meta) {
      const t = await tx("tracks", "readwrite");
      t.objectStore("tracks").put(meta);
      return idbFinished(t);
    },
    async add(meta, blob) {
      const t = await tx(["tracks", "blobs"], "readwrite");
      t.objectStore("blobs").put(blob, meta.id);
      t.objectStore("tracks").put(meta);
      return idbFinished(t);
    },
    async remove(id) {
      const t = await tx(["tracks", "blobs"], "readwrite");
      t.objectStore("blobs").delete(id);
      t.objectStore("tracks").delete(id);
      return idbFinished(t);
    },
  };
})();

/* ---------- 曲の一覧 ---------- */
let tracks = [];

const SORTS = {
  name: (a, b) => collator.compare(a.name, b.name),
  imported: (a, b) => a.importedAt - b.importedAt,
  modified: (a, b) => a.lastModified - b.lastModified,
  duration: (a, b) => a.duration - b.duration,
};
const groupOf = t => t.group || "";
const findTrack = id => tracks.find(t => t.id === id);

/* 一覧に出す曲（グループで絞って並べ替えたもの）。「次へ」もこの順に進む */
function sortedTracks() {
  const cmp = SORTS[settings.sortKey] || SORTS.name;
  const dir = settings.sortDir === "desc" ? -1 : 1;
  const shown = settings.group === ALL ? tracks : tracks.filter(t => groupOf(t) === settings.group);
  return [...shown].sort((a, b) => dir * cmp(a, b) || collator.compare(a.name, b.name));
}

const player = createPlayer({
  settings,
  findTrack,
  sortedTracks,
  async loadUrl(t) {
    const blob = await db.getBlob(t.id);
    return blob ? URL.createObjectURL(blob) : null;
  },
  saveMeta: t => db.putMeta(t),
  onChange: () => renderList(),
  artwork: "icon-512.png",
});

function renderGroups() {
  const names = groupNames();
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
  const shown = sortedTracks();
  if (selecting) pruneSelection(shown);
  $("#list").replaceChildren(...shown.map(t => trackRow(t, {
    now: t.id === player.currentId,
    meta: metaLine(t),
    check: selecting ? selected.has(t.id) : undefined,
    onClick: () => (selecting ? toggleSelected(t.id) : player.play(t.id)),
    onMore: selecting ? null : () => openSheet(t),
  })));
  renderSelBar(shown);
  $("#empty").hidden = tracks.length > 0;
  $("#sortKey").value = settings.sortKey;
  $("#sortDir").textContent = settings.sortDir === "desc" ? "降順" : "昇順";
}

/* 曲の集まりや絞り込みが変わったとき */
function refreshList() {
  renderGroups();
  renderList();
  player.preloadNext();
}

/* ---------- グループ・削除 ---------- */
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

const groupNames = () => [...new Set(tracks.map(groupOf).filter(Boolean))].sort(collator.compare);

/* グループを選ぶ小窓。既存のグループ・未分類を押すか、新しい名前を打つ。
 * 選んだ名前（未分類は ""）を返す。やめたら null */
function askGroup(current) {
  const sheet = $("#groupSheet");
  const choices = [...groupNames().map(n => [n, n]), ["", "未分類"]];
  $("#groupChoices").replaceChildren(...choices.map(([name, label], i) => {
    const b = document.createElement("button");
    b.className = "btn" + (name === current ? " on" : "");
    b.value = "pick:" + i;
    b.textContent = label;
    return b;
  }));
  const input = $("#groupName");
  input.value = "";
  sheet.returnValue = "";
  return new Promise(resolve => {
    sheet.addEventListener("close", () => {
      const v = sheet.returnValue;
      if (v.startsWith("pick:")) resolve(choices[+v.slice(5)][0]);
      else if (v === "new") resolve(input.value.trim());
      else resolve(null);
    }, { once: true });
    sheet.showModal();
  });
}

async function setGroup(list, g) {
  for (const t of list) {
    t.group = g;
    await db.putMeta(t);
  }
}
async function removeTracks(list) {
  const ids = new Set(list.map(t => t.id));
  if (ids.has(player.currentId)) player.stop();
  for (const id of ids) await db.remove(id);
  tracks = tracks.filter(t => !ids.has(t.id));
  showStorage();
}

async function changeGroup(t) {
  const g = await askGroup(groupOf(t));
  if (g === null || g === groupOf(t)) return;
  await setGroup([t], g);
  refreshList();
}

async function deleteTrack(t) {
  if (!confirm(`「${baseName(t.name)}」をアプリから削除します。\n${KEEP_ORIGINAL}`)) return;
  await removeTracks([t]);
  refreshList();
}

/* ---------- 選ぶモード（まとめてグループへ・削除） ---------- */
let selecting = false;
const selected = new Set();

function setSelecting(on) {
  selecting = on;
  selected.clear();
  renderList();
}
function toggleSelected(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  renderList();
}
/* 絞り込みで見えなくなった曲は選択から外す */
function pruneSelection(shown) {
  const ids = new Set(shown.map(t => t.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
}
const selectedTracks = () => tracks.filter(t => selected.has(t.id));

function renderSelBar(shown) {
  $("#selBar").hidden = !selecting;
  $("#selectBtn").hidden = selecting;
  if (!selecting) return;
  const n = selected.size;
  const allOn = shown.length > 0 && n === shown.length;
  $("#selAll").textContent = allOn ? "すべて外す" : "すべて選択";
  $("#selGroup").textContent = n ? `グループへ（${n}曲）` : "グループへ";
  $("#selDelete").textContent = n ? `削除（${n}曲）` : "削除";
  $("#selGroup").disabled = $("#selDelete").disabled = n === 0;
}

function toggleSelectAll() {
  const shown = sortedTracks();
  const allOn = shown.length > 0 && selected.size === shown.length;
  selected.clear();
  if (!allOn) for (const t of shown) selected.add(t.id);
  renderList();
}
async function groupSelected() {
  const g = await askGroup(null);
  if (g === null) return;
  const list = selectedTracks();
  await setGroup(list, g);
  showMsg(`${list.length}曲を「${g || "未分類"}」にしました`);
  selecting = false;
  refreshList();
}
async function deleteSelected() {
  const list = selectedTracks();
  if (!confirm(`${list.length}曲をアプリから削除します。\n${KEEP_ORIGINAL}`)) return;
  await removeTracks(list);
  selecting = false;
  refreshList();
}

/* ---------- 取り込み ---------- */
async function importFiles(files) {
  const list = [...files];
  // 「すべて」表示中ならグループ名を聞く。絞り込み中はそのグループに入れる
  const group = settings.group === ALL ? await askGroup(null) : settings.group;
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

/* ---------- 容量・情報 ---------- */
let persisted = "未確認";
async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  $("#storage").textContent = `使用 ${fmtSize(usage)} / 空き ${fmtSize(Math.max(0, quota - usage))}`;
  renderDiag(usage, quota);
}
function renderDiag(usage, quota) {
  const audio = player.audio;
  $("#diag").textContent = [
    `ホーム画面から起動: ${navigator.standalone === true ? "はい" : "いいえ（Safari）"}`,
    `保存の固定(persist): ${persisted}`,
    `容量: 使用 ${fmtSize(usage)} / 上限 ${fmtSize(quota)}`,
    `曲数: ${tracks.length}（長さ不明 ${tracks.filter(t => !t.duration).length}）`,
    `声の高さ保持: ${"preservesPitch" in audio ? "preservesPitch" : ("webkitPreservesPitch" in audio ? "webkitPreservesPitch" : "なし")}`,
    `MediaSession: ${"mediaSession" in navigator ? "あり" : "なし"}`,
    `UA: ${navigator.userAgent}`,
  ].join("\n");
}

/* ---------- 起動 ---------- */
function bindEvents() {
  $("#picker").addEventListener("change", e => {
    const files = e.target.files;
    if (files && files.length) importFiles(files).finally(() => { e.target.value = ""; });
  });
  const changeSetting = (key, value) => { settings[key] = value; settings.save(); refreshList(); };
  $("#group").addEventListener("change", e => changeSetting("group", e.target.value));
  $("#sortKey").addEventListener("change", e => changeSetting("sortKey", e.target.value));
  $("#sortDir").addEventListener("click", () => changeSetting("sortDir", settings.sortDir === "desc" ? "asc" : "desc"));
  $("#selectBtn").addEventListener("click", () => setSelecting(true));
  $("#selCancel").addEventListener("click", () => setSelecting(false));
  $("#selAll").addEventListener("click", toggleSelectAll);
  $("#selGroup").addEventListener("click", groupSelected);
  $("#selDelete").addEventListener("click", deleteSelected);
  // 名前の欄で改行を押したら「この名前で」と同じ（既定では最初のグループのボタンが押されてしまう）
  $("#groupName").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("#groupSheet").close("new"); }
  });
}

async function init() {
  bindEvents();
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
