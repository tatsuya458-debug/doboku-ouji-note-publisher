const express = require('express');
const { chromium } = require('playwright');
const { writeFileSync, unlinkSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

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
    const pubBtn = page.locator('button:has-text("公開に進む")').first();
    if (!await pubBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await browser.close();
      return res.json({ success: false, error: '「公開に進む」ボタンが見つかりません' });
    }
    await pubBtn.click();
    await page.waitForTimeout(2500);

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
    const postSelectors = [
      'button:has-text("投稿する")',
      'button:has-text("公開する")',
      'button:has-text("投稿")',
      'button:has-text("公開")',
    ];

    let posted = false;
    for (const sel of postSelectors) {
      const btn = page.locator(sel).last();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        posted = true;
        console.log('投稿ボタンクリック:', sel);
        break;
      }
    }

    if (!posted) {
      await browser.close();
      return res.json({ success: false, error: '投稿ボタンが見つかりません' });
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
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('土木王子 note-publisher 起動 port:' + PORT));
