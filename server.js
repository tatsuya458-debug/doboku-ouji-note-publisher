const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/publish', async (req, res) => {
  const { title, body, cookie } = req.body;
  if (!title || !body || !cookie) {
    return res.status(400).json({ success: false, error: 'title, body, cookie が必要です' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

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
    await page.goto('https://editor.note.com/new', { waitUntil: 'networkidle', timeout: 30000 });

    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log('URL:', currentUrl, 'PageTitle:', pageTitle);

    if (currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl.includes('/sign_in')) {
      await browser.close();
      return res.json({ success: false, error: 'Cookie切れ URL=' + currentUrl });
    }

    await page.waitForTimeout(3000);

    // タイトル欄
    const titleSelectors = [
      '[data-placeholder*="タイトル"]',
      '[placeholder*="タイトル"]',
      'input[type="text"]',
      'textarea',
    ];

    let titleEl = null;
    for (const sel of titleSelectors) {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        titleEl = el;
        console.log('タイトルセレクタ:', sel);
        break;
      }
    }

    if (!titleEl) {
      const contentEditables = page.locator('div[contenteditable="true"]');
      const count = await contentEditables.count().catch(() => 0);
      console.log('contenteditable要素数:', count);
      if (count > 0) {
        titleEl = contentEditables.first();
        console.log('contenteditable[0]をタイトルとして使用');
      }
    }

    if (!titleEl) {
      await browser.close();
      return res.json({ success: false, error: 'タイトル欄が見つかりません URL=' + currentUrl + ' title=' + pageTitle });
    }

    await titleEl.click();
    await page.keyboard.type(title);
    await page.waitForTimeout(500);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);

    // 本文欄
    let bodyEl = null;
    const contentEditables = page.locator('div[contenteditable="true"]');
    const ceCount = await contentEditables.count().catch(() => 0);
    console.log('本文探索 contenteditable数:', ceCount);

    if (ceCount >= 2) {
      bodyEl = contentEditables.nth(1);
    } else if (ceCount === 1) {
      bodyEl = contentEditables.first();
    } else {
      const proseMirror = page.locator('.ProseMirror').first();
      if (await proseMirror.isVisible({ timeout: 3000 }).catch(() => false)) {
        bodyEl = proseMirror;
      }
    }

    if (!bodyEl) {
      await browser.close();
      return res.json({ success: false, error: '本文欄が見つかりません' });
    }

    await bodyEl.click();
    await page.keyboard.type(body, { delay: 2 });
    await page.waitForTimeout(1000);

    // 投稿ボタン（1段階目：公開設定ページへ）
    const publishSelectors = [
      'button:has-text("投稿する")',
      'button:has-text("公開する")',
      'button:has-text("公開設定")',
      'button:has-text("保存して公開")',
      'button:has-text("投稿")',
      'button:has-text("公開")',
      'button[aria-label*="投稿"]',
      'button[aria-label*="公開"]',
    ];

    let publishBtn = null;
    for (const sel of publishSelectors) {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        publishBtn = btn;
        console.log('投稿ボタン1段階目セレクタ:', sel);
        break;
      }
    }

    if (!publishBtn) {
      await browser.close();
      return res.json({ success: false, error: '投稿ボタン(1段階目)が見つかりません' });
    }

    await publishBtn.click();
    console.log('投稿ボタン1段階目クリック完了');

    // 公開設定ページへのURL変化を待つ
    try {
      await page.waitForURL(/editor\.note\.com\/notes\/n[a-zA-Z0-9]+\/publish/, { timeout: 15000 });
      console.log('publishページURLに変化確認');
    } catch (e) {
      console.log('waitForURL timeout, 現在URL:', page.url());
    }

    await page.waitForTimeout(3000);
    const publishPageUrl = page.url();
    console.log('公開設定ページURL:', publishPageUrl);

    // URLからnote IDを抽出
    const noteIdMatch = publishPageUrl.match(/\/notes\/(n[a-zA-Z0-9]+)/);
    const noteId = noteIdMatch ? noteIdMatch[1] : null;
    console.log('noteId:', noteId);

    // 2段階目：「投稿する」確認ボタン
    const confirmSelectors = [
      'button:has-text("投稿する")',
      'button:has-text("公開する")',
      'button:has-text("投稿")',
      'button:has-text("公開")',
      'button[aria-label*="投稿"]',
      'button[aria-label*="公開"]',
    ];

    let confirmed = false;
    for (const sel of confirmSelectors) {
      const btn = page.locator(sel).last();
      const visible = await btn.isVisible({ timeout: 5000 }).catch(() => false);
      if (visible) {
        await btn.click();
        console.log('確認ボタンクリック:', sel);
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      const allButtons = await page.locator('button').all();
      const buttonInfos = [];
      for (const btn of allButtons) {
        const text = (await btn.innerText().catch(() => '')).trim();
        const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
        const visible = await btn.isVisible().catch(() => false);
        buttonInfos.push({ text, ariaLabel, visible });
      }
      await browser.close();
      return res.json({ success: false, error: '確認ボタンが見つかりません', noteId, publishPageUrl, buttons: buttonInfos });
    }

    // 投稿完了を待つ
    let noteUrl = null;
    try {
      await page.waitForURL(/note\.com.*\/n\//, { timeout: 10000 });
      noteUrl = page.url().split('?')[0];
    } catch (e) {
      console.log('URL変化なし、ユーザー名から構築します');
    }

    if (noteUrl) {
      await browser.close();
      return res.json({ success: true, url: noteUrl });
    }

    // ユーザー名取得（優先順位順）
    let urlname = '';

    if (noteId) {
      // 1) note.comトップページの__NEXT_DATA__スクリプトタグからJSON検索
      await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });

      urlname = await page.evaluate(() => {
        try {
          // __NEXT_DATA__ のDOMエレメントから取得
          const el = document.getElementById('__NEXT_DATA__');
          if (el) {
            const str = el.textContent || '';
            // "urlname":"xxxx" を検索
            const m = str.match(/"urlname":"([a-zA-Z0-9_]+)"/);
            if (m) return m[1];
          }
          // scriptタグ全体からも検索
          const scripts = Array.from(document.querySelectorAll('script:not([src])'));
          for (const s of scripts) {
            const text = s.textContent || '';
            const m = text.match(/"urlname":"([a-zA-Z0-9_]+)"/);
            if (m) return m[1];
          }
        } catch (e) {}
        return '';
      }).catch(() => '');
      console.log('ページから取得したurlname:', urlname);

      // 2) 環境変数 NOTE_USERNAME をフォールバックとして使用
      if (!urlname && process.env.NOTE_USERNAME) {
        urlname = process.env.NOTE_USERNAME;
        console.log('環境変数からurlname:', urlname);
      }

      if (urlname) {
        await browser.close();
        return res.json({ success: true, url: `https://note.com/${urlname}/n/${noteId}` });
      }

      // 3) ユーザー名が取れなかった場合もnoteIdは返す
      await browser.close();
      return res.json({
        success: false,
        error: 'ユーザー名取得失敗（NOTE_USERNAME環境変数を設定してください）',
        noteId
      });
    }

    await browser.close();
    return res.json({ success: false, error: 'noteId取得失敗', publishPageUrl });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('起動しました port:' + PORT));
