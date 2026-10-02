import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://xvm.icy-cat.com/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path.endsWith('/') ? `${path}index.html` : path;
    const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    await route.fulfill({ body: readFileSync(resolve(root, `docs${file}`)), contentType });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, lang] of [['/', 'en'], ['/zh/', 'zh-CN'], ['/ja/', 'ja']]) {
        await page.goto(`https://xvm.icy-cat.com${path}`);
        const state = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          lang: document.documentElement.lang,
          background: getComputedStyle(document.body).backgroundColor,
          primary: getComputedStyle(document.querySelector('.hero .primary')).backgroundColor,
          links: [...document.querySelectorAll('.btn')].map(a => a.getAttribute('href')),
          edgeLinks: [...document.querySelectorAll('a[href^="https://microsoftedge.microsoft.com/addons/detail/cefdokfllohmgiccdbjokdagbgegpghd"]')].map(a => a.textContent),
        }));
        assert.equal(state.width, width);
        assert.equal(state.scrollWidth, width, `${path} overflows at ${width}px`);
        assert.equal(state.lang, lang);
        assert.equal(state.background, colorScheme === 'light' ? 'rgb(242, 242, 247)' : 'rgb(28, 28, 30)');
        assert.equal(state.primary, colorScheme === 'light' ? 'rgb(0, 104, 217)' : 'rgb(77, 163, 255)');
        assert(state.links.every(Boolean));
        assert.deepEqual(state.edgeLinks, [lang === 'en' ? 'Install Edge extension' : lang === 'ja' ? 'Edge 拡張を入れる' : '安装 Edge 扩展', lang === 'en' ? 'Install Edge extension' : lang === 'ja' ? 'Edge 拡張を入れる' : '安装 Edge 扩展', 'Edge Add-ons']);
        if (width !== 768) await page.screenshot({ path: `/tmp/xvm-checked-${lang}-${width}-${colorScheme}.png`, fullPage: true });
        console.log(`PASS ${path} ${width}px ${colorScheme}`);
      }
    }
  }
  await page.goto('https://xvm.icy-cat.com/');
  await page.locator('.lang-switch button[data-lang="zh"]').click();
  await page.waitForURL('https://xvm.icy-cat.com/zh/');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  for (const guide of ['x-views-per-hour', 'find-viral-tweets', 'x-analytics-without-premium', 'ai-twitter-reply-generator', 'best-twitter-chrome-extensions', 'convert-tweet-to-markdown']) {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`https://xvm.icy-cat.com/${guide}.html`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${guide} overflows`);
      assert.equal(await page.locator('body').getAttribute('data-lang'), 'mac');
      assert(await page.locator('h1').textContent());
      console.log(`PASS ${guide} ${width}px`);
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
