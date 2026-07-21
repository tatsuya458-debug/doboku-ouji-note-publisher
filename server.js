const express = require('express');
const { chromium } = require('playwright');
const { writeFileSync, unlinkSync, existsSync } = require('fs');
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
// GET /candidates?q=kw1,kw2,kw3&size=10
// note検索APIの代理取得（GASはnoteに直接アクセスすると403のため）
// まず普通のfetchを試し、ダメなら実ブラウザ(Playwright)で取得する
// ============================================================
const NOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const searchUrl = (q, size) =>
  'https://note.com/api/v3/searches?context=note&q=' + encodeURIComponent(q) + '&size=' + size;

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
          const path = '/api/v3/searches?context=note&q=' + encodeURIComponent(q) + '&size=' + size;
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
      await browser.close();
    } catch (e) {
      if (browser) await browser.close().catch(() => {});
      console.log('candidates: browser launch failed: ' + e.message);
      debug.push('launch:ERR ' + String(e.message).slice(0, 60));
    }
  }

  res.json({ success: true, results, debug });
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

    if (page.url().includes('/login') || page.url().includes('/signin') || page.url().includes('/sign_in')) {
      await browser.close();
      return res.json({ success: false, error: 'Cookie切れ。setNoteCookie()を再実行してください' });
    }

    const editorUrl = page.url();
    console.log('エディターURL:', editorUrl);

    // ============================================================
    // Step 2: サムネイル設定
    // ============================================================
    if (thumbPath && existsSync(thumbPath)) {
      console.log('サムネイル設定中...');
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);

        const addImgBtn = page.locator('button[aria-label="画像を追加"]').first();
        if (await addImgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await addImgBtn.click();
          await page.waitForTimeout(1500);

          const uploadBtn = page.locator('button:has-text("画像をアップロード")').first();
          if (await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            const [fc] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 10000 }),
              uploadBtn.click(),
            ]);
            await fc.setFiles(thumbPath);
            await page.waitForTimeout(3000);

            // トリミングモーダルの「保存」
            const saveBtn = page.locator('.ReactModal__Content button:has-text("保存")').first();
            if (await saveBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
              await saveBtn.click();
              await page.waitForTimeout(4000);
            }
            console.log('サムネイル設定完了');
          }
        }
      } catch (e) {
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

    await browser.close();
    if (thumbPath && existsSync(thumbPath)) { try { unlinkSync(thumbPath); } catch {} }

    if (noteUrl) {
      return res.json({ success: true, url: noteUrl });
    }
    return res.json({ success: false, error: '投稿完了したがURL取得失敗' });

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
