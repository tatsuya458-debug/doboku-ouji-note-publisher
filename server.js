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

    // 投稿ボタン（1段階目）
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
      const allButtons = await page.locator('button').all();
      const buttonInfos = [];
      for (const btn of allButtons) {
        const text = (await btn.innerText().catch(() => '')).trim();
        const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
        const visible = await btn.isVisible().catch(() => false);
        buttonInfos.push({ text, ariaLabel, visible });
      }
      await browser.close();
      return res.json({ success: false, error: '投稿ボタンが見つかりません', buttons: buttonInfos });
    }

    await publishBtn.click();
    console.log('投稿ボタン1段階目クリック完了');

    // モーダル/ダイアログが開くまで待つ（最大5秒）
    await page.waitForTimeout(4000);

    // モーダル内ボタンをログ
    const afterClickButtons = await page.locator('button').all();
    const afterButtonInfos = [];
    for (const btn of afterClickButtons) {
      const text = (await btn.innerText().catch(() => '')).trim();
      const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
      const visible = await btn.isVisible().catch(() => false);
      afterButtonInfos.push({ text, ariaLabel, visible });
    }
    console.log('クリック後ボタン一覧:', JSON.stringify(afterButtonInfos));

    // 確認ボタン（2段階目）- モーダル内の最終投稿ボタン
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
      // lastを使って最後のボタン（モーダル内のもの）を優先
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
      console.log('確認ボタンが見つからなかったため、URLをそのまま確認します');
    }

    // URL変化をポーリングで確認（waitForURLより柔軟）
    let noteUrl = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      console.log('URL確認:', u);
      if (u.includes('/n/') && u.includes('note.com')) {
        noteUrl = u.split('?')[0];
        break;
      }
    }

    if (!noteUrl) {
      const finalUrl = page.url();
      await browser.close();
      return res.json({
        success: false,
        error: 'URL変化タイムアウト finalUrl=' + finalUrl,
        confirmed,
        afterButtons: afterButtonInfos
      });
    }

    await browser.close();
    return res.json({ success: true, url: noteUrl });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('起動しました port:' + PORT));
