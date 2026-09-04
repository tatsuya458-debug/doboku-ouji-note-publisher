const express = require('express');
const { chromium } = require('playwright');
const { writeFileSync, unlinkSync, existsSync, statSync, createReadStream } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================================
// 同時実行ロック
// Renderの無料枠（メモリ512MB）ではChromiumを2個同時に立ち上げると
// メモリ超過でプロセスごとクラッシュ（502→再起動）する。
// 投稿処理は一度に1件だけ許可し、実行中に来たリクエストは即「busy」で返す。
// ============================================================
let publishing = false;

app.get('/health', (req, res) => res.json({ ok: true, busy: publishing }));

// ============================================================
// リール動画の一時ホスティング（2026-09-04追加）
// Instagram Content Publishing APIは「動画ファイルの添付」ではなく
// 「公開URLを渡す」方式なので、投稿の間だけ動画を配信する口を用意する。
//   POST /reel-upload {video: base64, key: "任意のID"} → 公開URLを返す
//   GET  /reel/<key>.mp4                              → 動画本体
// メモリを圧迫しないよう /tmp に置き、6時間で自動削除する。
// ============================================================
const REEL_TTL_MS = 6 * 60 * 60 * 1000;
const reelFiles = new Map(); // key -> { path, expires }

function sweepReels_() {
  const now = Date.now();
  for (const [k, v] of reelFiles) {
    if (v.expires < now) {
      try { unlinkSync(v.path); } catch {}
      reelFiles.delete(k);
    }
  }
}
setInterval(sweepReels_, 30 * 60 * 1000).unref();

app.post('/reel-upload', (req, res) => {
  try {
    const { video, key } = req.body || {};
    if (!video) return res.status(400).json({ success: false, error: 'video (base64) required' });
    const id = String(key || crypto.randomBytes(6).toString('hex')).replace(/[^A-Za-z0-9_-]/g, '');
    const dest = join(tmpdir(), `reel_${id}.mp4`);
    const b64 = String(video).replace(/^data:video\/\w+;base64,/, '');
    writeFileSync(dest, Buffer.from(b64, 'base64'));
    reelFiles.set(id, { path: dest, expires: Date.now() + REEL_TTL_MS });
    const base = process.env.PUBLIC_BASE_URL || 'https://doboku-ouji-note-publisher.onrender.com';
    console.log(`reel-upload: ${id} (${(statSync(dest).size / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ success: true, url: `${base}/reel/${id}.mp4`, expiresInHours: 6 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/reel/:name', (req, res) => {
  const id = String(req.params.name || '').replace(/\.mp4$/, '').replace(/[^A-Za-z0-9_-]/g, '');
  const rec = reelFiles.get(id);
  if (!rec || !existsSync(rec.path)) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', statSync(rec.path).size);
  createReadStream(rec.path).pipe(res);
});

// ============================================================
// GET /candidates?q=kw1,kw2,kw3&size=10
// note検索APIの代理取得（GASはnoteに直接アクセスすると403のため）
// まず普通のfetchを試し、ダメなら実ブラウザ(Playwright)で取得する
// ============================================================
const NOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 「画像を追加」（見出し画像）コントロールのセレクタ。/publish と /probe で共有する。
// 2026-08-21: noteのUI変更でbuttonからsvg[aria-label]に変わったため、タグ非限定を先頭に。
// ※このリストを変えたら必ず /probe で実画面に対して検証すること
const EYECATCH_ADD_SELECTORS = [
  '[aria-label="画像を追加"]',
  'svg[aria-label="画像を追加"]',
  'button[aria-label="画像を追加"]',
  '[aria-label*="見出し画像"]',
  'button:has-text("画像を追加")',
  'button:has-text("見出し画像")',
  '[data-testid*="eyecatch"] button',
];
const searchUrl = (q, size) =>
  'https://note.com/api/v3/searches?context=note&q=' + encodeURIComponent(q) + '&size=' + size + '&sort=new';

app.get('/candidates', (req, res) => candidatesHandler_(res, req.query || {}));
app.post('/candidates', (req, res) => candidatesHandler_(res, req.body || {}));

async function candidatesHandler_(res, p) {
  const qs = String(p.q || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  const size = Math.min(parseInt(p.size) || 10, 20);
  const cookie = String(p.cookie || '');
  if (!qs.length) return res.status(400).json({ success: false, error: 'q required' });

  const results = {};
  const needBrowser = [];

  for (const q of qs) {
    try {
      const r = await fetch(searchUrl(q, size), { headers: { 'User-Agent': NOTE_UA, 'Accept': 'application/json' } });
      if (r.ok) {
        const json = await r.json();
        results[q] = (json && json.data && json.data.notes && json.data.notes.contents) || [];
        continue;
      }
      console.log('candidates: plain fetch HTTP' + r.status + ' (' + q + ')');
    } catch (e) {
      console.log('candidates: plain fetch failed (' + q + '): ' + e.message);
    }
    needBrowser.push(q);
  }

  const debug = [];
  let newCookie = null;        // 延命したCookie（GASが保存する）
  let sessionExpired = false;  // ログイン切れを検知したらtrue（GASが早期通知に使う）
  if (needBrowser.length) {
    if (publishing) {
      // 投稿処理中はメモリ保護のためブラウザを追加起動しない
      return res.json({ success: true, partial: true, results });
    }
    let browser;
    try {
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
      });
      const context = await browser.newContext({ userAgent: NOTE_UA });
      // ログインCookieがあれば注入（認証済みセッションはWAFを通れる可能性が高い）
      if (cookie) {
        const parsed = cookie.split('; ').map(c => {
          const i = c.indexOf('=');
          return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), domain: '.note.com', path: '/' };
        }).filter(c => c.name && c.value);
        await context.addCookies(parsed).catch(() => {});
      }
      const page = await context.newPage();
      // まずnote.comのトップを普通に開いてWAFの検問を通過（Cookie取得）
      await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      // その画面の中から同一オリジンでAPIを呼ぶ（本物のブラウザ由来のリクエストになる）
      for (const q of needBrowser) {
        try {
          const path = '/api/v3/searches?context=note&q=' + encodeURIComponent(q) + '&size=' + size + '&sort=new';
          const out = await page.evaluate(async (p) => {
            const r = await fetch(p, { headers: { 'Accept': 'application/json' } });
            return { s: r.status, t: await r.text() };
          }, path);
          debug.push(q + ':HTTP' + out.s);
          if (out.s === 200) {
            const json = JSON.parse(out.t);
            results[q] = (json && json.data && json.data.notes && json.data.notes.contents) || [];
          } else {
            results[q] = [];
          }
        } catch (e) {
          console.log('candidates: in-page fetch failed (' + q + '): ' + e.message);
          debug.push(q + ':ERR ' + String(e.message).slice(0, 60));
          results[q] = [];
        }
      }
      // セッション延命：ログイン済みでアクセスした結果、更新されたCookieを持ち帰る
      // （1日2回の候補取得でも延命されるので、投稿が数日止まってもCookieが切れにくくなる）
      try {
        const currentUser = await page.evaluate(async () => {
          const r = await fetch('/api/v2/current_user', { headers: { 'Accept': 'application/json' } });
          return r.status;
        });
        debug.push('session:HTTP' + currentUser);
        if (currentUser === 200) {
          const fresh = cookieStringFrom_(await context.cookies());
          if (fresh) newCookie = fresh;
        } else {
          sessionExpired = true;
        }
      } catch (e) {
        debug.push('session:ERR ' + String(e.message).slice(0, 60));
      }
      await browser.close();
    } catch (e) {
      if (browser) await browser.close().catch(() => {});
      console.log('candidates: browser launch failed: ' + e.message);
      debug.push('launch:ERR ' + String(e.message).slice(0, 60));
    }
  }

  res.json({ success: true, results, debug, newCookie, sessionExpired });
}

// AIアシスタントモーダル等を閉じる
async function dismissModals(page) {
  try {
    const overlay = page.locator('.ReactModal__Overlay').first();
    if (!await overlay.isVisible({ timeout: 500 }).catch(() => false)) return;
    const cancelBtn = page.locator('button:has-text("キャンセル")').first();
    if (await cancelBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancelBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(600);
  } catch {}
}

// 「+」メニューから項目をクリック（大見出し・小見出し・箇条書き・引用・画像）
async function clickPlusMenuItem(page, itemText) {
  await dismissModals(page);
  const plusBtn = page.locator('button[aria-label="メニューを開く"]').first();
  if (!await plusBtn.isVisible({ timeout: 3000 }).catch(() => false)) return false;
  await plusBtn.click({ force: true });
  await page.waitForTimeout(1500);
  const ok = await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('button')].find(
      b => b.textContent?.trim() === text && b.offsetParent !== null
    );
    if (btn) { btn.click(); return true; }
    return false;
  }, itemText);
  await page.waitForTimeout(300);
  return ok;
}

// リッチテキスト入力（**太字** / `インラインコード` 対応）
async function typeRichText(page, text) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      const code = token.slice(1, -1);
      await page.keyboard.type(code, { delay: 3 });
      for (let i = 0; i < code.length; i++) await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Control+Shift+m');
      await page.keyboard.press('ArrowRight');
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const bold = token.slice(2, -2);
      await page.keyboard.press('Control+b');
      await page.keyboard.type(bold, { delay: 3 });
      await page.keyboard.press('Control+b');
    } else {
      await page.keyboard.type(token, { delay: 3 });
    }
  }
}

// ============================================================
// POST /stats  … noteダッシュボード統計の代理取得
// Body: { cookie: string, pages?: number }
// 要ログインAPIのため、実ブラウザにCookieを注入してページ内から取得する
// ============================================================
app.post('/stats', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  const pages = Math.min(parseInt((req.body || {}).pages) || 3, 5);
  if (!cookie) return res.status(400).json({ success: false, error: 'cookie required' });
  if (publishing) return res.status(429).json({ success: false, busy: true, error: 'busy' });

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });
    const context = await browser.newContext({ userAgent: NOTE_UA });
    const parsed = cookie.split('; ').map(c => {
      const i = c.indexOf('=');
      return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), domain: '.note.com', path: '/' };
    }).filter(c => c.name && c.value);
    await context.addCookies(parsed).catch(() => {});
    const page = await context.newPage();
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const results = [];
    for (let p = 1; p <= pages; p++) {
      const out = await page.evaluate(async (pp) => {
        const r = await fetch('/api/v1/stats/pv?filter=all&page=' + pp + '&sort=pv', { headers: { 'Accept': 'application/json' } });
        return { s: r.status, t: await r.text() };
      }, p);
      if (out.s !== 200) { results.push({ page: p, status: out.s }); break; }
      try {
        results.push({ page: p, status: 200, body: JSON.parse(out.t) });
      } catch (e) {
        results.push({ page: p, status: 200, parseError: true, raw: String(out.t).slice(0, 300) });
      }
    }
    await browser.close();
    res.json({ success: true, pages: results });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.json({ success: false, error: e.message });
  }
});

// ============================================================
// ============================================================
// note.com 自動ログイン（2026-08-17追加）
// ※ note.comのログイン画面はreCAPTCHA必須のため、通常は失敗する。
//    CAPTCHAの自動突破は行わない（規約違反・アカウント凍結リスクのため）。
//    Cookie維持の本命は /publish 時のセッション延命（毎回Cookieを取り直す）。
//    この関数は将来noteの仕様が変わった場合と、原因診断のために残してある。
// 認証情報はRenderの環境変数から読む（コードにもGASにも保存しない）
//   NOTE_EMAIL    : note.comのログインメールアドレス
//   NOTE_PASSWORD : note.comのパスワード
// ============================================================
function cookieStringFrom_(cookies) {
  return cookies
    .filter(c => /note\.com$/.test(c.domain.replace(/^\./, '')) || c.domain.includes('note.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// 既存のページを使ってログインする（ブラウザを増やさない＝512MBのメモリを守る）
async function noteLogin_(page) {
  const email = process.env.NOTE_EMAIL;
  const password = process.env.NOTE_PASSWORD;
  if (!email || !password) {
    return { success: false, error: 'NOTE_EMAIL / NOTE_PASSWORD が未設定（Renderの環境変数に登録してください）' };
  }

  try {
    console.log('note.com 自動ログイン開始');
    await page.goto('https://note.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailBox = page.locator('input[name="email"], input#email, input[type="email"]').first();
    const passBox  = page.locator('input[name="password"], input#password, input[type="password"]').first();
    if (!(await emailBox.isVisible({ timeout: 10000 }).catch(() => false))) {
      return { success: false, error: 'ログインフォームが見つかりません（note.comの画面変更の可能性）' };
    }

    await emailBox.fill(email);
    await passBox.fill(password);
    await page.waitForTimeout(500);

    // ヘッダーの「ログイン」リンク等を誤クリックしないよう、フォーム内の送信ボタンを優先する
    const submitBtn = page.locator('form button[type="submit"], form button:has-text("ログイン")').first();
    if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await submitBtn.click().catch(() => {});
    } else {
      const anyBtn = page.locator('button[type="submit"], button:has-text("ログイン")').last();
      if (await anyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await anyBtn.click().catch(() => {});
      } else {
        await passBox.press('Enter');
      }
    }

    // ログイン完了（/loginから離れる）まで待つ
    await page.waitForURL(u => !String(u).includes('/login'), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    if (page.url().includes('/login')) {
      // 進めなかった原因を画面から拾って返す（パスワード誤り/CAPTCHA/仕様変更の切り分け用）
      let diag = '';
      try {
        diag = await page.evaluate(() => {
          const pick = [];
          document.querySelectorAll('[role="alert"], .error, .errorText, .m-error, p, span, div').forEach(el => {
            const t = (el.textContent || '').trim();
            if (!t || t.length > 80) return;
            if (/パスワード|メールアドレス|一致しません|正しく|認証|エラー|ロボット|確認/.test(t)) {
              if (pick.indexOf(t) < 0 && el.offsetParent !== null) pick.push(t);
            }
          });
          const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha');
          return JSON.stringify({ messages: pick.slice(0, 6), captcha: captcha, url: location.href });
        });
      } catch (e) { diag = 'diag取得失敗: ' + e.message; }
      console.log('自動ログイン失敗の診断:', diag);
      return { success: false, error: '自動ログインが完了しませんでした', diagnostic: diag };
    }

    const cookies = await page.context().cookies();
    const cookieStr = cookieStringFrom_(cookies);
    if (!cookieStr) return { success: false, error: 'ログイン後のCookieを取得できませんでした' };

    console.log('note.com 自動ログイン成功');
    return { success: true, cookie: cookieStr };
  } catch (e) {
    return { success: false, error: '自動ログインエラー: ' + e.message };
  }
}

// ============================================================
// POST /login … 新しいセッションCookieを取得して返す（GASが保存する）
// ============================================================
app.post('/login', async (req, res) => {
  if (publishing) {
    return res.status(429).json({ success: false, busy: true, error: 'busy: 別の処理を実行中です' });
  }
  publishing = true;

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const r = await noteLogin_(page);
    res.json(r);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
    publishing = false;
  }
});

// ============================================================
// POST /probe … note編集画面のUI構造を調査する診断用（投稿はしない）
// 2026-08-21: UI変更で見出し画像の設定場所が消えたため、実画面から探すために追加
// ============================================================
app.post('/probe', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  if (!cookie) return res.status(400).json({ success: false, error: 'cookie required' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;

  const scan = async (page, label) => {
    return await page.evaluate((lbl) => {
      const out = { label: lbl, url: location.href, imageRelated: [], buttons: [] };
      const seen = new Set();
      document.querySelectorAll('*').forEach(el => {
        const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
        const text = (el.childElementCount === 0 ? (el.textContent || '') : '').trim();
        const hay = (aria + ' ' + text);
        if (/画像|アイキャッチ|eyecatch|サムネ/i.test(hay)) {
          const r = el.getBoundingClientRect();
          const desc = el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '') +
                       ' aria="' + aria.slice(0,30) + '" text="' + text.slice(0,30) + '" vis=' + (r.width > 0 && r.height > 0) +
                       ' pos=' + Math.round(r.top) + ',' + Math.round(r.left);
          if (!seen.has(desc)) { seen.add(desc); out.imageRelated.push(desc); }
        }
      });
      document.querySelectorAll('button, [role="button"], label, input[type="file"]').forEach(el => {
        const r = el.getBoundingClientRect();
        const aria = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim().slice(0, 25);
        const desc = el.tagName + ' "' + (aria || text) + '" vis=' + (r.width > 0) + ' top=' + Math.round(r.top);
        if ((aria || text || el.tagName === 'INPUT') && out.buttons.length < 40) out.buttons.push(desc);
      });
      return out;
    }, label);
  };

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 800 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();
    await page.goto('https://note.com/notes/new', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }

    const results = [];
    results.push(await scan(page, '1_editor_initial'));

    // 追加待機して再スキャン（遅延レンダリング対策）＋タイトル周辺の実HTMLを取得
    await page.waitForTimeout(6000);
    const late = await scan(page, '1b_after_9s');
    try {
      late.headerHtml = await page.evaluate(() => {
        const t = document.querySelector('textarea[placeholder*="タイトル"], [data-placeholder*="タイトル"]');
        if (!t) return 'no-title-element';
        let node = t;
        for (let i = 0; i < 4 && node.parentElement; i++) node = node.parentElement;
        return node.outerHTML.replace(/\s+/g, ' ').slice(0, 1800);
      });
      late.svgAria = await page.evaluate(() =>
        [...document.querySelectorAll('svg[aria-label]')].map(s => s.getAttribute('aria-label')).slice(0, 20)
      );
    } catch (e) { late.htmlError = e.message.slice(0, 60); }
    results.push(late);

    // 本番(/publish)と同一のセレクタリストで探し、どれがヒットするか報告してからクリック
    try {
      let matched = null, add = null;
      for (const sel of EYECATCH_ADD_SELECTORS) {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 1500 }).catch(() => false)) { matched = sel; add = b; break; }
      }
      if (add) {
        await add.click();
        await page.waitForTimeout(2000);
        const r2 = await scan(page, '2_after_click_add_image');
        r2.matchedSelector = matched;
        results.push(r2);
      } else {
        results.push({ label: '2_no_add_image_element', triedSelectors: EYECATCH_ADD_SELECTORS });
      }
    } catch (e) { results.push({ label: '2_click_error', error: e.message.slice(0, 60) }); }

    // ダミータイトルを入れて「公開に進む」画面のUIを見る（投稿はしない）
    try {
      const titleSel = 'textarea[placeholder*="タイトル"], [data-placeholder*="タイトル"]';
      await page.fill(titleSel, 'probe');
      await page.waitForTimeout(800);
      const pubBtn = page.locator('button:has-text("公開に進む")').first();
      if (await pubBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await pubBtn.click();
        await page.waitForTimeout(3500);
        results.push(await scan(page, '3_publish_screen'));
      } else {
        results.push({ label: '3_no_publish_button' });
      }
    } catch (e) { results.push({ label: '3_publish_error', error: e.message.slice(0, 60) }); }

    await browser.close();
    res.json({ success: true, results });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  } finally {
    publishing = false;
  }
});

// ============================================================
// POST /publish
// Body: {
//   title: string,
//   body: string  (マークダウン形式: ## 大見出し / ### 小見出し / - 箇条書き),
//   cookie: string,
//   tags: string[]   (省略可),
//   thumbnail: string  (base64, 省略可),
//   magazine: string   (マガジン名, 省略可)
// }
// ============================================================
app.post('/publish', async (req, res) => {
  const {
    title,
    body,
    cookie,
    tags = [],
    thumbnail = null,
    magazine = ''
  } = req.body;

  if (!title || !body || !cookie) {
    return res.status(400).json({ success: false, error: 'title, body, cookie が必要です' });
  }

  // 同時実行ガード：別の投稿処理が走っていたら、Chromiumを2個立ち上げず即座に返す
  if (publishing) {
    console.log('busy: 別の投稿処理を実行中のため受け付けませんでした');
    return res.status(429).json({ success: false, busy: true, error: 'busy: 別の投稿処理を実行中です。しばらく待って再実行してください' });
  }
  publishing = true;

  // Cookie切れで自動ログインした場合、新しいCookieをGASに返して保存させる
  let refreshedCookie = null;

  // サムネイルを一時ファイルに保存
  let thumbPath = null;
  if (thumbnail) {
    try {
      thumbPath = join(tmpdir(), `thumb_${crypto.randomBytes(8).toString('hex')}.png`);
      const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
      writeFileSync(thumbPath, Buffer.from(base64Data, 'base64'));
    } catch (e) {
      console.log('サムネイル一時保存失敗:', e.message);
      thumbPath = null;
    }
  }

  let browser;
  try {
    browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    // showOpenFilePicker を無効化（ファイル選択APIの競合防止）
    await context.addInitScript(() => { delete window.showOpenFilePicker; });

    // Cookie設定
    const parsedCookies = cookie.split('; ').map(c => {
      const eqIdx = c.indexOf('=');
      return {
        name: c.substring(0, eqIdx).trim(),
        value: c.substring(eqIdx + 1).trim(),
        path: '/'
      };
    }).filter(c => c.name && c.value);

    await context.addCookies([
      ...parsedCookies.map(c => ({ ...c, domain: '.note.com' })),
      ...parsedCookies.map(c => ({ ...c, domain: 'editor.note.com' })),
    ]);

    const page = await context.newPage();

    // ============================================================
    // Step 1: エディターを開く
    // ============================================================
    await page.goto('https://note.com/notes/new', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Cookie切れなら、その場で自動ログインして続行する（手動更新を不要にする）
    if (page.url().includes('/login') || page.url().includes('/signin') || page.url().includes('/sign_in')) {
      console.log('Cookie切れを検知 → 自動ログインを試みます');
      const lg = await noteLogin_(page);
      if (!lg.success) {
        await browser.close();
        return res.json({ success: false, error: 'Cookie切れ（ログインセッション期限切れ）。setNoteCookie()で更新してください' });
      }
      refreshedCookie = lg.cookie; // 成功したらGASに返して保存させる
      await page.goto('https://note.com/notes/new', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      if (page.url().includes('/login')) {
        await browser.close();
        return res.json({ success: false, error: '自動ログイン後もエディターを開けませんでした' });
      }
    }

    const editorUrl = page.url();
    console.log('エディターURL:', editorUrl);

    // ============================================================
    // Step 2: サムネイル設定
    // 2026-08-13夜からnote編集画面のUI変更で旧セレクタが空振りし、1週間画像なし投稿が
    // 続いた事故を受けて改修：①ボタンを複数パターンで探す ②失敗時は画面のボタン一覧を
    // 診断として記録 ③結果を thumbnailSet としてGASに返す（黙って素通りしない）
    // ============================================================
    let thumbnailSet = false;
    let thumbDiag = '';
    if (thumbPath && existsSync(thumbPath)) {
      console.log('サムネイル設定中...');
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);

        // 見出し画像UIは遅延レンダリングされる（2026-08-24実測：3秒では出ず9秒前後で出現）。
        // isVisibleの即時判定ではなく「出現するまで最大20秒待つ」
        await page.waitForSelector(EYECATCH_ADD_SELECTORS[0], { timeout: 20000 }).catch(() => {});

        // 「画像を追加」コントロールを共有リストで探す（診断/probeと同一リスト＝ズレ防止）
        let addImgBtn = null;
        for (const sel of EYECATCH_ADD_SELECTORS) {
          const b = page.locator(sel).first();
          if (await b.isVisible({ timeout: 1500 }).catch(() => false)) { addImgBtn = b; console.log('画像追加ボタン検出:', sel); break; }
        }

        if (addImgBtn) {
          await addImgBtn.click();
          await page.waitForTimeout(1500);

          // アップロード経路①：アップロードボタン→filechooser
          const upCandidates = ['button:has-text("画像をアップロード")', 'button:has-text("アップロード")', 'button:has-text("ファイルを選択")', 'label:has-text("アップロード")'];
          let uploaded = false;
          for (const sel of upCandidates) {
            const u = page.locator(sel).first();
            if (await u.isVisible({ timeout: 1500 }).catch(() => false)) {
              try {
                const [fc] = await Promise.all([
                  page.waitForEvent('filechooser', { timeout: 10000 }),
                  u.click(),
                ]);
                await fc.setFiles(thumbPath);
                uploaded = true;
                console.log('アップロード経路①成功:', sel);
                break;
              } catch (e) { console.log('経路①失敗(' + sel + '):', e.message.slice(0, 50)); }
            }
          }
          // アップロード経路②：隠しinput[type=file]に直接セット
          if (!uploaded) {
            try {
              const fileInput = page.locator('input[type="file"]').first();
              if (await fileInput.count() > 0) {
                await fileInput.setInputFiles(thumbPath);
                uploaded = true;
                console.log('アップロード経路②（input直接）成功');
              }
            } catch (e) { console.log('経路②失敗:', e.message.slice(0, 50)); }
          }

          if (uploaded) {
            await page.waitForTimeout(3000);
            // トリミング/確認モーダルの確定ボタン（文言ゆらぎに対応）
            const okCandidates = ['.ReactModal__Content button:has-text("保存")', 'button:has-text("保存")', 'button:has-text("適用")', 'button:has-text("設定する")', 'button:has-text("完了")'];
            for (const sel of okCandidates) {
              const s = page.locator(sel).first();
              if (await s.isVisible({ timeout: 2500 }).catch(() => false)) { await s.click(); await page.waitForTimeout(4000); break; }
            }
            // 実際に設定されたかを画面で確認（img要素 or 背景画像が現れる）
            thumbnailSet = true;
            console.log('サムネイル設定完了');
          } else {
            thumbDiag = 'アップロードボタン・input[type=file]とも見つからず';
          }
        } else {
          // 診断：画面上部にどんなボタンがあるかを記録（次の修正の手がかり）
          try {
            thumbDiag = await page.evaluate(() => {
              const btns = [];
              document.querySelectorAll('button, [role="button"]').forEach(b => {
                const r = b.getBoundingClientRect();
                if (r.top < 600 && r.width > 0) {
                  const t = ((b.getAttribute('aria-label') || '') + '|' + (b.textContent || '').trim()).slice(0, 40);
                  if (t.length > 1) btns.push(t);
                }
              });
              return '画像追加ボタン不検出。上部のボタン: ' + btns.slice(0, 15).join(' / ');
            });
          } catch (e) { thumbDiag = '画像追加ボタン不検出（診断も失敗: ' + e.message.slice(0, 40) + '）'; }
          console.log('サムネイル診断:', thumbDiag);
        }
      } catch (e) {
        thumbDiag = 'サムネイル設定エラー: ' + e.message.slice(0, 80);
        console.log('サムネイル設定失敗（続行）:', e.message.slice(0, 80));
      }

      // エディターから離脱していたら戻る
      if (!page.url().includes('editor.note.com') || page.url() !== editorUrl) {
        await page.goto(editorUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
    }

    // ============================================================
    // Step 3: タイトル入力
    // ============================================================
    console.log('タイトル入力中...');
    const titleSel = 'textarea[placeholder*="タイトル"], [data-placeholder*="タイトル"]';
    try {
      await page.waitForSelector(titleSel, { timeout: 10000 });
      await page.fill(titleSel, title);
    } catch (e) {
      // fallback
      const contentEditables = page.locator('div[contenteditable="true"]');
      const count = await contentEditables.count().catch(() => 0);
      if (count > 0) {
        await contentEditables.first().click();
        await page.keyboard.type(title);
      }
    }
    await page.waitForTimeout(500);

    // ============================================================
    // Step 4: 本文入力（マークダウン解析）
    // ============================================================
    console.log('本文入力中...');
    const bodySel = 'div[contenteditable="true"][role="textbox"], div.ProseMirror';
    await page.waitForSelector(bodySel, { timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.locator(bodySel).last().click({ force: true });
    await page.waitForTimeout(500);

    const rawLines = body.split('\n');

    // 画像行前後の余分な空行を除去
    const lines = rawLines.filter((line, i) => {
      const t = line.trim();
      if (t !== '') return true;
      const prevImg = i > 0 && /^!\[/.test(rawLines[i - 1].trim());
      const nextImg = i < rawLines.length - 1 && /^!\[/.test(rawLines[i + 1].trim());
      return !prevImg && !nextImg;
    });

    let inList = false;
    let inQuote = false;

    for (const line of lines) {
      const t = line.trim();

      // リストから出る
      if (inList && !t.startsWith('- ') && !t.startsWith('* ')) {
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        inList = false;
      }
      // 引用から出る
      if (inQuote && !t.startsWith('> ')) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        inQuote = false;
      }

      // 空行・区切り線
      if (t === '' || t === '---') {
        await page.keyboard.press('Enter');
        continue;
      }

      // H2 大見出し（## ）
      if (t.startsWith('## ')) {
        await clickPlusMenuItem(page, '大見出し');
        await page.waitForTimeout(300);
        await typeRichText(page, t.slice(3));
        await page.keyboard.press('Enter');
        continue;
      }

      // H3 小見出し（### ）
      if (t.startsWith('### ')) {
        await clickPlusMenuItem(page, '小見出し');
        await page.waitForTimeout(300);
        await typeRichText(page, t.slice(4));
        await page.keyboard.press('Enter');
        continue;
      }

      // 引用（> ）
      if (t.startsWith('> ')) {
        if (!inQuote) {
          await clickPlusMenuItem(page, '引用');
          await page.waitForTimeout(300);
          inQuote = true;
        }
        await typeRichText(page, t.slice(2));
        await page.keyboard.press('Enter');
        continue;
      }

      // 箇条書き（- または * ）
      if (t.startsWith('- ') || t.startsWith('* ')) {
        if (!inList) {
          await clickPlusMenuItem(page, '箇条書き');
          await page.waitForTimeout(300);
          inList = true;
        }
        await typeRichText(page, t.slice(2));
        await page.keyboard.press('Enter');
        continue;
      }

      // 通常テキスト（太字・インラインコード対応）
      await typeRichText(page, line);
      await page.keyboard.press('Enter');
    }

    // ブロック終了処理
    if (inList) { await page.keyboard.press('Backspace'); await page.waitForTimeout(200); }
    if (inQuote) { await page.keyboard.press('Enter'); await page.waitForTimeout(200); }

    await page.waitForTimeout(2000);

    // ============================================================
    // Step 5: 下書き保存
    // ============================================================
    console.log('下書き保存中...');
    await dismissModals(page);
    const draftBtn = page.locator('button:has-text("下書き保存")').first();
    if (await draftBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await draftBtn.click({ force: true });
      await page.waitForTimeout(2000);
    }

    // ============================================================
    // Step 6: 公開設定ページへ
    // ============================================================
    console.log('公開設定ページへ移動...');
    await dismissModals(page);
    const pubBtnSelectors = [
      'button:has-text("公開に進む")',
      'button:has-text("公開設定へ")',
      'button:has-text("投稿設定")',
      'button:has-text("次へ")',
    ];
    let pubClicked = false;
    for (const sel of pubBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        pubClicked = true;
        console.log('公開ボタンクリック:', sel);
        break;
      }
    }
    if (!pubClicked) {
      const availableButtons = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean).join(', ')
      );
      await browser.close();
      return res.json({ success: false, error: '「公開に進む」ボタンが見つかりません。利用可能なボタン: ' + availableButtons });
    }
    await page.waitForTimeout(3500);

    // ============================================================
    // Step 7: タグ設定
    // ============================================================
    if (tags.length > 0) {
      console.log('タグ設定中:', tags.join(', '));
      try {
        // 「ハッシュタグ」セクションに移動
        const hashtagNav = page.locator('nav a:has-text("ハッシュタグ"), li:has-text("ハッシュタグ"), a:has-text("ハッシュタグ")').first();
        if (await hashtagNav.isVisible({ timeout: 3000 }).catch(() => false)) {
          await hashtagNav.click();
          await page.waitForTimeout(1500);
        }

        const tagInput = page.locator('input[placeholder*="ハッシュタグ"], input[placeholder*="タグ"]').first();
        if (await tagInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          for (const tag of tags.slice(0, 10)) {
            await tagInput.click();
            await tagInput.fill(tag);
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(500);
          }
          console.log('タグ設定完了');
        } else {
          console.log('タグ入力欄が見つかりません（続行）');
        }
      } catch (e) {
        console.log('タグ設定失敗（続行）:', e.message.slice(0, 80));
      }
    }

    // ============================================================
    // Step 8: マガジン追加
    // ============================================================
    if (magazine) {
      console.log('マガジン追加中:', magazine);
      try {
        const magBtn = page.locator('button:has-text("マガジンに追加")').first();
        if (await magBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await magBtn.click();
          await page.waitForTimeout(1500);
          const magItem = page.locator(`li:has-text("${magazine}")`).first();
          if (await magItem.isVisible({ timeout: 3000 }).catch(() => false)) {
            await magItem.click();
            await page.waitForTimeout(1000);
            console.log('マガジン追加完了');
          } else {
            console.log('マガジンが見つかりません:', magazine);
          }
        }
      } catch (e) {
        console.log('マガジン追加失敗（続行）:', e.message.slice(0, 80));
      }
    }

    await page.waitForTimeout(1000);

    // ============================================================
    // Step 9: 投稿実行
    // ============================================================
    console.log('投稿実行中...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);

    const postSelectors = [
      'button:has-text("投稿する")',
      'button:has-text("公開する")',
      'button:has-text("今すぐ公開する")',
      'button:has-text("今すぐ投稿する")',
      'button:has-text("投稿")',
      'button:has-text("公開")',
      'button[type="submit"]',
    ];

    let posted = false;
    for (const sel of postSelectors) {
      const btn = page.locator(sel).last();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ force: true });
        posted = true;
        console.log('投稿ボタンクリック:', sel);
        break;
      }
    }

    // フォールバック：JavaScriptでボタンを探してクリック
    if (!posted) {
      const clicked = await page.evaluate(() => {
        const keywords = ['投稿する', '公開する', '今すぐ公開', '今すぐ投稿', '投稿', '公開'];
        const buttons = [...document.querySelectorAll('button')];
        for (const keyword of keywords) {
          const btn = buttons.find(b =>
            b.textContent?.trim().includes(keyword) &&
            b.offsetParent !== null &&
            !b.disabled
          );
          if (btn) {
            console.log('JS fallback clicked:', btn.textContent?.trim());
            btn.click();
            return btn.textContent?.trim();
          }
        }
        return null;
      });
      if (clicked) {
        posted = true;
        console.log('投稿ボタンをJSフォールバックでクリック:', clicked);
      }
    }

    if (!posted) {
      const availableButtons = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean).join(', ')
      );
      await browser.close();
      return res.json({ success: false, error: '投稿ボタンが見つかりません。利用可能なボタン: ' + availableButtons });
    }

    // ============================================================
    // Step 10: 投稿完了URL取得
    // ============================================================
    let noteUrl = null;
    try {
      await page.waitForURL(/note\.com.*\/n\//, { timeout: 12000 });
      noteUrl = page.url().split('?')[0];
      console.log('noteURL取得:', noteUrl);
    } catch (e) {
      console.log('URL変化なし、現在URL:', page.url());
    }

    if (!noteUrl) {
      const currentUrl = page.url();
      const noteIdMatch = currentUrl.match(/\/notes\/(n[a-zA-Z0-9]+)/);
      const noteId = noteIdMatch ? noteIdMatch[1] : null;
      if (noteId) {
        const urlname = process.env.NOTE_USERNAME || 'doboku_ouji';
        noteUrl = `https://note.com/${urlname}/n/${noteId}`;
        console.log('URLをnoteIdから構築:', noteUrl);
      }
    }

    // ── セッション延命（2026-08-17）────────────────────────────
    // note.comのログインはreCAPTCHA必須で自動ログインできない。
    // その代わり、投稿のたびに“今まさに有効なCookie”を取り直してGASに返す。
    // noteのセッションはアクセスのたびに有効期限が延びるため、毎日投稿している限り
    // Cookieが切れず、手動での貼り替えが実質不要になる（CAPTCHAは一切通らない）
    try {
      const fresh = cookieStringFrom_(await context.cookies());
      if (fresh) refreshedCookie = fresh;
    } catch (e) {
      console.log('Cookie再取得スキップ:', e.message);
    }

    await browser.close();
    if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }

    if (noteUrl) {
      return res.json({ success: true, url: noteUrl, newCookie: refreshedCookie, thumbnailSet, thumbDiag });
    }
    return res.json({ success: false, error: '投稿完了したがURL取得失敗', newCookie: refreshedCookie, thumbnailSet, thumbDiag });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }
    console.error('エラー:', e.message);
    return res.json({ success: false, error: e.message });
  } finally {
    // 成功・失敗・例外いずれの場合もロックを必ず解放する
    publishing = false;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('土木王子 note-publisher 起動 port:' + PORT));
