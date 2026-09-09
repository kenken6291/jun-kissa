/* =========================================================
   純喫茶・レストラン巡りログ - auth.js
   会員登録・ログイン・パスワード変更/再発行・退会・セッション管理

   ※ API_BASE_URL は Code.gs をウェブアプリとしてデプロイした後に
     発行されるURL（.../exec）に書き換えてください。
   ========================================================= */

"use strict";

const API_BASE_URL = "https://script.google.com/macros/s/AKfycbxTguHL6mPn5FaD1qvXWz8sgHg-oOrPbhPG48sCqZLDD9M7I65OhDUCR9Mqi5c10XI8/exec"; // 例: https://script.google.com/macros/s/xxxxx/exec

const LS_TOKEN = "jkl_token";
const LS_NICKNAME = "jkl_nickname";

/* ---------- セッション切れの検知フラグ ----------
   trueの間は「再ログイン後にアプリ画面へそのまま復帰する」モード。 */
let resumingSession = false;

/* ---------- API共通呼び出し ----------
   text/plain で送ることでプリフライト（CORS）を回避する、
   いつものGASアプリの通信パターン。 */
async function apiCall(action, payload) {
  const body = Object.assign({ action, token: getToken() }, payload || {});
  const res = await fetch(API_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    // セッション切れ（token失効）を検知したら、入力中の内容を保ったまま
    // ログイン画面へ戻す（loginアクション自体はここを通らないので対象外）
    if (data.error === "ログインが必要です" && action !== "login") {
      handleSessionExpired();
    }
    throw new Error(data.error || "通信に失敗しました");
  }
  return data;
}

/* セッション切れ時：アプリ画面はそのまま裏に残し（入力中の記録フォームなどを
   保持するため）、ログイン画面だけを前面に出す。二重発火は防止する。 */
function handleSessionExpired() {
  if (resumingSession) return;
  resumingSession = true;
  clearSession();
  document.getElementById("app-shell").hidden = true;
  document.getElementById("auth-overlay").hidden = false;
  showAuthPanel("login");
  showAuthError("login", "セッションが切れました。もう一度ログインしてください（入力中の内容は保持されています）");
}

function getToken() {
  return localStorage.getItem(LS_TOKEN) || "";
}

function saveSession(token, nickname) {
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_NICKNAME, nickname);
}

function clearSession() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_NICKNAME);
}

/* ---------- 画面切り替え ---------- */
function showAuthPanel(name) {
  document.querySelectorAll(".auth-panel").forEach((el) => (el.hidden = true));
  document.getElementById(`auth-panel-${name}`).hidden = false;
  document.querySelectorAll(".auth-error").forEach((el) => (el.hidden = true));
}

function showAuthError(panel, message) {
  const el = document.getElementById(`auth-error-${panel}`);
  el.textContent = message;
  el.hidden = false;
}

function setAuthLoading(button, loading, labelWhenLoading) {
  button.disabled = loading;
  if (loading) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = labelWhenLoading || "処理中…";
  } else if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

/* ---------- パスワード表示/非表示トグル共通処理 ---------- */
function wirePasswordToggle(toggleBtn, inputEl) {
  toggleBtn.addEventListener("click", () => {
    const isText = inputEl.type === "text";
    inputEl.type = isText ? "password" : "text";
    toggleBtn.textContent = isText ? "🙈 表示" : "👁 非表示";
  });
}

/* =========================================================
   ログイン
   ========================================================= */
document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-login");
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  setAuthLoading(btn, true, "ログイン中…");
  try {
    // login時点ではまだtokenが無いのでpayloadに直接含める
    const res = await fetch(API_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "login", email, password }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    saveSession(data.token, data.member.nickname);

    if (data.member.requiresPasswordChange) {
      showAuthPanel("force-change");
    } else if (resumingSession) {
      // セッション切れからの再ログイン：ページを作り直さず、
      // 裏に残っていたアプリ画面（記録フォームの入力内容含む）へそのまま戻す
      resumingSession = false;
      document.getElementById("header-nickname").textContent = data.member.nickname;
      document.getElementById("auth-overlay").hidden = true;
      document.getElementById("app-shell").hidden = false;
      if (typeof window.resumeApp === "function") window.resumeApp();
      showToast("再ログインしました");
    } else {
      location.reload();
    }
  } catch (err) {
    showAuthError("login", err.message);
  } finally {
    setAuthLoading(btn, false);
  }
});

/* =========================================================
   新規登録
   ========================================================= */
document.getElementById("form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-register");
  const email = document.getElementById("register-email").value.trim();
  const nickname = document.getElementById("register-nickname").value.trim();

  setAuthLoading(btn, true, "登録中…");
  try {
    const res = await fetch(API_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "register", email, nickname }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    document.getElementById("register-done-message").textContent = data.message;
    showAuthPanel("register-done");
  } catch (err) {
    showAuthError("register", err.message);
  } finally {
    setAuthLoading(btn, false);
  }
});

/* =========================================================
   パスワードを忘れた方
   ========================================================= */
document.getElementById("form-forgot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-forgot");
  const email = document.getElementById("forgot-email").value.trim();

  setAuthLoading(btn, true, "送信中…");
  try {
    const res = await fetch(API_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "forgotPassword", email }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    document.getElementById("forgot-done-message").textContent = data.message;
    showAuthPanel("forgot-done");
  } catch (err) {
    showAuthError("forgot", err.message);
  } finally {
    setAuthLoading(btn, false);
  }
});

/* =========================================================
   初回ログイン時の強制パスワード変更
   ========================================================= */
document.getElementById("form-force-change").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-force-change");
  const newPassword = document.getElementById("force-change-password").value;
  const newPassword2 = document.getElementById("force-change-password2").value;

  if (newPassword.length < 8) {
    showAuthError("force-change", "パスワードは8文字以上にしてください");
    return;
  }
  if (newPassword !== newPassword2) {
    showAuthError("force-change", "確認用のパスワードが一致しません");
    return;
  }

  setAuthLoading(btn, true, "設定中…");
  try {
    await apiCall("changePassword", { newPassword });
    location.reload();
  } catch (err) {
    showAuthError("force-change", err.message);
    setAuthLoading(btn, false);
  }
});

/* ---------- 画面切り替えリンク ---------- */
document.getElementById("link-to-register").addEventListener("click", (e) => { e.preventDefault(); showAuthPanel("register"); });
document.getElementById("link-to-forgot").addEventListener("click", (e) => { e.preventDefault(); showAuthPanel("forgot"); });
document.getElementById("link-to-login-from-register").addEventListener("click", (e) => { e.preventDefault(); showAuthPanel("login"); });
document.getElementById("link-to-login-from-forgot").addEventListener("click", (e) => { e.preventDefault(); showAuthPanel("login"); });
document.getElementById("btn-register-done-ok").addEventListener("click", () => showAuthPanel("login"));
document.getElementById("btn-forgot-done-ok").addEventListener("click", () => showAuthPanel("login"));

/* パスワード表示/非表示 */
wirePasswordToggle(document.getElementById("toggle-login-password"), document.getElementById("login-password"));
wirePasswordToggle(document.getElementById("toggle-force-change-password"), document.getElementById("force-change-password"));
wirePasswordToggle(document.getElementById("toggle-force-change-password2"), document.getElementById("force-change-password2"));

/* =========================================================
   設定パネル（ニックネーム変更・パスワード変更・ログアウト・退会）
   ========================================================= */
document.getElementById("btn-open-settings").addEventListener("click", () => {
  document.getElementById("settings-nickname").value = localStorage.getItem(LS_NICKNAME) || "";
  document.getElementById("settings-overlay").hidden = false;
});
document.getElementById("btn-close-settings").addEventListener("click", () => {
  document.getElementById("settings-overlay").hidden = true;
});

document.getElementById("form-settings-nickname").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nickname = document.getElementById("settings-nickname").value.trim();
  try {
    const data = await apiCall("updateNickname", { nickname });
    localStorage.setItem(LS_NICKNAME, data.nickname);
    document.getElementById("header-nickname").textContent = data.nickname;
    showToast("ニックネームを変更しました");
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById("form-settings-password").addEventListener("submit", async (e) => {
  e.preventDefault();
  const newPassword = document.getElementById("settings-new-password").value;
  const newPassword2 = document.getElementById("settings-new-password2").value;
  if (newPassword.length < 8) return showToast("パスワードは8文字以上にしてください");
  if (newPassword !== newPassword2) return showToast("確認用のパスワードが一致しません");
  try {
    await apiCall("changePassword", { newPassword });
    document.getElementById("form-settings-password").reset();
    showToast("パスワードを変更しました");
  } catch (err) {
    showToast(err.message);
  }
});
wirePasswordToggle(document.getElementById("toggle-settings-password"), document.getElementById("settings-new-password"));
wirePasswordToggle(document.getElementById("toggle-settings-password2"), document.getElementById("settings-new-password2"));

document.getElementById("btn-logout").addEventListener("click", async () => {
  try { await apiCall("logout", {}); } catch (err) {}
  clearSession();
  location.reload();
});

document.getElementById("btn-withdraw").addEventListener("click", async () => {
  if (!confirm("退会すると、これまでの記録がすべて削除されます。本当によろしいですか？")) return;
  if (!confirm("この操作は取り消せません。本当に退会しますか？")) return;
  try {
    await apiCall("withdraw", {});
    clearSession();
    location.reload();
  } catch (err) {
    showToast(err.message);
  }
});

/* =========================================================
   起動時：セッション確認して画面を出し分け
   ========================================================= */
window.addEventListener("DOMContentLoaded", () => {
  if (getToken()) {
    document.getElementById("auth-overlay").hidden = true;
    document.getElementById("header-nickname").textContent = localStorage.getItem(LS_NICKNAME) || "";
    document.getElementById("app-shell").hidden = false;
    if (typeof window.initApp === "function") window.initApp();
  } else {
    document.getElementById("auth-overlay").hidden = false;
    document.getElementById("app-shell").hidden = true;
    showAuthPanel("login");
  }
});
