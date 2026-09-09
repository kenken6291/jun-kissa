/* =========================================================
   純喫茶・レストラン巡りログ - app.js
   構成：
     1. 定数と状態
     2. 地図の初期化（Leaflet + OpenStreetMap）
     3. マーカーとログ一覧の描画
     4. 記録フォーム（追加・編集モーダル）
     5. 写真の読み込みと縮小
     6. Geminiによる一言コメント生成
     7. 店名・住所検索（Nominatim）
     8. 初期化（auth.jsから呼ばれる window.initApp）
   ========================================================= */

"use strict";

/* =========================================================
   1. 定数と状態
   ========================================================= */
const PRESET_MENUS = [
  "クリームソーダ",
  "ナポリタン",
  "プリン",
  "ホットケーキ",
  "ブレンドコーヒー",
  "ミックスサンド",
];

let map;
let markers = {};
let visits = [];
let popupJustClosed = false;
let mapInitialized = false;

/* =========================================================
   2. 地図の初期化
   ========================================================= */
function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  map = L.map("map", { zoomControl: true }).setView([36.2, 138.25], 5);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.on("popupclose", () => {
    popupJustClosed = true;
    setTimeout(() => (popupJustClosed = false), 350);
  });

  map.on("click", (e) => {
    if (popupJustClosed) return;
    openForm({ lat: e.latlng.lat, lng: e.latlng.lng });
  });
}

function makeKissaIcon() {
  return L.divIcon({
    className: "kissa-pin",
    html: '<div class="pin-body"><span>☕</span></div>',
    iconSize: [38, 38],
    iconAnchor: [19, 38],
    popupAnchor: [0, -40],
  });
}

/* =========================================================
   3. マーカーとログ一覧の描画
   ========================================================= */
function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeURL(url) {
  if (!url) return "";
  try {
    const u = new URL(url.trim());
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_) {}
  return "";
}

function formatDate(iso) {
  if (!iso) return "日付未記入";
  const [y, m, d] = iso.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

function buildPopupHTML(v) {
  const menus = (v.menus || [])
    .map((m) => `<span class="menu-tag">${escapeHTML(m)}</span>`)
    .join(" ");
  const safeURL = sanitizeURL(v.url);
  return `
    <div class="popup-card">
      <p class="popup-name">${escapeHTML(v.name)}</p>
      <p class="popup-date">${escapeHTML(formatDate(v.date))}</p>
      ${menus ? `<div class="log-card-menus">${menus}</div>` : ""}
      ${v.photoUrl ? `<img class="popup-photo" src="${v.photoUrl}" alt="${escapeHTML(v.name)}の写真">` : ""}
      ${v.memo ? `<p class="popup-memo">${escapeHTML(v.memo)}</p>` : ""}
      ${safeURL ? `<a class="popup-url-link" href="${safeURL}" target="_blank" rel="noopener noreferrer">🌐 ホームページを見る</a>` : ""}
      <div class="popup-actions">
        <button class="btn btn-small btn-ghost" data-action="edit" data-id="${v.id}">✏ 修正</button>
        <button class="btn btn-small btn-danger" data-action="delete" data-id="${v.id}">🗑 削除</button>
      </div>
    </div>`;
}

function addMarker(v) {
  const marker = L.marker([Number(v.lat), Number(v.lng)], { icon: makeKissaIcon() })
    .addTo(map)
    .bindPopup(buildPopupHTML(v), { maxWidth: 260 });
  markers[v.id] = marker;
}

function renderMarkers() {
  Object.values(markers).forEach((m) => map.removeLayer(m));
  markers = {};
  visits.forEach(addMarker);
}

function renderList() {
  const list = document.getElementById("log-list");
  const empty = document.getElementById("log-empty");
  const count = document.getElementById("log-count");
  list.innerHTML = "";

  const sorted = [...visits].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  sorted.forEach((v) => {
    const li = document.createElement("li");
    li.className = "log-card";
    const safeURL = sanitizeURL(v.url);

    li.innerHTML = `
      <div class="log-card-head">
        <span class="log-card-name">${escapeHTML(v.name)}</span>
        <span class="log-card-date">${escapeHTML(formatDate(v.date))}</span>
      </div>
      ${
        (v.menus || []).length
          ? `<div class="log-card-menus">${v.menus.map((m) => `<span class="menu-tag">${escapeHTML(m)}</span>`).join("")}</div>`
          : ""
      }
      ${v.photoUrl ? `<img class="log-card-thumb" src="${v.photoUrl}" alt="" loading="lazy">` : ""}
      <div class="log-card-footer">
        ${safeURL ? `<a class="log-card-url-link" href="${safeURL}" target="_blank" rel="noopener noreferrer">🌐 ホームページ</a>` : `<span></span>`}
        <div class="log-card-btns">
          <button class="btn btn-small btn-ghost" data-action="edit" data-id="${v.id}">✏ 修正</button>
          <button class="btn btn-small btn-danger" data-action="delete" data-id="${v.id}">🗑 削除</button>
        </div>
      </div>
    `;

    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-action], a")) return;
      map.setView([Number(v.lat), Number(v.lng)], Math.max(map.getZoom(), 15));
      markers[v.id]?.openPopup();
      document.getElementById("map").scrollIntoView({ behavior: "smooth" });
    });
    list.appendChild(li);
  });

  empty.hidden = visits.length > 0;
  count.textContent = visits.length ? `（${visits.length}軒）` : "";
}

async function reloadAll() {
  const data = await apiCall("listVisits", {});
  visits = data.visits || [];
  renderMarkers();
  renderList();
}

/* =========================================================
   4. 記録フォーム（追加・編集モーダル）
   ========================================================= */
const overlay = document.getElementById("modal-overlay");
const form = document.getElementById("visit-form");
let pendingPhotoBase64 = null; // 新しく選んだ写真（未保存）
let existingPhotoUrl = null;   // 編集時の既存写真URL
let photoRemoved = false;      // 既存写真の削除フラグ
let tempMarker = null;

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

function openForm({ lat, lng, visit = null }) {
  form.reset();
  pendingPhotoBase64 = null;
  photoRemoved = false;
  existingPhotoUrl = visit?.photoUrl || null;

  document.getElementById("field-id").value = visit?.id || "";
  document.getElementById("field-lat").value = visit?.lat ?? lat;
  document.getElementById("field-lng").value = visit?.lng ?? lng;
  document.getElementById("field-name").value = visit?.name || "";
  document.getElementById("field-memo").value = visit?.memo || "";
  document.getElementById("field-url").value = visit?.url || "";
  setTimeout(() => {
    document.getElementById("field-date").value = visit?.date || new Date().toISOString().slice(0, 10);
  }, 0);

  const presetSelected = new Set((visit?.menus || []).filter((m) => PRESET_MENUS.includes(m)));
  const freeMenus = (visit?.menus || []).filter((m) => !PRESET_MENUS.includes(m));
  document.querySelectorAll("#menu-chips input").forEach((cb) => (cb.checked = presetSelected.has(cb.value)));
  document.getElementById("field-menu-free").value = freeMenus.join("、");

  updatePhotoPreview();

  removeTempMarker();
  const la = Number(document.getElementById("field-lat").value);
  const ln = Number(document.getElementById("field-lng").value);
  tempMarker = L.marker([la, ln], { icon: makeKissaIcon(), opacity: 0.6 }).addTo(map);
  document.getElementById("coords-note").textContent = `ピンの位置：北緯 ${la.toFixed(5)} ／ 東経 ${ln.toFixed(5)}`;

  document.getElementById("modal-title").textContent = visit ? "記録票を直す" : "ご来店記録票";
  overlay.hidden = false;

  map.dragging.disable();
  map.touchZoom.disable();
  map.scrollWheelZoom.disable();
  map.doubleClickZoom.disable();
  if (map.tap) map.tap.disable();
  document.body.classList.add("modal-open");

  setTimeout(() => document.getElementById("field-name").focus(), 300);
}

function closeForm() {
  overlay.hidden = true;
  removeTempMarker();
  pendingPhotoBase64 = null;
  photoRemoved = false;

  map.dragging.enable();
  map.touchZoom.enable();
  map.scrollWheelZoom.enable();
  map.doubleClickZoom.enable();
  if (map.tap) map.tap.enable();
  document.body.classList.remove("modal-open");
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
  const src = pendingPhotoBase64 || (!photoRemoved && existingPhotoUrl) || null;
  if (src) {
    img.src = src;
    box.hidden = false;
  } else {
    img.removeAttribute("src");
    box.hidden = true;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = form.querySelector('button[type="submit"]');

  const menus = [
    ...[...document.querySelectorAll("#menu-chips input:checked")].map((cb) => cb.value),
    ...document.getElementById("field-menu-free").value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
  ];

  const id = document.getElementById("field-id").value;
  const visit = {
    id: id || undefined,
    name: document.getElementById("field-name").value.trim(),
    date: document.getElementById("field-date").value,
    menus,
    memo: document.getElementById("field-memo").value.trim(),
    url: document.getElementById("field-url").value.trim(),
    lat: Number(document.getElementById("field-lat").value),
    lng: Number(document.getElementById("field-lng").value),
  };
  if (pendingPhotoBase64) {
    visit.photoBase64 = pendingPhotoBase64;
    visit.photoMime = "image/jpeg";
  } else if (photoRemoved) {
    visit.removePhoto = true;
  }

  submitBtn.disabled = true; // 二重送信防止
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = "保存中…";
  try {
    const data = id
      ? await apiCall("updateVisit", { visit })
      : await apiCall("addVisit", { visit });
    closeForm();
    await reloadAll();
    markers[data.visit.id]?.openPopup();
    showToast(`「${data.visit.name}」を記録しました ☕`);
  } catch (err) {
    console.error(err);
    showToast(err.message || "保存に失敗しました");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

document.getElementById("btn-cancel").addEventListener("click", closeForm);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeForm();
});

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
      try {
        await apiCall("deleteVisit", { id: visit.id });
        await reloadAll();
        showToast("記録を消しました");
      } catch (err) {
        showToast(err.message || "削除に失敗しました");
      }
    }
  }
});

/* =========================================================
   5. 写真の読み込みと縮小
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
      pendingPhotoBase64 = canvas.toDataURL("image/jpeg", 0.82);
      photoRemoved = false;
      updatePhotoPreview();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-photo-remove").addEventListener("click", () => {
  pendingPhotoBase64 = null;
  photoRemoved = true;
  document.getElementById("field-photo").value = "";
  updatePhotoPreview();
});

/* =========================================================
   6. Geminiによる一言コメント生成
   ========================================================= */
document.getElementById("btn-ai-memo").addEventListener("click", async () => {
  const btn = document.getElementById("btn-ai-memo");
  const name = document.getElementById("field-name").value.trim();
  if (!name) {
    showToast("先に店名を入力してください");
    return;
  }
  const menus = [
    ...[...document.querySelectorAll("#menu-chips input:checked")].map((cb) => cb.value),
    ...document.getElementById("field-menu-free").value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
  ];
  const memo = document.getElementById("field-memo").value.trim();

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "AIが考え中…";
  try {
    const data = await apiCall("generateComment", { name, menus, memo });
    document.getElementById("field-memo").value = data.comment;
  } catch (err) {
    showToast(err.message || "AIコメントの生成に失敗しました");
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

/* =========================================================
   7. 店名・住所検索（Nominatim）
   ========================================================= */
async function searchPlace() {
  const q = document.getElementById("input-search").value.trim();
  const resultsEl = document.getElementById("search-results");
  if (!q) return;

  resultsEl.hidden = false;
  resultsEl.innerHTML = "<li>さがしています…</li>";

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
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

document.getElementById("btn-locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("この端末では現在地を取得できません");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
    () => showToast("現在地を取得できませんでした"),
    { enableHighAccuracy: true }
  );
});

document.getElementById("btn-fab").addEventListener("click", () => {
  const c = map.getCenter();
  openForm({ lat: c.lat, lng: c.lng });
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
   8. 初期化（auth.jsのログイン確認後に呼ばれる）
   ========================================================= */
window.initApp = async function initApp() {
  initMap();
  buildMenuChips();
  try {
    await reloadAll();
    if (visits.length) {
      const group = L.featureGroup(Object.values(markers));
      map.fitBounds(group.getBounds().pad(0.3));
    }
  } catch (err) {
    // セッション切れなどでlistVisitsが失敗した場合はログアウト扱いにする
    console.error(err);
    clearSession();
    location.reload();
  }
};
