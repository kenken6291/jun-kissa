/* =========================================================
   純喫茶・レストラン巡りログ - Code.gs（GASバックエンド）

   構成：
     1. 設定・定数
     2. 共通ユーティリティ（シート操作・レスポンス生成）
     3. 認証まわり（登録・ログイン・パスワード変更/再発行・退会）
     4. セッション管理（CacheService）
     5. 訪問記録CRUD
     6. 写真の保存（Googleドライブ）
     7. Gemini APIでの一言コメント生成
     8. エントリーポイント（doGet / doPost）

   事前準備（スクリプトのプロパティに設定）：
     - SPREADSHEET_ID … データ保存用スプレッドシートのID（未設定ならこのGASに紐づくシートを使用）
     - DRIVE_FOLDER_ID … 写真保存先のGoogleドライブフォルダID（未設定ならマイドライブ直下）
     - GEMINI_API_KEY  … Gemini APIキー
     - PEPPER          … パスワードハッシュ化用の固定文字列（任意の長い文字列でOK）

   デプロイ：
     「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
     アクセスできるユーザー：全員
     発行されたURLをフロント側 auth.js の API_BASE_URL に設定する
   ========================================================= */

/* =========================================================
   1. 設定・定数
   ========================================================= */
var MEMBER_HEADERS = ['id', 'email', 'nickname', 'passwordHash', 'salt', 'isTempPassword', 'failedAttempts', 'lockUntil', 'createdAt'];
var VISIT_HEADERS  = ['id', 'memberId', 'name', 'date', 'menus', 'memo', 'url', 'photoUrl', 'photoFileId', 'lat', 'lng', 'createdAt', 'updatedAt'];
var SESSION_TTL_SEC = 21600; // 6時間（CacheServiceの上限）
var LOCK_THRESHOLD = 5;      // 何回失敗でロックするか
var LOCK_MINUTES = 15;       // ロック時間（分）
var FORGOT_PASSWORD_INTERVAL_SEC = 300; // パスワード再発行：同一メールアドレスへの間隔（秒）

/* 指定キーが直近interval秒以内に使われていなければtrueを返し使用済みにする。
   使われていれば（＝制限時間内）falseを返す。MailApp等の連打防止に使う。 */
function checkAndSetRateLimit_(key, intervalSec) {
  var cache = CacheService.getScriptCache();
  if (cache.get(key)) return false;
  cache.put(key, '1', intervalSec);
  return true;
}

/* =========================================================
   2. 共通ユーティリティ
   ========================================================= */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name, headers) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function rowToObject_(headers, rowArray) {
  var obj = {};
  headers.forEach(function (h, i) { obj[h] = rowArray[i]; });
  return obj;
}

function ok_(data) {
  var body = Object.assign({ ok: true }, data || {});
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function ng_(message) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message })).setMimeType(ContentService.MimeType.JSON);
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* =========================================================
   3. 認証まわり
   ========================================================= */
function generateSalt_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function generateTempPassword_() {
  // 紛らわしい文字（0/O, 1/l/I等）を除いた文字セット
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  var pass = '';
  for (var i = 0; i < 8; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

function hashPassword_(password, salt) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER') || '';
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt + pepper, Utilities.Charset.UTF_8);
  return digest.map(function (b) {
    var v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function findMemberRow_(email) {
  var sheet = getSheet_('Members', MEMBER_HEADERS);
  var data = sheet.getDataRange().getValues();
  var lower = String(email).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    var row = rowToObject_(MEMBER_HEADERS, data[i]);
    if (String(row.email).toLowerCase() === lower) {
      return { row: row, index: i - 1 }; // index は「ヘッダーを除いた」0始まりの行番号
    }
  }
  return null;
}

function appendMemberRow_(member) {
  var sheet = getSheet_('Members', MEMBER_HEADERS);
  sheet.appendRow(MEMBER_HEADERS.map(function (h) { return member[h]; }));
}

function updateMemberRow_(index, updates) {
  var sheet = getSheet_('Members', MEMBER_HEADERS);
  var sheetRow = index + 2; // ヘッダー行 + 1始まり
  Object.keys(updates).forEach(function (key) {
    var col = MEMBER_HEADERS.indexOf(key) + 1;
    if (col > 0) sheet.getRange(sheetRow, col).setValue(updates[key]);
  });
}

function handleRegister_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var nickname = String(body.nickname || '').trim();
  if (!isValidEmail_(email)) return ng_('正しいメールアドレスを入力してください');
  if (!nickname) return ng_('ニックネームを入力してください');
  if (findMemberRow_(email)) return ng_('このメールアドレスは既に登録されています');

  var tempPassword = generateTempPassword_();
  var salt = generateSalt_();
  var member = {
    id: Utilities.getUuid(),
    email: email,
    nickname: nickname,
    passwordHash: hashPassword_(tempPassword, salt),
    salt: salt,
    isTempPassword: 'true',
    failedAttempts: 0,
    lockUntil: '',
    createdAt: new Date().toISOString()
  };
  appendMemberRow_(member);

  try {
    MailApp.sendEmail({
      to: email,
      subject: '【純喫茶・レストラン巡りログ】仮パスワードのお知らせ',
      body: nickname + ' 様\n\n' +
        '純喫茶・レストラン巡りログにご登録いただきありがとうございます。\n' +
        '以下の仮パスワードでログインし、初回ログイン時に新しいパスワードを設定してください。\n\n' +
        '仮パスワード：' + tempPassword + '\n\n' +
        '※このメールに心当たりがない場合は破棄してください。'
    });
  } catch (err) {
    // メール送信に失敗しても登録自体は完了させる
  }

  return ok_({ message: '登録しました。ご入力いただいたメールアドレスに仮パスワードを送信しました。' });
}

function handleLogin_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var password = String(body.password || '');
  if (!email || !password) return ng_('メールアドレスとパスワードを入力してください');

  var found = findMemberRow_(email);
  if (!found) return ng_('メールアドレスまたはパスワードが違います');
  var row = found.row;

  var now = Date.now();
  if (row.lockUntil && Number(row.lockUntil) > now) {
    var remainMin = Math.ceil((Number(row.lockUntil) - now) / 60000);
    return ng_('ログイン試行回数が上限に達しました。' + remainMin + '分後に再度お試しください');
  }

  var hash = hashPassword_(password, row.salt);
  if (hash !== row.passwordHash) {
    var attempts = Number(row.failedAttempts || 0) + 1;
    var updates = { failedAttempts: attempts };
    if (attempts >= LOCK_THRESHOLD) {
      updates.lockUntil = now + LOCK_MINUTES * 60 * 1000;
      updates.failedAttempts = 0;
    }
    updateMemberRow_(found.index, updates);
    return ng_('メールアドレスまたはパスワードが違います');
  }

  updateMemberRow_(found.index, { failedAttempts: 0, lockUntil: '' });

  var token = createSession_(row.id);
  return ok_({
    token: token,
    member: {
      id: row.id,
      email: row.email,
      nickname: row.nickname,
      requiresPasswordChange: String(row.isTempPassword) === 'true'
    }
  });
}

function handleChangePassword_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return ng_('パスワードは8文字以上にしてください');

  var salt = generateSalt_();
  updateMemberRow_(auth.index, {
    passwordHash: hashPassword_(newPassword, salt),
    salt: salt,
    isTempPassword: 'false'
  });
  return ok_({ message: 'パスワードを変更しました' });
}

function handleForgotPassword_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail_(email)) return ng_('正しいメールアドレスを入力してください');

  // レート制限：同一メールアドレスへの再発行リクエストは一定時間に1回まで。
  // 存在チェックより前に判定することで、メールアドレスの存在有無が
  // レスポンスの違いから漏れないようにする。
  if (!checkAndSetRateLimit_('pwreset_' + email, FORGOT_PASSWORD_INTERVAL_SEC)) {
    return ng_('パスワード再発行のリクエストは' + (FORGOT_PASSWORD_INTERVAL_SEC / 60) + '分に1回までです。少し時間をおいて再度お試しください');
  }

  var found = findMemberRow_(email);
  // メールアドレスの存在有無を外部から判別できないよう、常に同じメッセージを返す
  if (!found) {
    return ok_({ message: 'ご登録のメールアドレスであれば、仮パスワードを送信しました' });
  }
  var tempPassword = generateTempPassword_();
  var salt = generateSalt_();
  updateMemberRow_(found.index, {
    passwordHash: hashPassword_(tempPassword, salt),
    salt: salt,
    isTempPassword: 'true',
    failedAttempts: 0,
    lockUntil: ''
  });
  try {
    MailApp.sendEmail({
      to: email,
      subject: '【純喫茶・レストラン巡りログ】仮パスワード再発行のお知らせ',
      body: found.row.nickname + ' 様\n\n' +
        'パスワード再発行のご依頼を受け付けました。\n' +
        '以下の仮パスワードでログインし、新しいパスワードを設定してください。\n\n' +
        '仮パスワード：' + tempPassword
    });
  } catch (err) {}
  return ok_({ message: 'ご登録のメールアドレスであれば、仮パスワードを送信しました' });
}

function handleUpdateNickname_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var nickname = String(body.nickname || '').trim();
  if (!nickname) return ng_('ニックネームを入力してください');
  updateMemberRow_(auth.index, { nickname: nickname });
  return ok_({ message: 'ニックネームを変更しました', nickname: nickname });
}

function handleLogout_(body) {
  if (body.token) CacheService.getScriptCache().remove('session_' + body.token);
  return ok_({ message: 'ログアウトしました' });
}

function handleWithdraw_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');

  // 本人の訪問記録・写真も合わせて削除
  var visitSheet = getSheet_('Visits', VISIT_HEADERS);
  var data = visitSheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var row = rowToObject_(VISIT_HEADERS, data[i]);
    if (row.memberId === auth.row.id) {
      if (row.photoFileId) {
        try { DriveApp.getFileById(row.photoFileId).setTrashed(true); } catch (e) {}
      }
      visitSheet.deleteRow(i + 1);
    }
  }

  var memberSheet = getSheet_('Members', MEMBER_HEADERS);
  memberSheet.deleteRow(auth.index + 2);
  CacheService.getScriptCache().remove('session_' + body.token);
  return ok_({ message: '退会処理が完了しました。ご利用ありがとうございました。' });
}

/* =========================================================
   4. セッション管理（CacheService）
   ========================================================= */
function createSession_(memberId) {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, memberId, SESSION_TTL_SEC);
  return token;
}

function authenticate_(token) {
  if (!token) return null;
  var memberId = CacheService.getScriptCache().get('session_' + token);
  if (!memberId) return null;
  var sheet = getSheet_('Members', MEMBER_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = rowToObject_(MEMBER_HEADERS, data[i]);
    if (row.id === memberId) return { row: row, index: i - 1 };
  }
  return null;
}

/* =========================================================
   5. 訪問記録CRUD
   ========================================================= */
function appendVisitRow_(visit) {
  var sheet = getSheet_('Visits', VISIT_HEADERS);
  sheet.appendRow(VISIT_HEADERS.map(function (h) { return visit[h]; }));
}

function updateVisitRow_(index, updates) {
  var sheet = getSheet_('Visits', VISIT_HEADERS);
  var sheetRow = index + 2;
  Object.keys(updates).forEach(function (key) {
    var col = VISIT_HEADERS.indexOf(key) + 1;
    if (col > 0) sheet.getRange(sheetRow, col).setValue(updates[key]);
  });
}

function handleListVisits_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var sheet = getSheet_('Visits', VISIT_HEADERS);
  var data = sheet.getDataRange().getValues();
  var visits = [];
  for (var i = 1; i < data.length; i++) {
    var row = rowToObject_(VISIT_HEADERS, data[i]);
    if (row.memberId === auth.row.id) {
      row.menus = row.menus ? String(row.menus).split('|||').filter(Boolean) : [];
      visits.push(row);
    }
  }
  return ok_({ visits: visits, nickname: auth.row.nickname });
}

function handleAddVisit_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var v = body.visit || {};
  if (!v.name) return ng_('店名を入力してください');

  var photoUrl = '', photoFileId = '';
  if (v.photoBase64) {
    var saved = savePhotoToDrive_(v.photoBase64, v.photoMime || 'image/jpeg');
    photoUrl = saved.url;
    photoFileId = saved.fileId;
  }

  var now = new Date().toISOString();
  var record = {
    id: Utilities.getUuid(),
    memberId: auth.row.id,
    name: String(v.name).trim(),
    date: v.date || '',
    menus: Array.isArray(v.menus) ? v.menus.join('|||') : '',
    memo: v.memo || '',
    url: v.url || '',
    photoUrl: photoUrl,
    photoFileId: photoFileId,
    lat: v.lat,
    lng: v.lng,
    createdAt: now,
    updatedAt: now
  };
  appendVisitRow_(record);
  record.menus = Array.isArray(v.menus) ? v.menus : [];
  return ok_({ visit: record });
}

function handleUpdateVisit_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var v = body.visit || {};
  if (!v.id) return ng_('idが必要です');

  var sheet = getSheet_('Visits', VISIT_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = rowToObject_(VISIT_HEADERS, data[i]);
    if (row.id === v.id && row.memberId === auth.row.id) {
      var updates = {
        name: String(v.name || row.name).trim(),
        date: v.date != null ? v.date : row.date,
        menus: Array.isArray(v.menus) ? v.menus.join('|||') : row.menus,
        memo: v.memo != null ? v.memo : row.memo,
        url: v.url != null ? v.url : row.url,
        lat: v.lat != null ? v.lat : row.lat,
        lng: v.lng != null ? v.lng : row.lng,
        updatedAt: new Date().toISOString()
      };

      if (v.photoBase64) {
        if (row.photoFileId) { try { DriveApp.getFileById(row.photoFileId).setTrashed(true); } catch (e) {} }
        var saved = savePhotoToDrive_(v.photoBase64, v.photoMime || 'image/jpeg');
        updates.photoUrl = saved.url;
        updates.photoFileId = saved.fileId;
      } else if (v.removePhoto) {
        if (row.photoFileId) { try { DriveApp.getFileById(row.photoFileId).setTrashed(true); } catch (e) {} }
        updates.photoUrl = '';
        updates.photoFileId = '';
      }

      updateVisitRow_(i - 1, updates);
      var merged = Object.assign({}, row, updates);
      merged.menus = Array.isArray(v.menus) ? v.menus : (row.menus ? String(row.menus).split('|||').filter(Boolean) : []);
      return ok_({ visit: merged });
    }
  }
  return ng_('記録が見つかりません');
}

function handleDeleteVisit_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');
  var sheet = getSheet_('Visits', VISIT_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = rowToObject_(VISIT_HEADERS, data[i]);
    if (row.id === body.id && row.memberId === auth.row.id) {
      if (row.photoFileId) { try { DriveApp.getFileById(row.photoFileId).setTrashed(true); } catch (e) {} }
      sheet.deleteRow(i + 1);
      return ok_({ message: '削除しました' });
    }
  }
  return ng_('記録が見つかりません');
}

/* =========================================================
   6. 写真の保存（Googleドライブ）
   ========================================================= */
function savePhotoToDrive_(base64Data, mimeType) {
  var folderId = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
  var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();

  var pureBase64 = base64Data.indexOf(',') > -1 ? base64Data.split(',')[1] : base64Data;
  var bytes = Utilities.base64Decode(pureBase64);
  var ext = mimeType.indexOf('png') > -1 ? 'png' : 'jpg';
  var blob = Utilities.newBlob(bytes, mimeType, 'kissa_' + Date.now() + '.' + ext);

  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  return { fileId: fileId, url: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1024' };
}

/* =========================================================
   7. Gemini APIでの一言コメント生成
   ========================================================= */
function handleGenerateComment_(body) {
  var auth = authenticate_(body.token);
  if (!auth) return ng_('ログインが必要です');

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return ng_('Gemini APIキーが設定されていません');

  var name = String(body.name || '').trim();
  if (!name) return ng_('店名を先に入力してください');
  var menus = Array.isArray(body.menus) ? body.menus.join('、') : '';
  var memo = String(body.memo || '').trim();

  var prompt =
    '喫茶店またはレストラン「' + name + '」を訪れた記録を書いています。' +
    (menus ? '注文したメニューは「' + menus + '」です。' : '') +
    (memo ? 'メモの下書きは「' + memo + '」です。これを踏まえて、' : '') +
    'お店の雰囲気や食事・一杯の余韻が伝わるような、味わい深く詩的な一言メモを日本語で1文だけ、40文字以内で提案してください。' +
    '前置きや記号、鍵括弧は付けず、本文のみを返してください。';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
  var payload = { contents: [{ parts: [{ text: prompt }] }] };

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var json;
  try {
    json = JSON.parse(res.getContentText());
  } catch (e) {
    return ng_('Gemini APIの応答を解析できませんでした');
  }

  var text = json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;

  if (!text) return ng_('AIコメントの生成に失敗しました。しばらくしてから再度お試しください');
  return ok_({ comment: text.trim() });
}

/* =========================================================
   8. エントリーポイント
   ========================================================= */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: '純喫茶・レストラン巡りログ API' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case 'register':         return handleRegister_(body);
      case 'login':             return handleLogin_(body);
      case 'changePassword':    return handleChangePassword_(body);
      case 'forgotPassword':    return handleForgotPassword_(body);
      case 'updateNickname':    return handleUpdateNickname_(body);
      case 'logout':             return handleLogout_(body);
      case 'withdraw':          return handleWithdraw_(body);
      case 'listVisits':        return handleListVisits_(body);
      case 'addVisit':          return handleAddVisit_(body);
      case 'updateVisit':       return handleUpdateVisit_(body);
      case 'deleteVisit':       return handleDeleteVisit_(body);
      case 'generateComment':   return handleGenerateComment_(body);
      default:                  return ng_('不明なactionです: ' + body.action);
    }
  } catch (err) {
    return ng_(err.message || String(err));
  }
}
