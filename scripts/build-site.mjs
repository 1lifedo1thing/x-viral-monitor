#!/usr/bin/env node
// 官网预渲染：site/index.html（源模板，三语文案在页内 siteI18n）→ docs/ 下每种语言一个静态页。
//   /      英文（x-default）   /zh/  中文   /ja/  日文
// 静态 HTML 里就是对应语言的正文和 TDK，搜索引擎不用执行 JS 也能读到；页内 JS 仍会按路径再套一次，结果相同。
// 顺带生成 sitemap.xml（带 hreflang）和 robots.txt。改完 site/ 必须跑 `npm run build:site` 再提交 docs/。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://xvm.icy-cat.com';
const LANGS = { en: { path: '/', hreflang: 'en' }, zh: { path: '/zh/', hreflang: 'zh-CN' }, ja: { path: '/ja/', hreflang: 'ja' } };
const version = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')).version;
const template = pathToFileURL(resolve(ROOT, 'site/index.html')).href;
copyFileSync(resolve(ROOT, 'icons/icon128.png'), resolve(ROOT, 'docs/favicon.png'));

for (const asset of ['icycat-uiux.css', 'site.css']) {
  copyFileSync(resolve(ROOT, 'site', asset), resolve(ROOT, 'docs', asset));
}

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();
for (const [lang, { path }] of Object.entries(LANGS)) {
  await page.goto(`${template}?prerender=${lang}`);
  const html = await page.evaluate(({ lang, LANGS, ORIGIN, version }) => {
    const head = document.head;
    head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((l) => l.remove());
    const canonical = head.querySelector('link[rel="canonical"]');
    canonical.href = ORIGIN + LANGS[lang].path;
    for (const [k, v] of [...Object.entries(LANGS), ['x-default', LANGS.en]]) {
      const l = document.createElement('link');
      l.rel = 'alternate';
      l.hreflang = k === 'x-default' ? 'x-default' : v.hreflang;
      l.href = ORIGIN + v.path;
      canonical.after(l);
    }
    const ld = head.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(ld.textContent);
    data.softwareVersion = version;
    data.url = ORIGIN + LANGS[lang].path;
    data.inLanguage = LANGS[lang].hreflang;
    ld.textContent = JSON.stringify(data, null, 2);
    return '<!doctype html>\n' + document.documentElement.outerHTML + '\n';
  }, { lang, LANGS, ORIGIN, version });
  const out = resolve(ROOT, 'docs', `.${path}`, 'index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote docs${path}index.html`);
}
await browser.close();

// 内容页（docs/*.html，英文单语）也进 sitemap
const extra = readdirSync(resolve(ROOT, 'docs')).filter((f) => f.endsWith('.html') && f !== 'index.html');
const alt = Object.values(LANGS).map((v) => `    <xhtml:link rel="alternate" hreflang="${v.hreflang}" href="${ORIGIN}${v.path}"/>`).join('\n')
  + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`;
const urls = [
  ...Object.values(LANGS).map((v) => `  <url>\n    <loc>${ORIGIN}${v.path}</loc>\n${alt}\n  </url>`),
  ...extra.map((f) => `  <url>\n    <loc>${ORIGIN}/${f}</loc>\n  </url>`),
];
writeFileSync(resolve(ROOT, 'docs/sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
writeFileSync(resolve(ROOT, 'docs/robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
console.log(`wrote docs/sitemap.xml (${urls.length} urls), docs/robots.txt`);
