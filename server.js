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

    // .note.com と editor.note.com 両方にCookieを設定
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

    // エディタ読み込み待ち
    await page.waitForTimeout(3000);

    // タイトル欄を探す（editor.note.comはcontenteditable使用）
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

    // フォールバック: 最初のcontenteditable div
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

    // 本文欄（2番目のcontenteditable または ProseMirror）
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

    // 投稿ボタン
    const publishBtn = page.locator('button:has-text("投稿する"), button:has-text("公開する")').first();
    const btnVisible = await publishBtn.isVisible({ timeout: 10000 }).catch(() => false);
    if (!btnVisible) {
      await browser.close();
      return res.json({ success: false, error: '投稿ボタンが見つかりません' });
    }
    await publishBtn.click();
    await page.waitForTimeout(2000);

    // 確認ダイアログ
    const confirmBtn = page.locator('button:has-text("公開する"), button:has-text("投稿する")').last();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // 公開後URLを待つ（note.com または editor.note.com の /n/ パス）
    await page.waitForURL(/note\.com.*\/n\//, { timeout: 20000 });
    const noteUrl = page.url().split('?')[0];

    await browser.close();
    return res.json({ success: true, url: noteUrl });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('起動しました port:' + PORT));
