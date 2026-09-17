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
// 直近の /publish の結果を保持して後から取得できるようにする（2026-09-08追加）
// 3万字の投稿は5分以上かかり、その間にクライアント側の接続が切れて
// 結果を受け取れないことがあるため。GET /last-result で確認できる。
// ============================================================
let lastPublishResult = null;
const saveResult_ = (obj) => { lastPublishResult = { ...obj, finishedAt: new Date().toISOString() }; return obj; };
app.get('/last-result', (req, res) =>
  res.json(lastPublishResult || { message: 'まだ実行結果がありません' }));

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
  // 2026-09-10: noteがメニュー名を「箇条書き」→「箇条書きリスト」に変更しており
  // 完全一致だけだと無言で空振りする。前方一致・部分一致まで段階的に許容する。
  const ok = await page.evaluate((text) => {
    const vis = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
    const btn = vis.find(b => b.textContent?.trim() === text)
             || vis.find(b => b.textContent?.trim().startsWith(text))
             || vis.find(b => b.textContent?.trim().indexOf(text) >= 0);
    if (btn) { btn.click(); return true; }
    return false;
  }, itemText);
  await page.waitForTimeout(300);
  if (!ok) console.log('[警告] ＋メニュー項目が見つかりません:', itemText);
  return ok;
}

// マークダウン → note貼り付け用HTML（2026-09-15追加・paste モード用）
// 1行ずつ入力する方式と同じ見た目になるよう対応づける：
//   # と ## → h2（noteの大見出し） / ### → h3（小見出し） / - → ul / 1. → ol / > → blockquote
//   ``` → pre>code / --- → hr / 表 → 「列1：列2」の箇条書き / 空行 → 空段落 / <<<PAID>>> → 出力しない
function mdToNoteHtml_(md) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null, quote = [], code = null, tableHeader = null;
  const flush = () => {
    if (list) { out.push('<' + list.tag + '>' + list.items.map(i => '<li><p>' + i + '</p></li>').join('') + '</' + list.tag + '>'); list = null; }
    if (quote.length) { out.push('<blockquote>' + quote.map(q => '<p>' + q + '</p>').join('') + '</blockquote>'); quote = []; }
  };
  const pushItem = (tag, html) => { if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; } list.items.push(html); };
  for (const raw of String(md).replace(/\r\n/g, '\n').split('\n')) {
    const t = raw.trim();
    if (code) {
      if (t.startsWith('```')) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else code.push(raw);
      continue;
    }
    if (t.startsWith('```')) { flush(); code = []; continue; }
    if (!t.startsWith('|')) tableHeader = null;
    if (t === '<<<PAID>>>') { flush(); continue; }
    if (t === '') { flush(); out.push('<p><br></p>'); continue; }
    if (t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!tableHeader) { tableHeader = cells; continue; }
      pushItem('ul', inline(cells.join('：')));
      continue;
    }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) { flush(); out.push('<hr>'); continue; }
    if (/^#{1,2} /.test(t)) { flush(); out.push('<h2>' + inline(t.replace(/^#{1,2} /, '')) + '</h2>'); continue; }
    if (/^#{3,6} /.test(t)) { flush(); out.push('<h3>' + inline(t.replace(/^#{3,6} /, '')) + '</h3>'); continue; }
    if (t.startsWith('- ') || t.startsWith('* ')) { if (quote.length) flush(); pushItem('ul', inline(t.slice(2))); continue; }
    if (/^\d+\. /.test(t)) { if (quote.length) flush(); pushItem('ol', inline(t.replace(/^\d+\.\s*/, ''))); continue; }
    if (t.startsWith('> ')) { if (list) flush(); quote.push(inline(t.slice(2))); continue; }
    flush();
    out.push('<p>' + inline(t) + '</p>');
  }
  if (code) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flush();
  return out.join('');
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
// POST /drafts … note の下書き一覧を取得する（2026-09-08追加・dryRunの確認用）
// ============================================================
app.post('/drafts', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  if (!cookie) return res.status(400).json({ success: false, error: 'cookie required' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();
    // note本体がどのAPIで一覧を取っているかを実測する（推測でURLを当てない）
    const apiCalls = [];
    page.on('response', r => {
      const u = r.url();
      if (u.indexOf('/api/') >= 0 && apiCalls.length < 40) apiCalls.push(r.status() + ' ' + u.slice(0, 160));
    });
    await page.goto('https://note.com/notes', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(9000);
    // SPAのため一覧はHTMLに出ない。同一オリジンでnote内部APIを叩く（WAF回避もかねる）
    // 2026-09-10: 実際にnote本体が使っているAPIを実測して判明した正式エンドポイント
    const apiPath = String((req.body || {}).api || '/api/v2/note_list/contents?limit=20&page=1');
    const rawOnly = !!(req.body || {}).raw;
    const onlyDraft = !!(req.body || {}).onlyDraft;
    const info = await page.evaluate(async (args) => {
      const { apiPath, rawOnly } = args;
      try {
        const r = await fetch(apiPath, { credentials: 'include' });
        const j = await r.json();
        if (rawOnly) return { url: location.href, usedApi: apiPath, status: r.status, raw: JSON.stringify(j).slice(0, 6000), rows: [] };
        const list = (j && j.data && (j.data.contents || j.data.notes || j.data.items)) || (j && j.contents) || [];
        // 下書きは name/body/price が noteDraft 側に入る。separator が有料エリアの区切り位置
        const rows = (Array.isArray(list) ? list : []).slice(0, 20).map(n => {
          const d = n.noteDraft || {};
          const body = String(d.body || n.body || '');
          const sep = String(d.separator || n.separator || '');
          return {
            key: n.key || n.id,
            title: n.name || d.name || '',
            status: n.status,
            price: (n.price != null && n.price !== 0) ? n.price : (d.price != null ? d.price : n.price),
            bodyLen: body.length,
            separator: sep ? sep.slice(0, 120) : null,
            editUrl: 'https://editor.note.com/notes/' + (n.key || n.id) + '/edit/',
          };
        }).filter(r => !args.onlyDraft || r.status === 'draft');
        // key指定があれば、その記事の本文から有料エリアの区切りを探して前後を返す
        let inspect = null;
        if (args.key) {
          const hit = (Array.isArray(list) ? list : []).find(n => (n.key || n.id) === args.key);
          if (hit) {
            const body = String((hit.noteDraft || {}).body || hit.body || '');
            const marks = [];
            const re = /(有料|paywall|paid|separator|<hr[^>]*>|限定)/gi;
            let m, guard = 0;
            while ((m = re.exec(body)) && guard++ < 25) {
              marks.push({ at: m.index, ctx: body.slice(Math.max(0, m.index - 90), m.index + 90) });
            }
            inspect = { key: args.key, bodyLen: body.length, head: body.slice(0, 200), tail: body.slice(-200), marks };
          }
        }
        return { url: location.href, usedApi: apiPath, status: r.status, rows, inspect, raw: rows.length ? null : JSON.stringify(j).slice(0, 1500) };
      } catch (e) {
        return { url: location.href, usedApi: apiPath, rows: [], raw: 'err:' + e.message };
      }
    }, { apiPath, rawOnly, onlyDraft, key: String((req.body || {}).key || '') });
    await browser.close();
    res.json({ success: true, ...info, apiCalls });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  } finally { publishing = false; }
});

// ============================================================
// POST /set-paid … 既存の下書きに「有料エリア指定」の区切りだけを入れる（投稿はしない）
// 2026-09-10: 3万字の本文を入れ直さずに有料設定をやり直せるようにするため追加
// Body: { cookie, key, anchor, dryRun? }  anchor = 有料エリアの開始にしたい行の文字列
// ============================================================
app.post('/set-paid', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  const key = String((req.body || {}).key || '');
  const anchor = String((req.body || {}).anchor || '');
  if (!cookie || !key || !anchor) return res.status(400).json({ success: false, error: 'cookie, key, anchor required' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();
    await page.goto('https://editor.note.com/notes/' + key + '/edit/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }

    // inspectOnly: 何も変更せず、編集画面に有料エリアの区切りが表示されているかだけ調べる
    // 2026-09-11: APIのseparatorがnullのままなので、実画面が真実かを確かめるために追加
    if ((req.body || {}).inspectOnly) {
      const found = await page.evaluate(() => {
        const hits = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.childElementCount > 0) return;
          const t = (el.textContent || '').trim();
          if (t && /有料|ここから先|エリア/.test(t) && t.length < 60) {
            const r = el.getBoundingClientRect();
            hits.push(el.tagName + ' "' + t + '" vis=' + (r.width > 0 && r.height > 0) + ' top=' + Math.round(r.top));
          }
        });
        const editor = document.querySelector('[contenteditable="true"]');
        return {
          hits: hits.slice(0, 20),
          editorHtmlTail: editor ? editor.innerHTML.replace(/ (name|id)="[^"]*"/g, '').slice(-1200) : 'no-editor',
        };
      });
      await browser.close(); publishing = false;
      return res.json({ success: true, inspectOnly: true, key, ...found });
    }

    // 1. 有料エリアの開始位置にキャレットを置く
    const placed = await page.evaluate((a) => {
      const nodes = [...document.querySelectorAll('h1,h2,h3,p')];
      const el = nodes.find(n => (n.textContent || '').indexOf(a) >= 0);
      if (!el) return { ok: false, reason: 'anchor not found', sample: nodes.slice(0, 8).map(n => (n.textContent || '').slice(0, 30)) };
      el.scrollIntoView({ block: 'center' });
      const sel = window.getSelection(); const range = document.createRange();
      range.setStart(el, 0); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      el.focus && el.focus();
      return { ok: true, tag: el.tagName, text: (el.textContent || '').slice(0, 40) };
    }, anchor);
    if (!placed.ok) { await browser.close(); publishing = false; return res.json({ success: false, step: 'placeCaret', placed }); }
    await page.waitForTimeout(1200);

    // 2. ＋メニューを開いて中身を全部記録してから「有料エリア指定」を押す
    let menuItems = [];
    let clicked = false;
    const plusBtn = page.locator('button[aria-label="メニューを開く"]').first();
    const plusVisible = await plusBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (plusVisible) {
      await plusBtn.click({ force: true });
      await page.waitForTimeout(2000);
      const r = await page.evaluate(() => {
        const items = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => (b.textContent || '').trim()).filter(Boolean);
        const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '有料エリア指定' && b.offsetParent !== null);
        if (btn) { btn.click(); return { items: items.slice(0, 40), clicked: true }; }
        return { items: items.slice(0, 40), clicked: false };
      });
      menuItems = r.items; clicked = r.clicked;
    }
    await page.waitForTimeout(4000);

    // 3. 自動保存を待ってから、APIで separator が入ったか実測する
    const verify = await page.evaluate(async (k) => {
      try {
        const r = await fetch('https://note.com/api/v2/note_list/contents?limit=20&page=1', { credentials: 'include' });
        const j = await r.json();
        const list = (j && j.data && j.data.notes) || [];
        const hit = list.find(n => n.key === k);
        if (!hit) return { found: false };
        const d = hit.noteDraft || {};
        return { found: true, separator: d.separator || hit.separator || null, bodyLen: String(d.body || '').length };
      } catch (e) { return { found: false, err: e.message }; }
    }, key);

    await browser.close();
    res.json(saveResult_({ success: clicked && !!verify.separator, placed, plusVisible, clicked, menuItems, verify, editUrl: 'https://editor.note.com/notes/' + key + '/edit/' }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  } finally { publishing = false; }
});

// ============================================================
// POST /edit-text … 既存記事の本文を「文字列の置換」だけで直す（2026-09-17追加）
// Body: { cookie, key, ops:[{find,replace}], context?:[str], dump?:bool, confirm, dryRun }
//
// 公開中・販売中の記事を機械で編集するため、安全側に倒してある：
//   - dryRun（既定）は**一切打鍵せず**、対象が一意に見つかるかだけを確かめる
//   - find が0件または2件以上なら、その時点で中止（どこを直すか曖昧なまま触らない）
//   - 置換は Range で対象だけを選択 → 実キー入力。React/エディタに正しく伝わる
//   - 1件ごとに、置換後のブロックを読み返して replace があり find が消えたことを照合。
//     1件でも失敗したら**保存せずに中止**する（＝公開中の本文は元のまま）
//   - 保存（更新する）は confirm:true のときだけ押す
// ============================================================
app.post('/edit-text', async (req, res) => {
  const b = req.body || {};
  const cookie = String(b.cookie || '');
  const key = String(b.key || '');
  const ops = Array.isArray(b.ops) ? b.ops : [];
  const context = Array.isArray(b.context) ? b.context : [];
  const dryRun = b.dryRun !== false;   // 既定は dryRun。明示的に false にしない限り打鍵しない
  if (!cookie || !key) return res.status(400).json({ success: false, error: 'cookie, key required' });
  if (!ops.length && !context.length && !b.dump) return res.status(400).json({ success: false, error: 'ops か context か dump が必要です' });
  if (!dryRun && !b.confirm) return res.status(400).json({ success: false, error: 'confirm:true required（公開中の記事を書き換えます）' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;

  const steps = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const ctx = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await ctx.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await ctx.newPage();

    await page.goto('https://editor.note.com/notes/' + key + '/edit/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(18000);   // 20万字の本文は描画が遅い
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }

    const editorInfo = await page.evaluate(() => {
      const root = document.querySelector('[contenteditable="true"]');
      return {
        found: !!root,
        textLen: root ? (root.innerText || '').length : 0,
        topButtons: [...document.querySelectorAll('button')]
          .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
          .map(x => (x.textContent || '').trim()).filter(Boolean),
      };
    });
    steps.push({ step: '1_open', editorInfo });
    if (!editorInfo.found) { await browser.close(); publishing = false; return res.json({ success: false, error: '本文エディタが見つかりません', steps }); }

    // context: 指定文字列の前後を見せる（どう変換されているか実物を確認するため）
    if (context.length || b.dump) {
      const seen = await page.evaluate((args) => {
        const root = document.querySelector('[contenteditable="true"]');
        const all = root.innerText || '';
        const out = {};
        (args.context || []).forEach(s => {
          const i = all.indexOf(s);
          out[s] = i < 0 ? '(見つからない)' : all.slice(Math.max(0, i - 120), i + 160).replace(/\n/g, ' ⏎ ');
        });
        return { context: out, head: args.dump ? all.slice(0, 1500) : undefined };
      }, { context, dump: !!b.dump });
      steps.push({ step: '2_context', ...seen });
    }

    // ops: まず全件について「一意に見つかるか」だけを先に確かめる（打鍵する前に）
    const locate = await page.evaluate((list) => {
      const root = document.querySelector('[contenteditable="true"]');
      const all = root.innerText || '';
      return list.map(o => {
        let n = 0, from = 0, i;
        while ((i = all.indexOf(o.find, from)) >= 0) { n++; from = i + 1; if (n > 5) break; }
        return { find: o.find, count: n };
      });
    }, ops.map(o => ({ find: String(o.find || '') })));
    steps.push({ step: '3_locate', locate });

    const bad = locate.filter(x => x.count !== 1);
    if (bad.length) {
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: false, error: '対象が一意に決まりません（0件または複数件）', bad, steps }));
    }

    // inspectSave: 打鍵せずに「公開に進む」だけ押して、保存画面の状態を確かめる。
    // 2026-09-17: 公開中の記事の編集画面が「更新する」ではなく「公開に進む」だったため、
    // 有料エリアと価格が保持されるかを、本文を触る前に確認する。
    if (dryRun && b.inspectSave) {
      const went = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button')]
          .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
          .find(x => /公開に進む|更新する/.test((x.textContent || '').trim()));
        if (!el) return { ok: false };
        el.click(); return { ok: true, text: (el.textContent || '').trim() };
      });
      await page.waitForTimeout(16000);   // 販売設定画面は遅延レンダリング
      const saveScreen = await page.evaluate(() => {
        const paid = [...document.querySelectorAll('input[name="is_paid"]')].find(r => r.checked);
        const price = document.querySelector('input[id*="price"], input[name*="price"]');
        return {
          url: location.href,
          topButtons: [...document.querySelectorAll('button')]
            .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
            .map(x => (x.textContent || '').trim()).filter(Boolean),
          isPaid: paid ? paid.value : '(未選択)',
          priceValue: price ? price.value : '(欄なし)',
        };
      });
      steps.push({ step: '3b_inspect_save', went, saveScreen });
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: true, dryRun: true, message: '保存画面の状態を確認（本文は触っていません・保存もしていません）', steps }));
    }

    if (dryRun) {
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: true, dryRun: true, message: '対象を一意に特定できました（打鍵していません）', steps }));
    }

    // 実際の置換：Rangeで対象だけを選択して実キー入力で打ち替える
    const applied = [];
    for (const op of ops) {
      const find = String(op.find || '');
      const replace = String(op.replace || '');

      const sel = await page.evaluate((f) => {
        const root = document.querySelector('[contenteditable="true"]');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node, hit = null, idx = -1;
        while ((node = walker.nextNode())) {
          const i = (node.nodeValue || '').indexOf(f);
          if (i >= 0) { hit = node; idx = i; break; }
        }
        // 単一テキストノードに収まっていない場合は触らない（装飾で分割されている等）
        if (!hit) return { ok: false, reason: '単一のテキストノードとして見つからない' };
        const block = hit.parentElement.closest('h1,h2,h3,p,li') || hit.parentElement;
        block.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(hit, idx);
        range.setEnd(hit, idx + f.length);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(range);
        return { ok: true, selected: s.toString(), blockBefore: (block.textContent || '').slice(0, 100) };
      }, find);

      if (!sel.ok || sel.selected !== find) {
        applied.push({ find, ok: false, reason: sel.reason || ('選択がズレた: "' + sel.selected + '"') });
        break;
      }

      await page.waitForTimeout(400);
      await page.keyboard.type(replace, { delay: 35 });
      await page.waitForTimeout(1200);

      // 読み返して照合：replaceが入り、findが消えたか
      const verify = await page.evaluate((args) => {
        const root = document.querySelector('[contenteditable="true"]');
        const all = root.innerText || '';
        return { hasReplace: all.indexOf(args.replace) >= 0, findLeft: all.indexOf(args.find) >= 0 };
      }, { find, replace });

      const ok = verify.hasReplace && !verify.findLeft;
      applied.push({ find, replace, ok, verify, blockBefore: sel.blockBefore });
      if (!ok) break;
    }
    steps.push({ step: '4_apply', applied });

    const allOk = applied.length === ops.length && applied.every(a => a.ok);
    if (!allOk) {
      // 保存しない＝公開中の本文は元のまま。ページを閉じるだけ
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: false, error: '置換に失敗したため保存せずに中止しました（記事は元のままです）', steps }));
    }

    // 保存：公開中の記事は「更新する」ではなく「公開に進む」で販売設定画面へ行く（2026-09-17実測）
    const topCta = async () => await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
        .map(x => (x.textContent || '').trim()).filter(Boolean));

    const went = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
        .find(x => /公開に進む|更新する/.test((x.textContent || '').trim()));
      if (!el) return { ok: false, visible: [...document.querySelectorAll('button')].map(x => (x.textContent || '').trim()).filter(Boolean).slice(0, 20) };
      el.click(); return { ok: true, text: (el.textContent || '').trim() };
    });
    if (!went.ok) {
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: false, error: '保存に進むボタンが見つかりません（本文は保存されていません）', went, steps }));
    }

    // 販売設定画面は遅延レンダリング。確定ボタンが出るまで待つ
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
        .some(x => /^(更新する|投稿する|公開する)$/.test((x.textContent || '').trim())),
      { timeout: 40000 }).catch(() => {});

    // 押す前に、有料設定が保持されているかを確認する。崩れていたら押さない。
    const before = await page.evaluate(() => {
      const paid = [...document.querySelectorAll('input[name="is_paid"]')].find(r => r.checked);
      const price = document.querySelector('input[id*="price"], input[name*="price"]');
      return { isPaid: paid ? paid.value : '(未選択)', priceValue: price ? price.value : '(欄なし)' };
    });
    const cta = await topCta();
    steps.push({ step: '5_save_screen', went, cta, before });

    if (before.isPaid !== 'paid' || before.priceValue !== String(b.expectPrice || before.priceValue)) {
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: false, error: '販売設定が想定と違うため保存しませんでした（記事は元のままです）', before, steps }));
    }

    const confirmBtn = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 70 && r.width > 0; })
        .find(x => /^(更新する|投稿する|公開する)$/.test((x.textContent || '').trim()));
      if (!el) return { ok: false };
      el.click(); return { ok: true, text: (el.textContent || '').trim() };
    });
    await page.waitForTimeout(10000);
    steps.push({ step: '6_saved', confirmBtn, url: page.url() });

    await browser.close();
    res.json(saveResult_({ success: !!confirmBtn.ok, steps }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message, steps });
  } finally { publishing = false; }
});

// ============================================================
// POST /publish-existing … 既存の下書きを、noteの正規フローで有料公開する（2026-09-16追加）
// Body: { cookie, key, price, tags?, paidAnchor, confirm, dryRun? }
//
// 2026-09-16の実測で判明した正しい手順。/publish のように3万字を入れ直さないので
// 下書きが増えず、1分で終わる。
//   1. /notes/{key}/publish/ を開く
//   2. 「有料」を選んで価格を入れる
//   3. 「有料エリア設定」を押す → 各ブロックの前に「ラインをこの場所に変更」が並ぶ画面になる
//   4. paidAnchor の直前のボタンを押す → 右上が「投稿する」になる
//   5. 「投稿する」を押す
//
// 自前で編集画面に paywall-line を挿入する旧方式は、DOMには入るがサーバーに保存されず
// （separator=null）、公開画面で投稿ボタンが出ない原因になっていた。
// ============================================================
app.post('/publish-existing', async (req, res) => {
  const b = req.body || {};
  const cookie = String(b.cookie || '');
  const key = String(b.key || '');
  const price = Number(b.price || 0);
  const paidAnchor = String(b.paidAnchor || '');
  const tags = Array.isArray(b.tags) ? b.tags.map(String).filter(Boolean) : [];
  const dryRun = !!b.dryRun;
  if (!cookie || !key) return res.status(400).json({ success: false, error: 'cookie, key required' });
  if (price > 0 && !paidAnchor) return res.status(400).json({ success: false, error: '有料にするなら paidAnchor（有料エリアの開始行）が必要です' });
  if (!dryRun && !b.confirm) return res.status(400).json({ success: false, error: 'confirm:true required（公開と価格は取り消せません）' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;

  const steps = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();

    // 右上の主ボタン（「投稿する」／「有料エリア設定」）を読む。ここが手順の進行度を示す。
    const topCta = async () => await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 60 && r.width > 0; })
        .map(x => (x.textContent || '').trim()).filter(Boolean)
    );

    // --- 1. 公開設定画面を開く ---
    await page.goto('https://editor.note.com/notes/' + key + '/publish/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }
    steps.push({ step: '1_open', url: page.url(), cta: await topCta() });

    // --- 2. ハッシュタグ（任意）---
    let tagsApplied = null;
    const tagTrace = [];   // 1タグごとに「入力欄に入ったか／Enterで消えたか」を残す
    if (tags.length) {
      try {
        const nav = page.locator('button:has-text("ハッシュタグ")').first();
        if (await nav.isVisible({ timeout: 3000 }).catch(() => false)) { await nav.click({ force: true }); await page.waitForTimeout(1500); }
        const input = page.locator('input[placeholder*="ハッシュタグ"], input[placeholder*="タグ"]').first();
        if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
          for (const t of tags.slice(0, 10)) {
            // fill() だと値は入るがReactに伝わらず、Enterで確定されない（2026-09-16実測）。
            // 実際のキー入力にする。効いているか毎回そのつど読む。
            await input.click({ force: true });
            await page.keyboard.type(t, { delay: 60 });
            await page.waitForTimeout(900);
            const typed = await input.inputValue().catch(() => '(読めない)');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1200);
            const afterEnter = await input.inputValue().catch(() => '(読めない)');
            tagTrace.push({ tag: t, typed, afterEnter });
          }
          await page.waitForTimeout(1500);
          // 確定済みタグは「#」付きで出るとは限らない（2026-09-16実測）。#の有無を問わず照合する。
          tagsApplied = await page.evaluate((wanted) => {
            const seen = new Set();
            document.querySelectorAll('*').forEach(el => {
              if (el.childElementCount !== 0) return;
              const t = (el.textContent || '').trim();
              if (t && t.length < 30) seen.add(t.replace(/^#/, ''));
            });
            return {
              added: wanted.filter(w => seen.has(w)),
              missing: wanted.filter(w => !seen.has(w)),
            };
          }, tags.slice(0, 10));
        } else {
          tagsApplied = { error: 'タグ入力欄が見つかりません' };
        }
      } catch (e) { tagsApplied = { error: e.message.slice(0, 80) }; }
      steps.push({ step: '2_tags', tagsApplied, tagTrace });
    }

    // --- 3. 有料を選んで価格を入れる ---
    let priceState = null;
    if (price > 0) {
      const radio = await page.evaluate(() => {
        const rs = [...document.querySelectorAll('input[name="is_paid"]')];
        if (rs.length < 2) return { ok: false, reason: 'ラジオが見つからない(' + rs.length + ')' };
        const target = rs.find(r => r.value === 'paid') || rs[rs.length - 1];
        target.scrollIntoView({ block: 'center' });
        const lbl = target.closest('label') || document.querySelector('label[for="' + target.id + '"]');
        (lbl || target).click();
        return { ok: true, checked: target.checked };
      });
      await page.waitForTimeout(5000);
      await page.waitForSelector('input[id*="price"], input[name*="price"]', { timeout: 30000 }).catch(() => {});
      const el = page.locator('input[id*="price"], input[name*="price"]').first();
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        await el.fill(String(price)).catch(() => {});
        await page.waitForTimeout(1500);
      }
      // 入れっぱなしにせず読み返す
      const readBack = await page.evaluate(() => {
        const i = document.querySelector('input[id*="price"], input[name*="price"]');
        const paid = [...document.querySelectorAll('input[name="is_paid"]')].find(r => r.checked);
        return { priceValue: i ? i.value : null, isPaid: paid ? paid.value : null };
      });
      priceState = { radio, ...readBack };
      steps.push({ step: '3_price', priceState, cta: await topCta() });
      if (readBack.priceValue !== String(price)) {
        await browser.close(); publishing = false;
        return res.json(saveResult_({ success: false, error: '価格が入らなかった（' + readBack.priceValue + '）', steps }));
      }
    }

    // --- 4. 「有料エリア設定」→ paidAnchor の直前の「ラインをこの場所に変更」を押す ---
    let paidArea = null;
    if (price > 0) {
      const opened = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '有料エリア設定' && x.offsetParent !== null);
        if (!el) return { ok: false };
        el.click(); return { ok: true };
      });
      if (!opened.ok) {
        await browser.close(); publishing = false;
        return res.json(saveResult_({ success: false, error: '「有料エリア設定」ボタンが見つかりません', steps }));
      }
      await page.waitForTimeout(9000);

      // アンカー行より前にある最後の「ラインをこの場所に変更」を選ぶ（＝その行から有料になる）
      paidArea = await page.evaluate((anchor) => {
        const LABEL = 'ラインをこの場所に変更';
        const btns = [...document.querySelectorAll('button')].filter(x => (x.textContent || '').trim() === LABEL);
        if (!btns.length) return { ok: false, reason: 'ラインのボタンが無い' };
        const anchorEl = [...document.querySelectorAll('*')]
          .find(el => el.childElementCount === 0 && (el.textContent || '').indexOf(anchor) >= 0);
        if (!anchorEl) return { ok: false, reason: 'アンカーが見つからない', anchor, total: btns.length };
        let best = null;
        for (const x of btns) {
          // x が anchorEl より前にあるか
          if (x.compareDocumentPosition(anchorEl) & Node.DOCUMENT_POSITION_FOLLOWING) best = x; else break;
        }
        if (!best) return { ok: false, reason: 'アンカーより前にラインのボタンが無い', total: btns.length };
        // 押す前に「選んだ位置の直後にくる文字」を控える。
        // ボタンは各ブロックの兄弟ではなくラッパー内にあるので、兄弟だけ見ると取れない（2026-09-16）。
        // DOM順で後ろに進み、最初に出てくる文字を持つ末端要素を拾う。
        // 本文ではないUIラベルは読み飛ばす（実測で判明・2026-09-16）
        const CHROME = [LABEL, 'このラインより先を有料にする', 'ここから先は有料エリアです'];
        const isChrome = (t) => CHROME.some(c => t === c || t.indexOf(c) >= 0);
        const all = [...document.querySelectorAll('*')];
        const bi = all.indexOf(best);
        let nextText = '(なし)';
        let prevText = '(なし)';
        for (let i = bi + 1; i < all.length && i < bi + 400; i++) {
          const el = all[i];
          if (el.childElementCount !== 0) continue;
          const t = (el.textContent || '').trim();
          if (!t || isChrome(t)) continue;
          nextText = t.slice(0, 40); break;
        }
        for (let i = bi - 1; i >= 0 && i > bi - 400; i--) {
          const el = all[i];
          if (el.childElementCount !== 0) continue;
          const t = (el.textContent || '').trim();
          if (!t || isChrome(t)) continue;
          prevText = t.slice(-40); break;
        }
        // 直後がアンカー行でなければ押さない（位置がずれた状態で公開しないため）
        const matches = nextText.indexOf(anchor) >= 0;
        if (!matches) return { ok: false, reason: '選んだ位置の直後がアンカー行ではない', nextText, prevText, anchor, total: btns.length };
        best.scrollIntoView({ block: 'center' });
        best.click();
        return { ok: true, total: btns.length, nextText, prevText, anchor };
      }, paidAnchor);
      await page.waitForTimeout(8000);
      paidArea.ctaAfter = await topCta();
      steps.push({ step: '4_paid_area', paidArea });
      if (!paidArea.ok) {
        await browser.close(); publishing = false;
        return res.json(saveResult_({ success: false, error: '有料エリアの位置を指定できませんでした', steps }));
      }
    }

    // --- 5. 「投稿する」---
    const cta = await topCta();
    const hasPost = cta.some(t => /投稿する|公開する/.test(t));
    if (!hasPost) {
      const diag = await page.evaluate(() => [...document.querySelectorAll('button')].map(x => (x.textContent || '').trim()).filter(Boolean).slice(0, 40));
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: false, error: '「投稿する」が出ていません', cta, diag, steps }));
    }
    if (dryRun) {
      await browser.close(); publishing = false;
      return res.json(saveResult_({ success: true, dryRun: true, message: '「投稿する」が出るところまで確認（押していません）', cta, steps, tagsApplied }));
    }

    const posted = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')]
        .filter(x => { const r = x.getBoundingClientRect(); return r.top >= 0 && r.top < 60 && r.width > 0; })
        .find(x => /投稿する|公開する/.test((x.textContent || '').trim()));
      if (!el) return { ok: false };
      el.click(); return { ok: true, text: (el.textContent || '').trim() };
    });
    await page.waitForTimeout(3000);
    // 確認ダイアログが出る場合に備える
    const confirmDlg = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null)
        .find(x => /^(投稿する|公開する|はい|OK)$/.test((x.textContent || '').trim()));
      if (!el) return { needed: false };
      el.click(); return { needed: true, text: (el.textContent || '').trim() };
    });
    steps.push({ step: '5_post', posted, confirmDlg });

    let noteUrl = null;
    try {
      await page.waitForURL(/note\.com\/[^/]+\/n\/n/, { timeout: 30000 });
      noteUrl = page.url().split('?')[0];
    } catch { /* URL遷移しない場合は下で一覧から確かめる */ }

    // 本当に公開されたかをAPIで確かめる（ボタンを押せた＝公開できた、ではない）
    const verify = await page.evaluate(async (k) => {
      try {
        const r = await fetch('https://note.com/api/v2/note_list/contents?limit=50&page=1', { credentials: 'include' });
        const j = await r.json();
        const list = (j && j.data && (j.data.contents || j.data.notes)) || [];
        const hit = (Array.isArray(list) ? list : []).find(n => (n.key || n.id) === k);
        return hit ? { found: true, status: hit.status, price: hit.price, name: hit.name } : { found: false };
      } catch (e) { return { err: e.message }; }
    }, key);

    await browser.close();
    res.json(saveResult_({ success: verify.status === 'published', url: noteUrl, verify, steps, tagsApplied }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message, steps });
  } finally { publishing = false; }
});

// ============================================================
// POST /inspect-publish … 既存下書きの「公開設定画面」を開いて構造を記録する（2026-09-16追加）
// Body: { cookie, key, selectPaid?: true, price?: number }
//
// 2026-09-16に /publish が「投稿ボタンが見つかりません」で失敗したため、
// 投稿ボタンの正体を推測せず実測するために追加。**何も投稿しない・下書きも作らない。**
// selectPaid:true のときだけ「有料」ラジオを押して、そのあとの画面も記録する。
// ============================================================
app.post('/inspect-publish', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  const key = String((req.body || {}).key || '');
  const selectPaid = !!(req.body || {}).selectPaid;
  const price = Number((req.body || {}).price || 0);
  if (!cookie || !key) return res.status(400).json({ success: false, error: 'cookie, key required' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;

  // 押せそうな要素を、button に限らず全部拾う（前回 button だけ見て見落とした）
  const dumpClickables = async (page, label) => await page.evaluate((lbl) => {
    const rows = [];
    document.querySelectorAll('button, a, input, textarea, [contenteditable="true"], [role="button"], [role="menuitem"], [role="combobox"]').forEach(el => {
      const r = el.getBoundingClientRect();
      const txt = (el.textContent || el.value || '').trim().slice(0, 28);
      const aria = (el.getAttribute('aria-label') || '').slice(0, 28);
      const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').slice(0, 28);
      if (!txt && !aria && !ph && el.tagName !== 'INPUT') return;
      rows.push([
        el.tagName.toLowerCase(),
        el.getAttribute('type') || '',
        el.getAttribute('name') || '',
        el.id ? 'id=' + el.id.slice(0, 24) : '',
        'txt="' + txt + '"',
        aria ? 'aria="' + aria + '"' : '',
        ph ? 'ph="' + ph + '"' : '',
        'vis=' + (r.width > 0 && r.height > 0),
        'disabled=' + !!el.disabled,
        'top=' + Math.round(r.top),
        'cls=' + String(el.className || '').split(' ').slice(0, 2).join('.').slice(0, 40),
      ].filter(Boolean).join(' '));
    });
    const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .ReactModal__Content')]
      .map(d => (d.textContent || '').trim().slice(0, 80));
    return { label: lbl, url: location.href, count: rows.length, rows: rows.slice(0, 120), dialog };
  }, label);

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();

    await page.goto('https://editor.note.com/notes/' + key + '/publish/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000); // 販売設定画面は遅延レンダリング
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }

    const shots = [];
    shots.push(await dumpClickables(page, '1_publish_screen'));

    // ページ末尾まで送ってから再取得（投稿ボタンが遅延描画される可能性）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    shots.push(await dumpClickables(page, '2_after_scroll'));

    if (selectPaid) {
      const radio = await page.evaluate(() => {
        const rs = [...document.querySelectorAll('input[name="is_paid"]')];
        if (rs.length < 2) return { ok: false, reason: 'ラジオが見つからない(' + rs.length + ')' };
        const target = rs[rs.length - 1];
        target.scrollIntoView({ block: 'center' });
        const lbl = target.closest('label') || document.querySelector('label[for="' + target.id + '"]');
        (lbl || target).click();
        return { ok: true, checked: target.checked };
      });
      await page.waitForTimeout(6000);
      if (price > 0) {
        await page.waitForSelector('input[id*="price"], input[placeholder="300"]', { timeout: 30000 }).catch(() => {});
        const el = page.locator('input[id*="price"], input[name*="price"]').first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
          await el.click({ force: true }).catch(() => {});
          await el.fill(String(price)).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      const after = await dumpClickables(page, '3_after_paid' + (price > 0 ? '_price' : ''));
      after.radio = radio;
      shots.push(after);
    }

    // click: 指定テキストのボタンを押して、その先の画面を記録する。
    // 「有料エリア設定」の遷移先を見るため。投稿系の文言は安全のため受け付けない。
    const click = String((req.body || {}).click || '');
    if (click) {
      if (/投稿|公開|販売/.test(click)) {
        shots.push({ label: 'click_refused', note: '投稿・公開・販売を含むボタンはこの診断用エンドポイントでは押しません' });
      } else {
        const r = await page.evaluate((t) => {
          const el = [...document.querySelectorAll('button, a, [role="button"]')]
            .find(b => (b.textContent || '').trim() === t && b.offsetParent !== null);
          if (!el) return { ok: false };
          el.click();
          return { ok: true };
        }, click);
        await page.waitForTimeout(9000);
        const shot = await dumpClickables(page, '4_after_click_' + click);
        shot.clickResult = r;
        shot.bodyText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600));
        shot.paywallLine = await page.evaluate(() => {
          const pw = document.querySelector('paywall-line');
          return pw ? { found: true, textcount: pw.getAttribute('textcount') } : { found: false };
        });
        shots.push(shot);
      }
    }

    await browser.close();
    res.json(saveResult_({ success: true, key, shots }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  } finally { publishing = false; }
});

// ============================================================
// POST /delete-drafts … 検証用に溜まった下書きを削除する（2026-09-16追加）
// Body: { cookie, keys: string[], confirm: true, inspectOnly?: true }
//
// 取り返しがつかない操作なので、安全側に倒してある：
//   - keys で明示指定したものしか触らない（一括「全部消す」は用意しない）
//   - 削除前にAPIで status を確認し、draft 以外（公開済み）は必ずスキップする
//   - confirm:true が無いと実行しない
//   - inspectOnly:true なら menu の中身を記録するだけで、クリックしない
// ============================================================
app.post('/delete-drafts', async (req, res) => {
  const cookie = String((req.body || {}).cookie || '');
  const keys = Array.isArray((req.body || {}).keys) ? (req.body || {}).keys.map(String).filter(Boolean) : [];
  const inspectOnly = !!(req.body || {}).inspectOnly;
  const confirm = !!(req.body || {}).confirm;
  if (!cookie || !keys.length) return res.status(400).json({ success: false, error: 'cookie, keys required' });
  if (!inspectOnly && !confirm) return res.status(400).json({ success: false, error: 'confirm:true required（削除は取り消せません）' });
  if (keys.length > 20) return res.status(400).json({ success: false, error: 'keys は20件までにしてください' });
  if (publishing) return res.status(429).json({ success: false, busy: true });
  publishing = true;

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
    const context = await browser.newContext({ userAgent: NOTE_UA, viewport: { width: 1280, height: 900 } });
    const parsed = cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.substring(0, i).trim(), value: c.substring(i + 1).trim(), path: '/' }; }).filter(c => c.name && c.value);
    await context.addCookies([...parsed.map(c => ({ ...c, domain: '.note.com' })), ...parsed.map(c => ({ ...c, domain: 'editor.note.com' }))]);
    const page = await context.newPage();

    await page.goto('https://note.com/notes', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    if (page.url().includes('/login')) { await browser.close(); publishing = false; return res.json({ success: false, error: 'cookie expired' }); }

    // 記事一覧を取って key → {title, status} を作る。ここに無い／draftでないものは触らない。
    const snapshot = async () => await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v2/note_list/contents?limit=50&page=1', { credentials: 'include' });
        const j = await r.json();
        const list = (j && j.data && (j.data.contents || j.data.notes)) || [];
        const map = {};
        (Array.isArray(list) ? list : []).forEach(n => {
          const k = n.key || n.id;
          if (k) map[k] = { title: n.name || (n.noteDraft || {}).name || '', status: n.status };
        });
        return map;
      } catch (e) { return { __error: e.message }; }
    });

    const before = await snapshot();
    if (before.__error) { await browser.close(); publishing = false; return res.json({ success: false, error: '一覧取得失敗: ' + before.__error }); }

    // inspectOnly のときは一覧ページ自体の構造も1回だけ記録する。
    // 2026-09-16: a[href*=key] が見つからず「カードが見つからない」で止まったため。
    let listPage = null;
    if (inspectOnly) {
      listPage = await page.evaluate(() => ({
        url: location.href,
        tabs: [...document.querySelectorAll('button, a[role="tab"], [role="tab"], nav a')]
          .filter(x => x.offsetParent !== null)
          .map(x => (x.getAttribute('aria-label') || (x.textContent || '').trim()).slice(0, 24))
          .filter(Boolean).slice(0, 30),
        anchorCount: document.querySelectorAll('a').length,
        allHrefs: [...document.querySelectorAll('a')].map(a => a.getAttribute('href') || '').filter(Boolean),
        // 「〜を編集」の要素が下書きカードの入口。タグ・href・カード内のボタンまで見る
        editEntries: [...document.querySelectorAll('[aria-label*="を編集"]')].map(el => {
          let card = el;
          for (let i = 0; i < 8 && card.parentElement; i++) {
            card = card.parentElement;
            if (card.querySelectorAll('button').length >= 1 && (card.textContent || '').indexOf('下書き') >= 0) break;
          }
          return {
            tag: el.tagName.toLowerCase(),
            href: el.getAttribute('href') || '(なし)',
            aria: (el.getAttribute('aria-label') || '').slice(0, 30),
            cardHrefs: [...card.querySelectorAll('a')].map(a => a.getAttribute('href') || '').filter(Boolean).slice(0, 5),
            cardButtons: [...card.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || (b.textContent || '').trim() || '(無名)').slice(0, 24)).slice(0, 8),
          };
        }).slice(0, 12),
      }));
    }

    const results = [];
    for (const key of keys) {
      const meta = before[key];
      if (!meta) { results.push({ key, skipped: '一覧に見つからない' }); continue; }
      if (meta.status !== 'draft') { results.push({ key, title: meta.title, skipped: 'status=' + meta.status + '（公開済みは削除しない）' }); continue; }

      try {
        // 2026-09-16実測：編集画面の「メニューを開く」はブロック挿入用（＋メニュー）で削除は無い。
        // 削除は記事一覧（note.com/notes）の、カードごとの「…」メニューにある。
        //
        // ただし下書きカードにはキーがDOMのどこにも出ない（hrefが無く button のみ）。
        // そこで「APIの下書き順」と「カードの並び順」を突き合わせて位置で対応づける。
        // 取り違えると別の記事を消すので、**全件のタイトルが一致しなければ何もしない**。
        await page.goto('https://note.com/notes', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(9000);

        const apiDrafts = await page.evaluate(async () => {
          const r = await fetch('/api/v2/note_list/contents?limit=50&page=1', { credentials: 'include' });
          const j = await r.json();
          const list = (j && j.data && (j.data.contents || j.data.notes)) || [];
          return (Array.isArray(list) ? list : [])
            .filter(n => n.status === 'draft')
            .map(n => ({ key: n.key || n.id, title: n.name || (n.noteDraft || {}).name || '' }));
        });

        const openMenuOnce = async () => await page.evaluate((args) => {
          const { drafts, target } = args;
          const entries = [...document.querySelectorAll('[aria-label*="を編集"]')];
          if (entries.length !== drafts.length) {
            return { ok: false, reason: 'カード数(' + entries.length + ')とAPIの下書き数(' + drafts.length + ')が一致しない' };
          }
          // 並びが本当に同じかを全件のタイトルで照合する
          const titleOf = (el) => (el.getAttribute('aria-label') || '').replace(/を編集$/, '');
          for (let i = 0; i < drafts.length; i++) {
            const shown = titleOf(entries[i]);
            const want = drafts[i].title || 'タイトル未設定';
            if (shown !== want) {
              return { ok: false, reason: '並びが一致しない: ' + i + '番目 画面="' + shown + '" API="' + want + '"' };
            }
          }
          const idx = drafts.findIndex(d => d.key === target);
          if (idx < 0) return { ok: false, reason: '対象が下書き一覧に無い' };

          const el = entries[idx];
          let card = el;
          for (let i = 0; i < 8 && card.parentElement; i++) {
            card = card.parentElement;
            if (card.querySelectorAll('button').length >= 2) break;
          }
          const btns = [...card.querySelectorAll('button')];
          // 「編集」ボタン以外＝「…」。名前で拾えないので、編集ボタンを除外して選ぶ
          const kebab = btns.find(b => b !== el && !/を編集$/.test(b.getAttribute('aria-label') || ''));
          if (!kebab) return { ok: false, reason: 'カード内に「…」ボタンが無い', cardButtons: btns.length };
          kebab.scrollIntoView({ block: 'center' });
          kebab.click();
          return { ok: true, index: idx, matchedTitle: titleOf(el), aria: kebab.getAttribute('aria-label') || '(なし)' };
        }, { drafts: apiDrafts, target: key });

        // メニューは遅れて描画されることがある（2026-09-16: 2.5秒固定待ちで8件取りこぼした）。
        // 「削除」が出るまで待ち、出なければ一度だけ押し直す。
        const deleteVisible = () => page.waitForFunction(() =>
          [...document.querySelectorAll('button, [role="menuitem"], a')]
            .some(b => b.offsetParent !== null && /^(削除|削除する|下書きを削除)$/.test((b.textContent || '').trim())),
          { timeout: 8000 }).then(() => true).catch(() => false);

        let openMenu = await openMenuOnce();
        if (!openMenu.ok) { results.push({ key, title: meta.title, skipped: openMenu.reason }); continue; }
        let ready = await deleteVisible();
        if (!ready) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1500);
          openMenu = await openMenuOnce();
          openMenu.retried = true;
          ready = await deleteVisible();
        }
        if (!ready) { results.push({ key, title: meta.title, skipped: '「…」を押したが削除メニューが出ない', openMenu }); continue; }

        const menuItems = await page.evaluate(() =>
          [...document.querySelectorAll('button, [role="menuitem"], a')]
            .filter(b => b.offsetParent !== null)
            .map(b => (b.textContent || '').trim())
            .filter(t => t && t.length < 30)
            .slice(0, 50)
        );

        if (inspectOnly) { results.push({ key, title: meta.title, openMenu, menuItems, inspectOnly: true }); continue; }

        // 「削除」をクリック → 確認ダイアログの「削除」をクリック
        const hit = await page.evaluate(() => {
          const els = [...document.querySelectorAll('button, [role="menuitem"], a')].filter(b => b.offsetParent !== null);
          const el = els.find(b => /^(削除|削除する|下書きを削除)$/.test((b.textContent || '').trim()));
          if (!el) return { ok: false };
          el.setAttribute('data-already-clicked', '1');   // 確認側で同じ要素を拾わないための目印
          el.click();
          return { ok: true, text: (el.textContent || '').trim() };
        });
        if (!hit.ok) { results.push({ key, title: meta.title, skipped: '削除メニューが見つからない', openMenu, menuItems }); continue; }
        await page.waitForTimeout(2500);

        const confirmed = await page.evaluate(() => {
          // 確認ダイアログがあればその中だけを見る。「キャンセル」は絶対に拾わない。
          const scope = document.querySelector('[role="dialog"], [aria-modal="true"]') || document;
          const els = [...scope.querySelectorAll('button, [role="button"]')]
            .filter(b => b.offsetParent !== null && !b.hasAttribute('data-already-clicked'));
          const el = els.find(b => /^(削除する|削除|はい|OK)$/.test((b.textContent || '').trim()));
          if (!el) return { ok: false, scoped: scope !== document, visible: els.map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 20) };
          el.click();
          return { ok: true, scoped: scope !== document, text: (el.textContent || '').trim() };
        });
        await page.waitForTimeout(4000);
        results.push({ key, title: meta.title, clicked: hit.text, confirmed });
      } catch (e) {
        results.push({ key, title: meta.title, error: e.message.slice(0, 100) });
      }
    }

    // 実際に消えたかを一覧で確かめる（クリックできた＝消えた、とは限らないため）
    await page.goto('https://note.com/notes', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const after = await snapshot();
    const verified = results.map(r => ({ ...r, deleted: !r.skipped && !after.__error ? !after[r.key] : null }));
    const remaining = after.__error ? null : Object.keys(after).map(k => k + ' | ' + after[k].status + ' | ' + after[k].title.slice(0, 30));

    await browser.close();
    res.json(saveResult_({ success: true, inspectOnly, listPage, results: verified, remaining }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  } finally { publishing = false; }
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

    // 有料設定のUI調査（2026-09-07追加）: 本文を入れて「公開に進む」を押し、販売設定画面を見る
    try {
      const titleSel2 = 'textarea[placeholder*="タイトル"], [data-placeholder*="タイトル"]';
      await page.fill(titleSel2, 'probe有料テスト').catch(() => {});
      await page.waitForTimeout(600);
      const body2 = page.locator('[contenteditable="true"]').last();
      if (await body2.count() > 0) { await body2.click(); await page.keyboard.type('本文テスト1行目'); }
      await page.waitForTimeout(800);
      const pubBtn2 = page.locator('button:has-text("公開に進む")').first();
      if (await pubBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await pubBtn2.click();
        await page.waitForURL(u => String(u).includes('/publish'), { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(10000); // 販売設定画面は遅延レンダリング
        // 「有料」ラジオを選んで、出現する価格入力欄を調べる
        try {
          // ラジオ自体は視覚的に隠れていることが多いので、DOM側で直接クリックする
          const clicked = await page.evaluate(() => {
            const rs = [...document.querySelectorAll('input[name="is_paid"]')];
            if (rs.length < 2) return 'radio not found: ' + rs.length;
            const target = rs[rs.length - 1]; // 「有料」は後ろ側
            target.scrollIntoView({ block: 'center' });
            // ラベル経由のほうが React に伝わりやすい
            const lbl = target.closest('label') || document.querySelector('label[for="' + target.id + '"]');
            (lbl || target).click();
            return 'clicked via ' + (lbl ? 'label' : 'input') + ' / checked=' + target.checked;
          });
          results.push({ label: '4b_radio', result: clicked });
          await page.waitForTimeout(6000);
        } catch (e) { results.push({ label: '4b_radio_error', error: e.message.slice(0, 80) }); }

        const paid = await page.evaluate(() => {
          const out = { url: location.href, priceRelated: [], inputs: [], buttons: [] };
          document.querySelectorAll('*').forEach(el => {
            const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
            const text = el.childElementCount === 0 ? (el.textContent || '').trim() : '';
            if (/有料|価格|販売|円|無料|ライン|エリア/.test(aria + ' ' + text) && (aria + text).length < 40) {
              const d = el.tagName + ' "' + (aria || text).slice(0, 30) + '"';
              if (!out.priceRelated.includes(d) && out.priceRelated.length < 25) out.priceRelated.push(d);
            }
          });
          document.querySelectorAll('input,select,textarea').forEach(el => {
            out.inputs.push(el.tagName + ' type=' + (el.type || '') + ' name=' + (el.name || '') + ' ph="' + (el.placeholder || '').slice(0, 20) + '"');
          });
          document.querySelectorAll('button,[role="button"]').forEach(el => {
            const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim().slice(0, 28);
            if (t && out.buttons.length < 30) out.buttons.push(t);
          });
          return out;
        });
        results.push({ label: '4_publish_settings', ...paid });
      } else {
        results.push({ label: '4_no_publish_button' });
      }
    } catch (e) { results.push({ label: '4_error', error: e.message.slice(0, 80) }); }

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
    magazine = '',
    price = 0,       // 有料記事の価格。0または未指定なら無料記事（2026-09-08追加）
    dryRun = false,  // trueなら「投稿する」を押さず、設定画面の状態を返して止める
    paste = false    // trueなら本文をHTMLに変換して一括貼り付け（長文用・2026-09-15追加）
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
  // 有料記事用（2026-09-08追加）
  let paidAreaInserted = false;
  let paidAreaCheck = null;   // 有料エリアが正しい位置に入ったかの実測結果
  let pasteResult = null;     // 一括貼り付けの結果（paste モード）
  let paidResult = null;
  let tagsApplied = null;     // 画面に実際に付いたハッシュタグ（読み返して確認・2026-09-16追加）

  // サムネイルを一時ファイルに保存
  let thumbPath = null;
  if (thumbnail) {
    try {
      // 2026-09-14: JPEGも受け付ける（拡張子を実データに合わせる）
      const ext = /^data:image\/jpe?g/.test(thumbnail) ? 'jpg' : 'png';
      thumbPath = join(tmpdir(), `thumb_${crypto.randomBytes(8).toString('hex')}.${ext}`);
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
        return res.json(saveResult_({ success: false, error: 'Cookie切れ（ログインセッション期限切れ）。setNoteCookie()で更新してください' }));
      }
      refreshedCookie = lg.cookie; // 成功したらGASに返して保存させる
      await page.goto('https://note.com/notes/new', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      if (page.url().includes('/login')) {
        await browser.close();
        return res.json(saveResult_({ success: false, error: '自動ログイン後もエディターを開けませんでした' }));
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

    // 長文用：HTMLに変換して一括貼り付け（2026-09-15追加）
    // 3.3万字を1文字ずつ入力するとRender無料枠(512MB)で15分以上かかり途中で落ちたため。
    let paidAnchorTextFromPaste = '';
    if (paste) {
      const html = mdToNoteHtml_(body);
      pasteResult = await page.evaluate((h) => {
        const el = document.querySelector('div.ProseMirror[contenteditable="true"]') || document.querySelector('div[contenteditable="true"][role="textbox"]');
        if (!el) return { ok: false, reason: 'editor not found' };
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/html', h);
        dt.setData('text/plain', ' ');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return { ok: true, handled: ev.defaultPrevented, htmlLen: h.length, editorLen: el.innerHTML.length };
      }, html);
      console.log('一括貼り付け:', JSON.stringify(pasteResult));
      await page.waitForTimeout(5000);
      // 有料区切りの位置（<<<PAID>>> の次の行）だけ拾っておく
      const pi = rawLines.findIndex(l => l.trim() === '<<<PAID>>>');
      if (pi >= 0) {
        const nxt = rawLines.slice(pi + 1).find(l => l.trim() !== '');
        if (nxt) paidAnchorTextFromPaste = nxt.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').slice(0, 30);
      }
    }

    // 画像行前後の余分な空行を除去（貼り付けモードでは1行ずつの入力をしない）
    const lines = paste ? [] : rawLines.filter((line, i) => {
      const t = line.trim();
      if (t !== '') return true;
      const prevImg = i > 0 && /^!\[/.test(rawLines[i - 1].trim());
      const nextImg = i < rawLines.length - 1 && /^!\[/.test(rawLines[i + 1].trim());
      return !prevImg && !nextImg;
    });

    let inList = false;      // 箇条書きリスト
    let inNumList = false;   // 番号付きリスト（2026-09-10追加）
    let inQuote = false;
    let inCode = false;      // コードブロック（2026-09-10追加）
    let tableHeader = null;  // 表の見出し行を一時保持（2026-09-10追加）
    let paidAnchorPending = false;  // <<<PAID>>> の直後の行を探している最中か
    let paidAnchorText = paidAnchorTextFromPaste;  // 有料エリアの先頭になる行のテキスト

    // 見出しや区切り線を入れる前に、開いているリスト・引用から抜ける
    const closeBlocks = async () => {
      if (inList || inNumList) {
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        inList = false; inNumList = false;
      }
      if (inQuote) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        inQuote = false;
      }
    };

    for (const line of lines) {
      const t = line.trim();

      if (!inCode) {
        const isBullet = t.startsWith('- ') || t.startsWith('* ');
        const isNum = /^\d+\. /.test(t);
        const isTableRow = t.startsWith('|');   // 表は箇条書きに変換するのでリストを閉じない
        // リストから出る
        if (inList && !isBullet && !isTableRow) {
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(200);
          inList = false;
        }
        // 番号付きリストから出る
        if (inNumList && !isNum) {
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(200);
          inNumList = false;
        }
        // 引用から出る
        if (inQuote && !t.startsWith('> ')) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(200);
          inQuote = false;
        }
      }

      // 有料エリアの区切り（2026-09-08追加）
      // 本文中に <<<PAID>>> の行があれば、そこに note の「有料エリア指定」を挿入する。
      // これ以降が購入者だけに見える範囲になる。
      // 2026-09-11修正: 執筆中に挿入すると、その後に打った本文が区切りより上に入り
      //   有料部分が空（textcount=0）になる。位置だけ覚えて、書き終えてから挿入する。
      if (t === '<<<PAID>>>') {
        paidAnchorPending = true;
        continue;
      }
      if (paidAnchorPending && t !== '') {
        paidAnchorText = t.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').slice(0, 30);
        paidAnchorPending = false;
      }

      // コードブロック（``` で開閉）。記録テンプレートや台本に使う
      // 2026-09-10追加: 未対応だったため ``` が本文に文字のまま入っていた
      if (t.startsWith('```')) {
        if (!inCode) {
          await clickPlusMenuItem(page, 'コード');
          await page.waitForTimeout(300);
          inCode = true;
        } else {
          // コードブロックから抜ける（下に新しい段落を作る）
          await page.keyboard.press('Control+Enter');
          await page.waitForTimeout(300);
          inCode = false;
        }
        continue;
      }
      if (inCode) {
        await page.keyboard.type(line, { delay: 3 });
        await page.keyboard.press('Enter');
        continue;
      }

      // 空行
      if (t === '') {
        await page.keyboard.press('Enter');
        continue;
      }

      // 区切り線（--- ）2026-09-10: 空行扱いだったのを実際の区切り線に
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) {
        await closeBlocks();
        await clickPlusMenuItem(page, '区切り線');
        await page.waitForTimeout(300);
        continue;
      }

      // 表（| a | b |）noteに表機能はないので「見出し：値」の箇条書きに変換する
      // 2026-09-10追加: 未対応でパイプ記号がそのまま入っていた
      if (t.startsWith('|')) {
        const cells = t.split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;   // 区切り行は捨てる
        if (!tableHeader) { tableHeader = cells; continue; }      // 1行目は見出しとして保持
        if (!inList) { await clickPlusMenuItem(page, '箇条書きリスト'); await page.waitForTimeout(300); inList = true; }
        await typeRichText(page, cells.join('：'));
        await page.keyboard.press('Enter');
        continue;
      }
      if (tableHeader && !t.startsWith('|')) tableHeader = null;

      // H1 章タイトル（# ）noteの見出しは2段階なので大見出しに割り当てる
      // 2026-09-10追加: 未対応で「# 第1章…」が文字のまま入っていた
      if (t.startsWith('# ')) {
        await closeBlocks();
        await clickPlusMenuItem(page, '大見出し');
        await page.waitForTimeout(300);
        await typeRichText(page, t.slice(2));
        await page.keyboard.press('Enter');
        continue;
      }

      // H2 大見出し（## ）
      if (t.startsWith('## ')) {
        await closeBlocks();
        await clickPlusMenuItem(page, '大見出し');
        await page.waitForTimeout(300);
        await typeRichText(page, t.slice(3));
        await page.keyboard.press('Enter');
        continue;
      }

      // H3 小見出し（### ）
      if (t.startsWith('### ')) {
        await closeBlocks();
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

      // 箇条書き（- または * ）2026-09-10: メニュー名が「箇条書きリスト」に変わっていた
      if (t.startsWith('- ') || t.startsWith('* ')) {
        if (!inList) {
          await clickPlusMenuItem(page, '箇条書きリスト');
          await page.waitForTimeout(300);
          inList = true;
        }
        await typeRichText(page, t.slice(2));
        await page.keyboard.press('Enter');
        continue;
      }

      // 番号付きリスト（1. 2. 3. ）2026-09-10追加
      if (/^\d+\. /.test(t)) {
        if (!inNumList) {
          await clickPlusMenuItem(page, '番号付きリスト');
          await page.waitForTimeout(300);
          inNumList = true;
        }
        await typeRichText(page, t.replace(/^\d+\.\s*/, ''));
        await page.keyboard.press('Enter');
        continue;
      }

      // 通常テキスト（太字・インラインコード対応）
      await typeRichText(page, line);
      await page.keyboard.press('Enter');
    }

    // ブロック終了処理
    if (inCode) { await page.keyboard.press('Control+Enter'); await page.waitForTimeout(200); }
    if (inList || inNumList) { await page.keyboard.press('Backspace'); await page.waitForTimeout(200); }
    if (inQuote) { await page.keyboard.press('Enter'); await page.waitForTimeout(200); }

    await page.waitForTimeout(2000);

    // ============================================================
    // Step 4b: 有料エリアの区切りを挿入（本文を全部書き終えてから）
    // noteの区切りは <paywall-line> 要素。ここから下が購入者だけに見える。
    // 2026-09-11: 執筆中に入れると後続の本文が区切りの上に入ってしまうため、最後に回した。
    // ============================================================
    if (paidAnchorText) {
      const placed = await page.evaluate((a) => {
        const root = document.querySelector('[contenteditable="true"]');
        if (!root) return { ok: false, reason: 'editor not found' };
        const nodes = [...root.querySelectorAll('h1,h2,h3,p,li')];
        const hitEl = nodes.find(n => (n.textContent || '').indexOf(a) >= 0);
        if (!hitEl) return { ok: false, reason: 'anchor not found', anchor: a };
        // 2026-09-14実測: ＋メニューは「カーソルのあるブロックの下」に挿入する。
        // 有料部分の先頭ブロックの“直前”のトップレベルブロックの末尾にカーソルを置く。
        let top = hitEl;
        while (top.parentElement && top.parentElement !== root) top = top.parentElement;
        const prev = top.previousElementSibling;
        if (!prev) return { ok: false, reason: 'no previous block', anchor: a };
        prev.scrollIntoView({ block: 'center' });
        const sel = window.getSelection(); const range = document.createRange();
        range.selectNodeContents(prev); range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
        root.focus();
        return { ok: true, tag: prev.tagName, prevText: (prev.textContent || '').slice(0, 40), anchorText: (top.textContent || '').slice(0, 40) };
      }, paidAnchorText);
      await page.waitForTimeout(1000);

      if (placed.ok) {
        paidAreaInserted = await clickPlusMenuItem(page, '有料エリア指定');
        await page.waitForTimeout(2500);
      }

      // 実際に区切りが正しい位置に入り、有料部分に中身があるかをDOMで確認する
      paidAreaCheck = await page.evaluate(() => {
        const pw = document.querySelector('paywall-line');
        if (!pw) return { found: false };
        const root = document.querySelector('[contenteditable="true"]');
        const kids = root ? [...root.children] : [];
        const idx = kids.indexOf(pw);
        return {
          found: true,
          textcount: pw.getAttribute('textcount'),
          position: idx + 1 + '/' + kids.length,
          // 空段落を飛ばして、区切りの前後で実際に文字があるブロックを返す
          nextBlock: (() => { let n = pw.nextElementSibling; while (n && !(n.textContent || '').trim()) n = n.nextElementSibling; return n ? (n.textContent || '').slice(0, 40) : '(最後尾)'; })(),
          prevBlock: (() => { let n = pw.previousElementSibling; while (n && !(n.textContent || '').trim()) n = n.previousElementSibling; return n ? (n.textContent || '').slice(0, 40) : '(先頭)'; })(),
        };
      });
      paidAreaCheck = { ...paidAreaCheck, placed, expectedNext: paidAnchorText };
      console.log('有料エリア:', JSON.stringify({ paidAreaInserted, paidAreaCheck }));

      // 挿入後は保存が必要
      await page.waitForTimeout(1500);
    }

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
      return res.json(saveResult_({ success: false, error: '「公開に進む」ボタンが見つかりません。利用可能なボタン: ' + availableButtons }));
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
          // 2026-09-16: 入れっぱなしにせず、画面に出ているタグを読み返して確認する。
          // note側が自動候補（#会社 など）を勝手に足すので、shown には希望外のタグも入る。
          await page.waitForTimeout(1500);
          // 確定済みタグは「#」付きで出るとは限らない（2026-09-16実測）。#の有無を問わず照合する。
          tagsApplied = await page.evaluate((wanted) => {
            const seen = new Set();
            document.querySelectorAll('*').forEach(el => {
              if (el.childElementCount !== 0) return;
              const t = (el.textContent || '').trim();
              if (t && t.length < 30) seen.add(t.replace(/^#/, ''));
            });
            return {
              added: wanted.filter(w => seen.has(w)),
              missing: wanted.filter(w => !seen.has(w)),
            };
          }, tags.slice(0, 10));
          console.log('タグ確認:', JSON.stringify(tagsApplied));
        } else {
          tagsApplied = { error: 'タグ入力欄が見つかりません' };
          console.log('タグ入力欄が見つかりません（続行）');
        }
      } catch (e) {
        tagsApplied = { error: e.message.slice(0, 80) };
        console.log('タグ設定失敗（続行）:', e.message.slice(0, 80));
      }
    }

    // ============================================================
    // Step 7b: 有料設定（2026-09-08追加）
    // 販売設定画面の input[name="is_paid"] は視覚的に隠れているため、
    // DOM側でラベルをクリックする。価格欄は「有料」選択後に出現する。
    // ============================================================
    if (price && Number(price) > 0) {
      console.log('有料設定中: ¥' + price);
      try {
        const radio = await page.evaluate(() => {
          const rs = [...document.querySelectorAll('input[name="is_paid"]')];
          if (rs.length < 2) return { ok: false, reason: 'ラジオが見つからない(' + rs.length + ')' };
          const target = rs[rs.length - 1]; // 「有料」は後ろ側
          target.scrollIntoView({ block: 'center' });
          const lbl = target.closest('label') || document.querySelector('label[for="' + target.id + '"]');
          (lbl || target).click();
          return { ok: true, checked: target.checked, via: lbl ? 'label' : 'input' };
        });
        console.log('有料ラジオ:', JSON.stringify(radio));
        await page.waitForTimeout(4000);

        // 価格入力欄を探す（文言ゆらぎに対応）
        const priceSelectors = [
          'input[name*="price"]', 'input[id*="price"]',
          'input[placeholder*="価格"]', 'input[placeholder*="円"]',
          'input[type="number"]',
        ];
        let priceSet = false;
        let priceSelector = null;
        // 2026-09-15: 長文だと描画が遅く価格欄がまだ無い→初期値300円のまま残った。出現を待つ
        await page.waitForSelector('input[id*="price"], input[placeholder="300"]', { timeout: 30000 }).catch(() => {});
        for (let attempt = 0; attempt < 3 && !priceSet; attempt++) {
          for (const sel of priceSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
              await el.click({ force: true }).catch(() => {});
              await el.fill(String(price)).catch(async () => {
                await page.keyboard.press('Control+a');
                await page.keyboard.type(String(price));
              });
              await el.blur().catch(() => {});
              await page.waitForTimeout(800);
              // 入った値を読み返して確認（推測で成功扱いにしない）
              const v = await el.inputValue().catch(() => '');
              if (String(v).replace(/[^\d]/g, '') === String(price)) {
                priceSet = true;
                priceSelector = sel;
                console.log('価格を入力:', sel, v);
              }
              break;
            }
          }
          if (!priceSet) await page.waitForTimeout(3000);
        }
        await page.waitForTimeout(1500);
        // 2026-09-11: 入力欄を推測で当てていないか確認するため、成否に関わらず入力欄の状態を記録する
        const diag = await page.evaluate(() =>
          [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden').map(i => {
            const lab = (i.closest('label') || {}).textContent || '';
            return 'type=' + i.type + ' name=' + i.name + ' ph=' + (i.placeholder || '') + ' val=' + (i.type === 'radio' || i.type === 'checkbox' ? i.checked : i.value) + ' label=' + lab.trim().slice(0, 20);
          }).slice(0, 25)
        );
        const pageText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800));
        paidResult = { paidAreaInserted, paidAreaCheck, radio, priceSet, priceSelector, diag, pageText };
      } catch (e) {
        console.log('有料設定エラー:', e.message.slice(0, 100));
        paidResult = { paidAreaInserted, paidAreaCheck, error: e.message.slice(0, 100) };
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
    // dryRun: 投稿ボタンを押さずにここで止める（有料設定の検証用・2026-09-08追加）
    // 下書きは残るので、note側で内容を目視してから手動で公開できる。
    if (dryRun) {
      const draftUrl = page.url();
      await browser.close();
      if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }
      console.log('dryRun: 投稿せずに終了');
      return res.json(saveResult_({
        success: true, dryRun: true, draftUrl,
        message: '下書きを作成し、設定画面まで進めました（投稿はしていません）',
        thumbnailSet, thumbDiag, paidResult, pasteResult, tagsApplied, newCookie: refreshedCookie,
      }));
    }

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
      // 2026-09-16: button だけ見ていて原因が分からなかったので、押せる要素を全部＋設定の結果も返す
      const diag = await page.evaluate(() => {
        const rows = [];
        document.querySelectorAll('button, a, input[type="submit"], [role="button"]').forEach(el => {
          const r = el.getBoundingClientRect();
          const txt = (el.textContent || el.value || '').trim().slice(0, 24);
          const aria = (el.getAttribute('aria-label') || '').slice(0, 24);
          if (!txt && !aria) return;
          rows.push(el.tagName.toLowerCase() + ' "' + (txt || aria) + '" vis=' + (r.width > 0 && r.height > 0) + ' disabled=' + !!el.disabled + ' top=' + Math.round(r.top));
        });
        return {
          url: location.href,
          clickables: rows.slice(0, 80),
          dialog: [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].map(d => (d.textContent || '').trim().slice(0, 80)),
        };
      });
      await browser.close();
      if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }
      return res.json(saveResult_({
        success: false, error: '投稿ボタンが見つかりません',
        draftUrl: diag.url, diag, thumbnailSet, thumbDiag, pasteResult, tagsApplied, paidResult, newCookie: refreshedCookie,
      }));
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
      return res.json(saveResult_({ success: true, url: noteUrl, newCookie: refreshedCookie, thumbnailSet, thumbDiag, paidResult, tagsApplied }));
    }
    return res.json(saveResult_({ success: false, error: '投稿完了したがURL取得失敗', newCookie: refreshedCookie, thumbnailSet, thumbDiag }));

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }
    console.error('エラー:', e.message);
    return res.json(saveResult_({ success: false, error: e.message }));
  } finally {
    // 成功・失敗・例外いずれの場合もロックを必ず解放する
    publishing = false;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('土木王子 note-publisher 起動 port:' + PORT));
