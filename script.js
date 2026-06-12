/* =========================================================
   純喫茶巡りログ - script.js
   構成：
     1. 定数と状態
     2. IndexedDB（写真も保存できるブラウザ内データベース）
     3. 地図の初期化（Leaflet + OpenStreetMap）
     4. マーカーとログ一覧の描画
     5. 記録フォーム（追加・編集モーダル）
     6. 写真の読み込みと縮小
     7. 店名・住所検索（Nominatim：OSMの無料ジオコーディング）
     8. データの書き出し / 読み込み（バックアップ）
     9. 初期化
   ========================================================= */

"use strict";

/* =========================================================
   1. 定数と状態
   ========================================================= */
const DB_NAME = "jun-kissa-log";
const DB_VERSION = 1;
const STORE_NAME = "visits";

// メニューの定番チップ（フォームに表示）
const PRESET_MENUS = [
  "クリームソーダ",
  "ナポリタン",
  "プリン",
  "ホットケーキ",
  "ブレンドコーヒー",
  "ミックスサンド",
];

let map;                 // Leafletの地図オブジェクト
let markers = {};        // 記録ID → マーカー の対応表
let visits = [];         // 全記録のキャッシュ
let popupJustClosed = false; // ポップアップを閉じるクリックでフォームが開かないようにするフラグ

/* =========================================================
   2. IndexedDB ヘルパー
   ※ GitHub Pagesは静的ホスティングのため、データはすべて
     閲覧者のブラウザ内に保存されます（サーバーには送られません）。
   ========================================================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================================================
   3. 地図の初期化（Leaflet + OpenStreetMap：APIキー不要）
   ========================================================= */
function initMap() {
  // 初期表示は日本全体
  map = L.map("map", { zoomControl: true }).setView([36.2, 138.25], 5);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // ポップアップを閉じた直後のクリックではフォームを開かない
  map.on("popupclose", () => {
    popupJustClosed = true;
    setTimeout(() => (popupJustClosed = false), 350);
  });

  // 地図をクリック → その場所で記録フォームを開く
  map.on("click", (e) => {
    if (popupJustClosed) return;
    openForm({ lat: e.latlng.lat, lng: e.latlng.lng });
  });
}

// コーヒーカップ柄のオリジナルピン
function makeKissaIcon() {
  return L.divIcon({
    className: "kissa-pin",
    html: '<div class="pin-body"><span>☕</span></div>',
    iconSize: [38, 38],
    iconAnchor: [19, 38],   // ピンの先端を座標に合わせる
    popupAnchor: [0, -40],
  });
}

/* =========================================================
   4. マーカーとログ一覧の描画
   ========================================================= */
function escapeHTML(str) {
  // ユーザー入力をHTMLに埋め込む前の無害化
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(iso) {
  if (!iso) return "日付未記入";
  const [y, m, d] = iso.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

// ポップアップの中身（店名・日付・メニュー・写真・メモ）を組み立てる
function buildPopupHTML(v) {
  const menus = (v.menus || [])
    .map((m) => `<span class="menu-tag">${escapeHTML(m)}</span>`)
    .join(" ");
  return `
    <div class="popup-card">
      <p class="popup-name">${escapeHTML(v.name)}</p>
      <p class="popup-date">${escapeHTML(formatDate(v.date))}</p>
      ${menus ? `<div class="log-card-menus">${menus}</div>` : ""}
      ${v.photo ? `<img class="popup-photo" src="${v.photo}" alt="${escapeHTML(v.name)}の写真">` : ""}
      ${v.memo ? `<p class="popup-memo">${escapeHTML(v.memo)}</p>` : ""}
      <div class="popup-actions">
        <button class="btn btn-small btn-ghost" data-action="edit" data-id="${v.id}">直す</button>
        <button class="btn btn-small btn-danger" data-action="delete" data-id="${v.id}">消す</button>
      </div>
    </div>`;
}

// 1件分のマーカーを地図に追加
function addMarker(v) {
  const marker = L.marker([v.lat, v.lng], { icon: makeKissaIcon() })
    .addTo(map)
    .bindPopup(buildPopupHTML(v), { maxWidth: 260 });
  markers[v.id] = marker;
}

// マーカーを全部描き直す
function renderMarkers() {
  Object.values(markers).forEach((m) => map.removeLayer(m));
  markers = {};
  visits.forEach(addMarker);
}

// サイドバーのログ一覧（伝票カード）を描き直す
function renderList() {
  const list = document.getElementById("log-list");
  const empty = document.getElementById("log-empty");
  const count = document.getElementById("log-count");
  list.innerHTML = "";

  // 訪問日の新しい順に並べる
  const sorted = [...visits].sort((a, b) =>
    (b.date || "").localeCompare(a.date || "")
  );

  sorted.forEach((v) => {
    const li = document.createElement("li");
    li.className = "log-card";
    li.innerHTML = `
      <div class="log-card-head">
        <span class="log-card-name">${escapeHTML(v.name)}</span>
        <span class="log-card-date">${escapeHTML(formatDate(v.date))}</span>
      </div>
      ${
        (v.menus || []).length
          ? `<div class="log-card-menus">${v.menus
              .map((m) => `<span class="menu-tag">${escapeHTML(m)}</span>`)
              .join("")}</div>`
          : ""
      }
      ${v.photo ? `<img class="log-card-thumb" src="${v.photo}" alt="">` : ""}
    `;
    // カードをタップ → 地図のピンへ移動してポップアップを開く
    li.addEventListener("click", () => {
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 15));
      markers[v.id]?.openPopup();
      // スマホでは地図が画面上部にあるためスクロールで見せる
      document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    });
    list.appendChild(li);
  });

  empty.hidden = visits.length > 0;
  count.textContent = visits.length ? `（${visits.length}軒）` : "";
}

async function reloadAll() {
  visits = await dbGetAll();
  renderMarkers();
  renderList();
}

/* =========================================================
   5. 記録フォーム（追加・編集モーダル）
   ========================================================= */
const overlay = document.getElementById("modal-overlay");
const form = document.getElementById("visit-form");
let pendingPhoto = null;   // フォームで選択中の写真（dataURL）
let tempMarker = null;     // 追加場所を示す仮ピン

// メニューチップをフォームに生成
function buildMenuChips() {
  const wrap = document.getElementById("menu-chips");
  wrap.innerHTML = PRESET_MENUS.map(
    (m) => `
      <label class="menu-chip">
        <input type="checkbox" value="${escapeHTML(m)}">
        <span>${escapeHTML(m)}</span>
      </label>`
  ).join("");
}

// フォームを開く（visit を渡すと編集モード）
function openForm({ lat, lng, visit = null }) {
  form.reset();
  pendingPhoto = visit?.photo || null;

  document.getElementById("field-id").value = visit?.id || "";
  document.getElementById("field-lat").value = visit?.lat ?? lat;
  document.getElementById("field-lng").value = visit?.lng ?? lng;
  document.getElementById("field-name").value = visit?.name || "";
  document.getElementById("field-memo").value = visit?.memo || "";
  document.getElementById("field-date").value =
    visit?.date || new Date().toISOString().slice(0, 10);

  // メニューチップ：定番は選択を復元、それ以外は自由入力欄へ
  const presetSelected = new Set(
    (visit?.menus || []).filter((m) => PRESET_MENUS.includes(m))
  );
  const freeMenus = (visit?.menus || []).filter(
    (m) => !PRESET_MENUS.includes(m)
  );
  document
    .querySelectorAll("#menu-chips input")
    .forEach((cb) => (cb.checked = presetSelected.has(cb.value)));
  document.getElementById("field-menu-free").value = freeMenus.join("、");

  updatePhotoPreview();

  // 仮ピンを置いて位置を見せる
  removeTempMarker();
  const la = Number(document.getElementById("field-lat").value);
  const ln = Number(document.getElementById("field-lng").value);
  tempMarker = L.marker([la, ln], { icon: makeKissaIcon(), opacity: 0.6 }).addTo(map);
  document.getElementById("coords-note").textContent =
    `ピンの位置：北緯 ${la.toFixed(5)} ／ 東経 ${ln.toFixed(5)}`;

  document.getElementById("modal-title").textContent = visit
    ? "記録票を直す"
    : "ご来店記録票";
  overlay.hidden = false;
  document.getElementById("field-name").focus();
}

function closeForm() {
  overlay.hidden = true;
  removeTempMarker();
  pendingPhoto = null;
}

function removeTempMarker() {
  if (tempMarker) {
    map.removeLayer(tempMarker);
    tempMarker = null;
  }
}

function updatePhotoPreview() {
  const box = document.getElementById("photo-preview");
  const img = document.getElementById("photo-preview-img");
  if (pendingPhoto) {
    img.src = pendingPhoto;
    box.hidden = false;
  } else {
    img.removeAttribute("src");
    box.hidden = true;
  }
}

// 保存処理（追加・編集 共通）
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const menus = [
    ...[...document.querySelectorAll("#menu-chips input:checked")].map(
      (cb) => cb.value
    ),
    ...document
      .getElementById("field-menu-free")
      .value.split(/[、,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  const record = {
    id: document.getElementById("field-id").value || `v_${Date.now()}`,
    name: document.getElementById("field-name").value.trim(),
    date: document.getElementById("field-date").value,
    menus,
    memo: document.getElementById("field-memo").value.trim(),
    photo: pendingPhoto,
    lat: Number(document.getElementById("field-lat").value),
    lng: Number(document.getElementById("field-lng").value),
  };

  try {
    await dbPut(record);
    closeForm();
    await reloadAll();
    markers[record.id]?.openPopup();
    showToast(`「${record.name}」を記録しました ☕`);
  } catch (err) {
    console.error(err);
    showToast("保存に失敗しました。容量不足の可能性があります。");
  }
});

document.getElementById("btn-cancel").addEventListener("click", closeForm);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeForm(); // 背景クリックで閉じる
});

// ポップアップ内の「直す」「消す」ボタン（動的要素なのでイベント委任）
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const visit = visits.find((v) => v.id === btn.dataset.id);
  if (!visit) return;

  if (btn.dataset.action === "edit") {
    map.closePopup();
    openForm({ visit });
  } else if (btn.dataset.action === "delete") {
    if (confirm(`「${visit.name}」の記録を消しますか？`)) {
      await dbDelete(visit.id);
      await reloadAll();
      showToast("記録を消しました");
    }
  }
});

/* =========================================================
   6. 写真の読み込みと縮小
   ※ そのまま保存すると容量を圧迫するため、長辺1024pxに縮小して
     JPEGとして保存します。
   ========================================================= */
document.getElementById("field-photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      pendingPhoto = canvas.toDataURL("image/jpeg", 0.82);
      updatePhotoPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-photo-remove").addEventListener("click", () => {
  pendingPhoto = null;
  document.getElementById("field-photo").value = "";
  updatePhotoPreview();
});

/* =========================================================
   7. 店名・住所検索
   ※ OpenStreetMapの無料ジオコーディング「Nominatim」を使用。
     APIキー不要ですが、連続リクエストは控えめに（利用規約準拠）。
   ========================================================= */
async function searchPlace() {
  const q = document.getElementById("input-search").value.trim();
  const resultsEl = document.getElementById("search-results");
  if (!q) return;

  resultsEl.hidden = false;
  resultsEl.innerHTML = "<li>さがしています…</li>";

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=" +
      encodeURIComponent(q);
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
    });
    const data = await res.json();

    if (!data.length) {
      resultsEl.innerHTML = "<li>見つかりませんでした。キーワードを変えてみてください。</li>";
      return;
    }

    resultsEl.innerHTML = "";
    data.forEach((place) => {
      const li = document.createElement("li");
      li.textContent = place.display_name;
      li.addEventListener("click", () => {
        const lat = Number(place.lat);
        const lng = Number(place.lon);
        map.setView([lat, lng], 16);
        resultsEl.hidden = true;
        // 検索結果の名前（先頭部分）を店名候補としてフォームに渡す
        openForm({ lat, lng });
        const guess = place.display_name.split(",")[0].trim();
        if (guess) document.getElementById("field-name").value = guess;
      });
      resultsEl.appendChild(li);
    });
  } catch (err) {
    console.error(err);
    resultsEl.innerHTML = "<li>検索に失敗しました。通信環境をご確認ください。</li>";
  }
}

document.getElementById("btn-search").addEventListener("click", searchPlace);
document.getElementById("input-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchPlace();
  }
});

// 現在地へ移動
document.getElementById("btn-locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("この端末では現在地を取得できません");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
    () => showToast("現在地を取得できませんでした")
  );
});

// FAB（スマホ）：地図の中心に記録を追加
document.getElementById("btn-fab").addEventListener("click", () => {
  const c = map.getCenter();
  openForm({ lat: c.lat, lng: c.lng });
});

/* =========================================================
   8. データの書き出し / 読み込み
   ※ データは各ブラウザの中にだけ保存されるため、機種変更や
     ブラウザの掃除に備えてJSONでバックアップできます。
   ========================================================= */
document.getElementById("btn-export").addEventListener("click", async () => {
  const data = await dbGetAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `jun-kissa-log_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("記録を書き出しました");
});

document.getElementById("input-import").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error("形式が違います");
      for (const rec of data) {
        if (rec.id && rec.name != null && rec.lat != null && rec.lng != null) {
          await dbPut(rec);
        }
      }
      await reloadAll();
      showToast(`${data.length}件の記録を読み込みました`);
    } catch (err) {
      console.error(err);
      showToast("読み込みに失敗しました。書き出したJSONファイルをご指定ください。");
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

/* ---------- トースト通知 ---------- */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* =========================================================
   9. 初期化
   ========================================================= */
window.addEventListener("DOMContentLoaded", async () => {
  initMap();
  buildMenuChips();
  await reloadAll();

  // 記録があれば、全ピンが収まるように表示
  if (visits.length) {
    const group = L.featureGroup(Object.values(markers));
    map.fitBounds(group.getBounds().pad(0.3));
  }
});
