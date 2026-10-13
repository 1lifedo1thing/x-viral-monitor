#!/usr/bin/env node
/**
 * Timed bench for back-navigation scroll restore (~10 scenario runs).
 * Simulates the restore state machine from content.js against a scripted
 * DOM/clock (same approach as tests/back-scroll-restore.test.js).
 * Live x.com hops cannot be measured without a logged-in Playwright profile.
 *
 * Usage: node scripts/bench-scroll-restore.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const content = readFileSync(resolve(repo, 'content.js'), 'utf8');
const MARKER = '// Back-navigation scroll-restore guard.';
const guardSrc = content.slice(content.indexOf(MARKER));
const HIDE_SEL = '[data-xvm-content-filter-hidden], [data-xvm-rate-hidden]';

function makeArticle(h, { docTop, id, hiddenAttrs = false, height = 100 }) {
  const art = {
    id,
    docTop,
    hiddenAttrs,
    height,
    width: 400,
    matches: (sel) => (sel === HIDE_SEL ? false : false),
    closest: (sel) => {
      if (sel === 'article[data-testid="tweet"]') return art;
      if (sel === '[role="dialog"]') return null;
      if (sel === HIDE_SEL) return null;
      if (sel === '[role="dialog"], [aria-hidden="true"], [hidden], [inert]') {
        return art.hiddenAttrs ? {} : null;
      }
      return null;
    },
    getBoundingClientRect: () => ({
      top: art.docTop - h.scrollY,
      bottom: art.docTop - h.scrollY + art.height,
      height: art.height,
      width: art.width,
    }),
  };
  return art;
}

function makeHarness({ hiddenPresent = false, homeShellReady = true } = {}) {
  const winListeners = new Map();
  const docListeners = new Map();
  let rafQ = [];
  const observers = [];
  const h = {
    clock: 0,
    scrollY: 0,
    scrollToCalls: [],
    scrollKinds: [],
    hiddenPresent,
    homeShellReady,
    articles: [],
    scrollRestoration: 'auto',
    pendingTimeouts: [],
    styleEls: new Map(),
    scrollHeight: 50000,
  };
  const listen = (map) => (ev, fn) => {
    if (!map.has(ev)) map.set(ev, []);
    map.get(ev).push(fn);
  };
  const unlisten = (map) => (ev, fn) => {
    const l = map.get(ev) || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  h.pathname = '/home';
  const win = {
    location: { get pathname() { return h.pathname; } },
    get scrollY() { return h.scrollY; },
    scrollTo(x, y) {
      h.scrollToCalls.push(Math.round(y));
      h.scrollY = y;
    },
    scrollBy(x, y) {
      h.scrollToCalls.push(Math.round(h.scrollY + y));
      h.scrollY = h.scrollY + y;
    },
    addEventListener: listen(winListeners),
    removeEventListener: unlisten(winListeners),
    innerHeight: 800,
    __xvmScrollRestoreDebug: true,
    __xvmScrollRestoreLog: [],
  };
  const primaryColumn = {
    querySelector: (sel) => (sel === '[role="tablist"]' && h.homeShellReady ? {} : null),
  };
  const doc = {
    querySelector: (sel) => {
      if (sel === HIDE_SEL) return h.hiddenPresent ? {} : null;
      if (sel === '[data-testid="primaryColumn"]') return primaryColumn;
      return null;
    },
    querySelectorAll: (sel) => (sel === 'article[data-testid="tweet"]' ? h.articles : []),
    addEventListener: listen(docListeners),
    removeEventListener: unlisten(docListeners),
    getElementById: (id) => h.styleEls.get(id) || null,
    createElement: () => {
      const el = { id: '', textContent: '', remove() { h.styleEls.delete(el.id); } };
      return el;
    },
    documentElement: {
      appendChild: (el) => { h.styleEls.set(el.id, el); },
      clientHeight: 800,
      get scrollTop() { return h.scrollY; },
      set scrollTop(v) { h.scrollY = v; },
      get scrollHeight() { return h.scrollHeight; },
    },
    body: { get scrollHeight() { return h.scrollHeight; } },
    scrollingElement: null,
  };
  Object.defineProperty(doc, 'scrollingElement', {
    get() {
      return {
        get scrollTop() { return h.scrollY; },
        set scrollTop(v) { h.scrollY = v; },
        get scrollHeight() { return h.scrollHeight; },
      };
    },
  });
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {
      const i = observers.indexOf(this);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  const historyObj = {
    get scrollRestoration() { return h.scrollRestoration; },
    set scrollRestoration(v) { h.scrollRestoration = v; },
  };
  const ctx = {
    window: win,
    document: doc,
    history: historyObj,
    performance: { now: () => h.clock },
    requestAnimationFrame: (cb) => { rafQ.push(cb); },
    getTweetIdFromArticle: (art) => art.id || null,
    setTimeout: (fn) => { h.pendingTimeouts.push(fn); return h.pendingTimeouts.length; },
    clearTimeout: () => {},
    MutationObserver: FakeMutationObserver,
    Math, Map, Set, Infinity, Number, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(guardSrc, ctx);
  h.win = win;
  h.fire = (ev, detail = {}) => {
    for (const fn of [...(winListeners.get(ev) || [])]) fn({ type: ev, ...detail });
  };
  h.firePointerDown = (art) => {
    for (const fn of [...(docListeners.get('pointerdown') || [])]) {
      fn({ target: { closest: (sel) => (sel === 'article[data-testid="tweet"]' ? art : null) } });
    }
  };
  h.fireMutations = () => {
    for (const ob of [...observers]) ob.cb([]);
  };
  h.pumpFrames = (n) => {
    for (let i = 0; i < n; i++) {
      h.clock += 16;
      const q = rafQ;
      rafQ = [];
      for (const cb of q) cb();
    }
  };
  h.pumpUntil = (pred, maxFrames = 400) => {
    for (let i = 0; i < maxFrames; i++) {
      h.pumpFrames(1);
      if (pred()) return i + 1;
    }
    return maxFrames;
  };
  return h;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(runs) {
  const jumps = runs.map((r) => r.jumps).sort((a, b) => a - b);
  const firstPin = runs.map((r) => r.firstPinAt ?? r.stableAt).sort((a, b) => a - b);
  const stable = runs.map((r) => r.stableAt).sort((a, b) => a - b);
  const finished = runs.map((r) => r.finishedAt).sort((a, b) => a - b);
  const suppressed = runs.map((r) => r.suppressed).sort((a, b) => a - b);
  return {
    n: runs.length,
    jumps: { p50: percentile(jumps, 50), p90: percentile(jumps, 90), max: jumps[jumps.length - 1], mean: +(jumps.reduce((a, b) => a + b, 0) / jumps.length).toFixed(2) },
    firstPinMs: { p50: percentile(firstPin, 50), p90: percentile(firstPin, 90), max: firstPin[firstPin.length - 1] },
    stableMs: { p50: percentile(stable, 50), p90: percentile(stable, 90), max: stable[stable.length - 1] },
    finishedMs: { p50: percentile(finished, 50), p90: percentile(finished, 90), max: finished[finished.length - 1] },
    suppressed: { p50: percentile(suppressed, 50), p90: percentile(suppressed, 90), max: suppressed[suppressed.length - 1] },
  };
}

/** Scenario runners: each returns metrics from __xvmScrollRestoreFinished */
const scenarios = [
  {
    name: 'A_immediate_pin_deep',
    desc: 'Anchor mounted, shell ready, X landed far — one pin',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 8424, id: 'T1' });
      h.articles = [art];
      h.scrollY = 8224;
      h.firePointerDown(art); // top=200
      h.scrollY = 15100; // X wrong window
      // X tries to restore while we defend
      h.fire('popstate');
      h.win.scrollTo(0, 9999);
      h.win.scrollBy(0, 400);
      h.pumpUntil(() => h.win.__xvmScrollRestoreFinished, 200);
      // also pump to post-guard finish
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
  {
    name: 'B_late_anchor_mount',
    desc: 'Skip clamped coarse; fine pin when cell remounts',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      h.scrollHeight = 2000; // maxY=1200 ≪ want — must skip coarse
      const art = makeArticle(h, { docTop: 5424, id: 'T2' });
      h.articles = [art];
      h.scrollY = 5224;
      h.firePointerDown(art);
      h.articles = [];
      h.scrollY = 900;
      h.fire('popstate');
      h.win.scrollTo(0, 2000); // suppressed
      h.pumpFrames(20);
      h.scrollHeight = 20000;
      art.docTop = 5600;
      h.articles = [art];
      h.fireMutations();
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
  {
    name: 'C_shell_wait_then_pin',
    desc: 'Home tablist missing first — coarse then pin',
    run() {
      const h = makeHarness({ hiddenPresent: false, homeShellReady: false });
      const art = makeArticle(h, { docTop: 3424, id: 'T3' });
      h.articles = [art];
      h.scrollY = 3224;
      h.firePointerDown(art);
      h.scrollY = 7100;
      h.fire('popstate');
      h.pumpFrames(15);
      h.homeShellReady = true;
      art.docTop = 4000;
      h.fireMutations();
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
  {
    name: 'D_secondary_anchor',
    desc: 'Clicked tweet late; nearby visible anchor used',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const clicked = makeArticle(h, { docTop: 4424, id: 'T4a' });
      const near = makeArticle(h, { docTop: 4600, id: 'T4b' });
      h.articles = [clicked, near];
      h.scrollY = 4224;
      h.firePointerDown(clicked); // T4a@200, T4b@376
      h.articles = [near];
      near.docTop = 4600;
      h.scrollY = 8800;
      h.fire('popstate');
      h.pumpFrames(40);
      return finish(h, near, 376);
    },
  },
  {
    name: 'E_postguard_repin',
    desc: 'First pin then layout shift inside quiet window',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 2424, id: 'T5' });
      h.articles = [art];
      h.scrollY = 2224;
      h.firePointerDown(art);
      h.scrollY = 5100;
      h.fire('popstate');
      h.pumpFrames(3); // pin, still inside quiet window
      art.docTop = 2100; // layout shift before early-exit
      h.fireMutations();
      h.pumpFrames(30);
      return finish(h, art, 200);
    },
  },
  {
    name: 'F_already_correct',
    desc: 'X landed within 24px — pin_noop / zero jumps',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 1424, id: 'T6' });
      h.articles = [art];
      h.scrollY = 1224;
      h.firePointerDown(art);
      h.scrollY = 1230; // delta top = 194 vs saved 200 → |d|=6
      h.fire('popstate');
      h.win.scrollTo(0, 5000); // suppressed
      h.pumpFrames(40);
      return finish(h, art, 200, { allowLooseTop: true });
    },
  },
  {
    name: 'G_x_spam_scrolls',
    desc: 'Many X scrollTo/By during defend — all suppressed',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 6424, id: 'T7' });
      h.articles = [art];
      h.scrollY = 6224;
      h.firePointerDown(art);
      h.scrollY = 12000;
      h.fire('popstate');
      // Spam inside quiet/defend window only (~150ms), then let quiet exit.
      for (let i = 0; i < 12; i++) {
        h.win.scrollTo(0, 8000 + i * 100);
        h.win.scrollBy(0, 50);
      }
      h.pumpFrames(30);
      return finish(h, art, 200);
    },
  },
  {
    name: 'H_mid_depth',
    desc: 'Mid-feed depth, immediate pin',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 2800, id: 'T8' });
      h.articles = [art];
      h.scrollY = 2600;
      h.firePointerDown(art);
      h.scrollY = 4200;
      h.fire('popstate');
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
  {
    name: 'I_very_deep_late',
    desc: 'Very deep scroll, no clamp-coarse, pin when late',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      h.scrollHeight = 1500; // cannot reach
      const art = makeArticle(h, { docTop: 18424, id: 'T9' });
      h.articles = [art];
      h.scrollY = 18224;
      h.firePointerDown(art);
      h.articles = [];
      h.scrollY = 400;
      h.fire('popstate');
      h.pumpFrames(20); // ~320ms wait, no clamped hop
      h.scrollHeight = 40000;
      art.docTop = 18600;
      h.articles = [art];
      h.fireMutations();
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
  {
    name: 'J_bfcache_restore',
    desc: 'pageshow persisted path',
    run() {
      const h = makeHarness({ hiddenPresent: false });
      const art = makeArticle(h, { docTop: 3824, id: 'T10' });
      h.articles = [art];
      h.scrollY = 3624;
      h.firePointerDown(art);
      h.scrollY = 7000;
      h.fire('pageshow', { persisted: true });
      h.win.scrollTo(0, 1);
      h.pumpFrames(40);
      return finish(h, art, 200);
    },
  },
];

function finish(h, art, wantTop, opts = {}) {
  const fin = h.win.__xvmScrollRestoreFinished || h.win.__xvmScrollRestoreLast;
  const top = Math.round(art.getBoundingClientRect().top);
  const ok = opts.allowLooseTop
    ? Math.abs(top - wantTop) <= 24
    : Math.abs(top - wantTop) <= 2;
  return {
    scrollY: h.scrollY,
    top,
    wantTop,
    ok,
    controlledCalls: h.scrollToCalls.length,
    scrollToCalls: h.scrollToCalls.slice(),
    jumps: fin?.jumps ?? h.scrollToCalls.length,
    coarse: fin?.coarse ?? 0,
    pins: fin?.pins ?? 0,
    repins: fin?.repins ?? 0,
    suppressed: fin?.suppressed ?? 0,
    firstPinAt: fin?.firstPinAt != null ? Math.round(fin.firstPinAt) : null,
    stableAt: fin?.stableAt != null ? Math.round(fin.stableAt) : (fin?.lastMoveAt != null ? Math.round(fin.lastMoveAt) : null),
    finishedAt: fin?.finishedAt != null ? Math.round(fin.finishedAt) : null,
    events: fin?.events || [],
  };
}

const results = [];
for (const s of scenarios) {
  const t0 = Date.now();
  let r;
  try {
    r = s.run();
  } catch (e) {
    r = { ok: false, error: String(e), jumps: null, firstPinAt: null, stableAt: null, finishedAt: null, suppressed: null };
  }
  results.push({
    name: s.name,
    desc: s.desc,
    wallMs: Date.now() - t0,
    ...r,
  });
}

const summary = summarize(results.filter((r) => r.jumps != null));
const outDir = resolve(repo, '.tmp');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'scroll-restore-bench.json');
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2));

console.log('\n=== Scroll restore bench (10 simulated home→tweet→back runs) ===\n');
console.log('| # | scenario | jumps | coarse | pins | repins | suppressed | firstPinMs | stableMs | finishedMs | ok |');
console.log('|---|----------|------:|-------:|-----:|-------:|-----------:|-----------:|---------:|-----------:|:--:|');
results.forEach((r, i) => {
  console.log(
    `| ${i + 1} | ${r.name} | ${r.jumps ?? '—'} | ${r.coarse ?? '—'} | ${r.pins ?? '—'} | ${r.repins ?? '—'} | ${r.suppressed ?? '—'} | ${r.firstPinAt ?? '—'} | ${r.stableAt ?? '—'} | ${r.finishedAt ?? '—'} | ${r.ok ? 'Y' : 'N'} |`,
  );
});
console.log('\nSummary:', JSON.stringify(summary, null, 2));
console.log('\nWrote', outPath);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error('\nFAILED:', failed.map((f) => f.name + (f.error ? `: ${f.error}` : ` top=${f.top}`)).join(', '));
  process.exitCode = 1;
}
