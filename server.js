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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
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

    if (page.url().includes('/login') || page.url().includes('/signin')) {
      await browser.close();
      return res.json({ success: false, error: 'Cookie切れ。GASでsetNoteCookie()を再実行してください' });
    }

    const titleInput = page.locator('input[placeholder*="タイトル"], [data-placeholder*="タイトル"]').first();
    await titleInput.waitFor({ timeout: 15000 });
    await titleInput.click();
    await titleInput.fill(title);

    const bodyInput = page.locator('.ProseMirror, [contenteditable="true"]').first();
    await bodyInput.click();
    await page.keyboard.type(body, { delay: 5 });

    const publishBtn = page.locator('button:has-text("投稿する")').first();
    await publishBtn.waitFor({ timeout: 10000 });
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
