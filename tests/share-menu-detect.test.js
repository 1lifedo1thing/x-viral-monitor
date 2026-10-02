// Share-menu detection decides where "Copy as Markdown" is injected.
// The X Articles block inserter is also a role="menu". Its 链接预览 /
// Link preview item used to satisfy the old "any 链接 / any *Link* test id"
// heuristic, so the copy items landed in the longform editor.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(resolve(here, '..', 'content.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const helpers = ['menuItemLabel', 'isArticleBlockInsertMenu', 'isShareMenu']
  .map((name) => extractFunction(content, name))
  .filter(Boolean)
  .join('\n');
const ctx = { isShareMenu: null };
vm.runInNewContext(`${helpers}\nthis.isShareMenu = isShareMenu;`, ctx);
const { isShareMenu } = ctx;

function menuItem(text, extra = {}) {
  return {
    textContent: text,
    attrs: { role: 'menuitem', ...extra },
    getAttribute(name) { return this.attrs[name] ?? null; },
  };
}

function matchOne(el, sel) {
  sel = sel.trim();
  const body = sel.match(/^\[(.+)\]$/)?.[1];
  if (!body) return false;
  let flag = '';
  let rest = body;
  const flagMatch = body.match(/\s+([i])$/);
  if (flagMatch) {
    flag = flagMatch[1];
    rest = body.slice(0, flagMatch.index);
  }
  const contains = rest.match(/^([a-zA-Z0-9_-]+)\*="([^"]*)"$/);
  if (contains) {
    const val = el.getAttribute(contains[1]);
    if (val == null) return false;
    const hay = flag ? val.toLowerCase() : val;
    const needle = flag ? contains[2].toLowerCase() : contains[2];
    return hay.includes(needle);
  }
  const eq = rest.match(/^([a-zA-Z0-9_-]+)="([^"]*)"$/);
  if (eq) return el.getAttribute(eq[1]) === eq[2];
  const hasAttr = rest.match(/^([a-zA-Z0-9_-]+)$/);
  if (hasAttr) return el.getAttribute(hasAttr[1]) != null;
  return false;
}

function menu(items) {
  const match = (el, sel) => sel.split(',').some((part) => matchOne(el, part));
  return {
    querySelector(sel) { return items.find((el) => match(el, sel)) || null; },
    querySelectorAll(sel) { return items.filter((el) => match(el, sel)); },
  };
}

describe('isShareMenu', () => {
  it('recognizes the native share dropdown in zh, en, and ja', () => {
    expect(isShareMenu(menu([
      menuItem('通过私信发送'),
      menuItem('复制链接', { 'data-testid': 'copyLink' }),
    ]))).toBe(true);
    expect(isShareMenu(menu([
      menuItem('Send via Direct Message'),
      menuItem('Copy link to post'),
    ]))).toBe(true);
    expect(isShareMenu(menu([
      menuItem('ダイレクトメッセージで送信'),
      menuItem('リンクをコピー'),
    ]))).toBe(true);
    expect(isShareMenu(menu([menuItem('复制帖子链接')]))).toBe(true);
    expect(isShareMenu(menu([menuItem('', { 'data-testid': 'copyLink' })]))).toBe(true);
  });

  it('does not treat the X Articles block inserter as a share menu', () => {
    const articleZh = menu([
      '媒体', 'GIF', '帖子', '链接预览', '分割线', '代码', 'LaTeX', '表格',
    ].map((label) => menuItem(label, label === '链接预览' ? { 'data-testid': 'linkPreview' } : {})));
    const articleEn = menu([
      'Media', 'GIF', 'Post', 'Link preview', 'Divider', 'Code', 'LaTeX', 'Table',
    ].map((label) => menuItem(label, label === 'Link preview' ? { 'data-testid': 'addLink' } : {})));
    const articleJa = menu([
      'メディア', 'GIF', 'ポスト', 'リンクプレビュー', '区切り線', 'コード', 'LaTeX', '表',
    ].map((label) => menuItem(label)));

    expect(isShareMenu(articleZh)).toBe(false);
    expect(isShareMenu(articleEn)).toBe(false);
    expect(isShareMenu(articleJa)).toBe(false);
  });

  it('does not treat an unrelated menu that merely mentions a link test id as share', () => {
    expect(isShareMenu(menu([
      menuItem('隐藏', { 'data-testid': 'muteLink' }),
      menuItem('屏蔽', { 'data-testid': 'block' }),
    ]))).toBe(false);
  });
});
