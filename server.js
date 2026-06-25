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
      'button[aria-label*="publish"]',
      '[data-testid*="publish"]',
      '[data-testid*="post"]',
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

    // 公開設定ページ（/publish/）への遷移を待つ
    await page.waitForTimeout(4000);
    const publishPageUrl = page.url();
    console.log('公開設定ページURL:', publishPageUrl);

    // URLからnote IDを抽出（例: /notes/n3b157fd7e1c1/publish/）
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
      const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        await btn.click();
        console.log('確認ボタンクリック:', sel);
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      await browser.close();
      return res.json({ success: false, error: '確認ボタンが見つかりません', noteId });
    }

    // 投稿APIの完了を待つ
    await page.waitForTimeout(5000);

    // URL変化チェック（/n/ パターン）
    const afterUrl = page.url();
    console.log('投稿後URL:', afterUrl);
    if (afterUrl.includes('/n/') && afterUrl.includes('note.com')) {
      await browser.close();
      return res.json({ success: true, url: afterUrl.split('?')[0] });
    }

    // note.com APIでnote IDから公開URLを取得
    if (noteId) {
      await page.goto(`https://note.com/api/v2/notes/${noteId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const bodyText = await page.locator('body').innerText().catch(() => '{}');
      console.log('API response (first 200):', bodyText.substring(0, 200));
      try {
        const apiData = JSON.parse(bodyText);
        const key = apiData.data?.key || '';
        const urlname = apiData.data?.user?.urlname || '';
        const status = apiData.data?.status || '';
        console.log('note key:', key, 'urlname:', urlname, 'status:', status);
        if (key && urlname) {
          const noteUrl = `https://note.com/${urlname}/n/${key}`;
          await browser.close();
          return res.json({ success: true, url: noteUrl, status });
        }
      } catch (e) {
        console.log('APIパースエラー:', e.message);
      }
    }

    await browser.close();
    return res.json({
      success: false,
      error: 'URLを特定できませんでした',
      noteId,
      afterUrl,
      publishPageUrl
    });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('起動しました port:' + PORT));
