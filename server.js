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

    const cookies = cookie.split('; ').map(c => {
      const eqIdx = c.indexOf('=');
      return {
        name: c.substring(0, eqIdx).trim(),
        value: c.substring(eqIdx + 1).trim(),
        domain: '.note.com',
        path: '/'
      };
    }).filter(c => c.name && c.value);
    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto('https://note.com/notes/new', { waitUntil: 'networkidle', timeout: 30000 });

    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log('URL:', currentUrl, 'PageTitle:', pageTitle);

    if (currentUrl.includes('/login') || currentUrl.includes('/signin')) {
      await browser.close();
      return res.json({ success: false, error: 'Cookie切れ。GASでsetNoteCookie()を再実行してください' });
    }

    // タイトル欄を複数セレクタで探す
    const titleSelectors = [
      'input[placeholder*="タイトル"]',
      'textarea[placeholder*="タイトル"]',
      '[data-placeholder*="タイトル"]',
      'input[name="name"]',
      'input[class*="title" i]',
      'textarea[class*="title" i]',
      'input[type="text"]',
      'textarea',
    ];

    let titleEl = null;
    for (const sel of titleSelectors) {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        titleEl = el;
        console.log('タイトルセレクタ:', sel);
        break;
      }
    }

    if (!titleEl) {
      await browser.close();
      return res.json({ success: false, error: 'タイトル欄が見つかりません URL=' + currentUrl + ' title=' + pageTitle });
    }

    await titleEl.click();
    await titleEl.fill(title);
    await page.waitForTimeout(1000);

    // 本文欄
    const bodyEl = page.locator('.ProseMirror, [contenteditable="true"]').first();
    const bodyVisible = await bodyEl.isVisible({ timeout: 5000 }).catch(() => false);
    if (!bodyVisible) {
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

    const confirmBtn = page.locator('button:has-text("公開する"), button:has-text("投稿する")').last();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    await page.waitForURL('**/n/**', { timeout: 20000 });
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
