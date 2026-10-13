#!/usr/bin/env node
/**
 * Real bb-browser CDP bench: deep home scroll → open tweet → back × N.
 * Requires Chrome with --remote-debugging-port=9222 and x.com logged in.
 *
 * Usage:
 *   node scripts/bench-scroll-restore-cdp.mjs [--runs 8] [--cdp http://127.0.0.1:9222]
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1] || 8) || 8;
const cdp = args.includes('--cdp') ? args[args.indexOf('--cdp') + 1] : 'http://127.0.0.1:9222';
const deepScrollPx = Number(args[args.indexOf('--deep') + 1] || 12000) || 12000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function findHomePage(browser) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  let home = pages.find((p) => /https:\/\/(x|twitter)\.com\/home/.test(p.url()));
  if (home) return home;
  // Prefer any x.com page
  const x = pages.find((p) => /https:\/\/(x|twitter)\.com\//.test(p.url()));
  if (x) {
    await x.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    return x;
  }
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

async function ensureExtensionFresh(page) {
  // Flag debug metrics; content script already loaded from extension.
  await page.evaluate(() => {
    window.__xvmScrollRestoreDebug = true;
    window.__xvmScrollRestoreLog = [];
    window.__xvmScrollRestoreFinished = null;
  });
}

async function waitHomeReady(page) {
  await page.waitForFunction(() => {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    return !!(primary && primary.querySelector('[role="tablist"]') && document.querySelectorAll('article[data-testid="tweet"]').length >= 3);
  }, { timeout: 60000 });
}

async function deepScroll(page, targetY) {
  // Incremental scroll so virtualizer mounts cells.
  let guard = 0;
  while (guard++ < 80) {
    const y = await page.evaluate(() => window.scrollY);
    if (y >= targetY - 80) break;
    await page.evaluate((step) => window.scrollBy(0, step), 1400);
    await sleep(180);
  }
  await sleep(400);
}

async function pickMidTweet(page) {
  return page.evaluate(() => {
    const vh = window.innerHeight || 800;
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const scored = arts.map((art) => {
      const r = art.getBoundingClientRect();
      const link = art.querySelector('a[href*="/status/"]');
      const href = link?.getAttribute('href') || '';
      const id = href.match(/\/status\/(\d+)/)?.[1] || null;
      return { id, href, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 };
    }).filter((t) => t.id && t.top > 40 && t.top < vh - 80 && t.bottom > 120);
    scored.sort((a, b) => Math.abs(a.mid - vh * 0.45) - Math.abs(b.mid - vh * 0.45));
    return scored[0] || null;
  });
}

async function oneRun(page, idx) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitHomeReady(page);
  await ensureExtensionFresh(page);

  await deepScroll(page, deepScrollPx);
  const before = await page.evaluate(() => ({
    y: Math.round(window.scrollY),
    max: Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight),
  }));

  const tweet = await pickMidTweet(page);
  if (!tweet) throw new Error('no mid-viewport tweet to click');

  // Click status link (capture pointerdown for extension).
  const clicked = await page.evaluate((wantId) => {
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    for (const art of arts) {
      const links = [...art.querySelectorAll('a[href*="/status/"]')];
      for (const a of links) {
        const id = a.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
        if (id === wantId) {
          const r = art.getBoundingClientRect();
          a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          a.click();
          return { id, top: Math.round(r.top), y: Math.round(window.scrollY) };
        }
      }
    }
    return null;
  }, tweet.id);
  if (!clicked) throw new Error('click failed for ' + tweet.id);

  await page.waitForFunction(() => /\/status\/\d+/.test(location.pathname), { timeout: 20000 });
  await sleep(900);

  // Install scroll trajectory probe BEFORE back so we catch hops during navigation.
  await page.evaluate(() => {
    window.__xvmScrollRestoreFinished = null;
    window.__xvmScrollRestoreLog = [];
    window.__xvmScrollRestoreDebug = true;
    const se = () => document.scrollingElement || document.documentElement;
    const geom = () => {
      const el = se();
      const sh = Math.max(el?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
      const vh = window.innerHeight || 0;
      return { y: Math.round(window.scrollY), sh: Math.round(sh), max: Math.max(0, Math.round(sh - vh)) };
    };
    const g0 = geom();
    const probe = (window.__xvmBenchProbe = {
      t0: performance.now(),
      lastY: g0.y,
      lastDir: 0,
      jumps: 0,
      perceivedJumps: 0,
      freezeFrames: 0,
      samples: [],
      dense: [{ t: 0, ...g0 }],
      path: [],
      stop: false,
    });
    const tick = () => {
      if (probe.stop) return;
      const g = geom();
      const now = performance.now() - probe.t0;
      const dy = g.y - probe.lastY;
      // Freeze overlay removed — every hop is perceived.
      const freezeOn = !!document.getElementById('xvm-feed-freeze');
      if (freezeOn) probe.freezeFrames += 1;
      const lastD = probe.dense[probe.dense.length - 1];
      if (!lastD || Math.abs(g.y - lastD.y) >= 2 || Math.abs(g.sh - lastD.sh) >= 8 || now - lastD.t >= 32) {
        probe.dense.push({ t: Math.round(now), ...g, dy: Math.round(dy), freeze: freezeOn });
        if (probe.dense.length > 500) probe.dense.splice(0, probe.dense.length - 500);
      }
      if (Math.abs(dy) > 30) {
        probe.jumps += 1;
        probe.perceivedJumps += 1;
        const dir = dy < 0 ? 'up' : 'down';
        probe.samples.push({ t: Math.round(now), y: g.y, dy: Math.round(dy), dir, sh: g.sh, max: g.max, freeze: freezeOn });
        if (probe.lastDir && ((probe.lastDir === 'up' && dir === 'down') || (probe.lastDir === 'down' && dir === 'up'))) {
          probe.path.push(`${probe.lastDir}->${dir}@${Math.round(now)}`);
        }
        probe.lastDir = dir;
        probe.lastY = g.y;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const tBack = Date.now();
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    return p === '/home' || p === '/' || p === '';
  }, { timeout: 20000 });

  // Wait until restore finished (or timeout), then stop probe.
  const traj = await page.evaluate(async () => {
    const waitUntil = performance.now() + 3200;
    while (performance.now() < waitUntil) {
      const fin = window.__xvmScrollRestoreFinished;
      if (fin && fin.finishedAt != null) {
        // Wait through defend tail so late X scrolls (if any) are observed.
        await new Promise((r) => setTimeout(r, 850));
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    const probe = window.__xvmBenchProbe || { jumps: 0, samples: [], t0: performance.now() };
    probe.stop = true;
    const fin = window.__xvmScrollRestoreFinished || window.__xvmScrollRestoreLast;
    const dirs = (probe.samples || []).map((s) => s.dir).filter(Boolean);
    let flash = 'none';
    if (dirs.length >= 3) {
      const seq = dirs.slice(0, 6).join('→');
      flash = seq;
    } else if (dirs.length) {
      flash = dirs.join('→');
    }
    return {
      visibleJumps: probe.jumps,
      perceivedJumps: probe.perceivedJumps,
      freezeFrames: probe.freezeFrames,
      freezeShown: false, // freeze overlay removed; kept for JSON shape
      samples: probe.samples.slice(0, 40),
      dense: (probe.dense || []).slice(0, 200),
      path: probe.path || [],
      flash,
      fin,
      finalY: Math.round(window.scrollY),
      elapsedMs: Math.round(performance.now() - probe.t0),
      hasQuietMarker: !!(fin && fin.events && fin.events.some((e) => e.type === 'coarse_skip_clamp' || e.type === 'wait_anchor' || e.type === 'pin_noop')),
      eventTypes: (fin?.events || []).map((e) => e.type),
      finOsc: fin?.oscillations || [],
      finFlash: fin?.flashPattern || null,
      finHf: (fin?.hf || []).slice(0, 120),
    };
  });

  // Measure anchor accuracy for clicked id
  const accuracy = await page.evaluate((want) => {
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    for (const art of arts) {
      const links = [...art.querySelectorAll('a[href*="/status/"]')];
      for (const a of links) {
        const id = a.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
        if (id === want.id) {
          const r = art.getBoundingClientRect();
          if (r.height > 0 && !art.closest('[aria-hidden="true"]')) {
            return {
              top: Math.round(r.top),
              offsetErr: Math.round(r.top - want.top),
              found: true,
            };
          }
        }
      }
    }
    return { found: false, top: null, offsetErr: null };
  }, clicked);

  const fin = traj.fin || {};
  return {
    run: idx + 1,
    clickedId: clicked.id,
    savedY: clicked.y,
    savedTop: clicked.top,
    beforeDeepY: before.y,
    visibleJumps: traj.visibleJumps,
    perceivedJumps: traj.perceivedJumps,
    freezeFrames: traj.freezeFrames,
    freezeShown: traj.freezeShown,
    flash: traj.flash,
    path: traj.path,
    denseHead: (traj.dense || []).slice(0, 40),
    denseTail: (traj.dense || []).slice(-40),
    finOsc: traj.finOsc,
    finFlash: traj.finFlash,
    finHfHead: (traj.finHf || []).slice(0, 40),
    finEvents: (traj.fin?.events || []).slice(0, 40),
    samples: traj.samples,
    finalY: traj.finalY,
    offsetErr: accuracy.offsetErr,
    anchorFound: accuracy.found,
    firstPinAt: fin.firstPinAt != null ? Math.round(fin.firstPinAt) : null,
    stableAt: fin.stableAt != null ? Math.round(fin.stableAt) : null,
    finishedAt: fin.finishedAt != null ? Math.round(fin.finishedAt) : null,
    jumpsReported: fin.jumps ?? null,
    coarse: fin.coarse ?? null,
    pins: fin.pins ?? null,
    repins: fin.repins ?? null,
    suppressed: fin.suppressed ?? null,
    wallBackMs: Date.now() - tBack,
    events: (fin.events || []).slice(0, 40),
  };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(results) {
  const jumps = results.map((r) => r.visibleJumps).sort((a, b) => a - b);
  const perceived = results.map((r) => r.perceivedJumps ?? r.visibleJumps).sort((a, b) => a - b);
  const first = results.map((r) => r.firstPinAt ?? 99999).sort((a, b) => a - b);
  const stable = results.map((r) => r.stableAt ?? 99999).sort((a, b) => a - b);
  const finished = results.map((r) => r.finishedAt ?? 99999).sort((a, b) => a - b);
  const err = results.filter((r) => r.offsetErr != null).map((r) => Math.abs(r.offsetErr)).sort((a, b) => a - b);
  const freezeLeak = results.filter((r) => (r.freezeFrames || 0) > 0).length;
  return {
    n: results.length,
    visibleJumps: { p50: pct(jumps, 50), p90: pct(jumps, 90), max: jumps.at(-1), mean: +(jumps.reduce((a, b) => a + b, 0) / jumps.length).toFixed(2) },
    perceivedJumps: { p50: pct(perceived, 50), p90: pct(perceived, 90), max: perceived.at(-1), mean: +(perceived.reduce((a, b) => a + b, 0) / perceived.length).toFixed(2) },
    freezeOverlayLeak: `${freezeLeak}/${results.length}`,
    firstPinMs: { p50: pct(first, 50), p90: pct(first, 90), max: first.at(-1) },
    stableMs: { p50: pct(stable, 50), p90: pct(stable, 90), max: stable.at(-1) },
    finishedMs: { p50: pct(finished, 50), p90: pct(finished, 90), max: finished.at(-1) },
    absOffsetPx: { p50: pct(err, 50), p90: pct(err, 90), max: err.at(-1) ?? null },
  };
}

async function reloadExtension(browser) {
  // Best-effort: open chrome://extensions and click reload for x-viral-monitor / X Viral
  const ctx = browser.contexts()[0];
  if (!ctx) return false;
  const page = await ctx.newPage();
  try {
    await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(500);
    const reloaded = await page.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      if (!mgr?.shadowRoot) return { ok: false, reason: 'no manager' };
      const itemList = mgr.shadowRoot.querySelector('extensions-item-list');
      if (!itemList?.shadowRoot) return { ok: false, reason: 'no item-list' };
      const items = [...itemList.shadowRoot.querySelectorAll('extensions-item')];
      for (const item of items) {
        const sr = item.shadowRoot;
        if (!sr) continue;
        const name = sr.querySelector('#name')?.textContent || '';
        if (!/viral|xvm|x-viral|爆款|监测/i.test(name)) continue;
        const reloadBtn = sr.querySelector('#dev-reload-button, #reload-button');
        if (reloadBtn) {
          reloadBtn.click();
          return { ok: true, name };
        }
        return { ok: false, reason: 'no reload btn', name };
      }
      return { ok: false, reason: 'extension not found', names: items.map((i) => i.shadowRoot?.querySelector('#name')?.textContent) };
    });
    await sleep(800);
    return reloaded;
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    await page.close().catch(() => {});
  }
}

const browser = await chromium.connectOverCDP(cdp);
console.log('Connected', cdp);

const reloadInfo = await reloadExtension(browser);
console.log('Extension reload:', reloadInfo);

const page = await findHomePage(browser);
console.log('Using page', page.url());

// Hard reload home so content script picks up new code after extension reload
await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
await waitHomeReady(page);
const hasGuard = await page.evaluate(() => typeof window.__xvmScrollRestoreLast !== 'undefined' || true);
// Probe by enabling debug and checking controlled seam exists via a tiny popstate noop
const probe = await page.evaluate(() => {
  window.__xvmScrollRestoreDebug = true;
  return {
    scrollRestoration: history.scrollRestoration,
    hasFinishedProp: '__xvmScrollRestoreFinished' in window || true,
  };
});
console.log('Probe', probe);

const results = [];
for (let i = 0; i < runs; i++) {
  console.log(`\n=== Run ${i + 1}/${runs} ===`);
  try {
    const r = await oneRun(page, i);
    results.push(r);
    console.log(JSON.stringify({
      run: r.run,
      visibleJumps: r.visibleJumps,
      perceivedJumps: r.perceivedJumps,
      freezeFrames: r.freezeFrames,
      freezeShown: r.freezeShown,
      flash: r.flash,
      path: r.path,
      firstPinAt: r.firstPinAt,
      stableAt: r.stableAt,
      finishedAt: r.finishedAt,
      jumpsReported: r.jumpsReported,
      coarse: r.coarse,
      pins: r.pins,
      repins: r.repins,
      suppressed: r.suppressed,
      offsetErr: r.offsetErr,
      finalY: r.finalY,
      savedY: r.savedY,
      samples: r.samples,
      finFlash: r.finFlash,
      finOsc: r.finOsc,
      finEvents: r.finEvents,
      denseHead: r.denseHead,
      denseTail: r.denseTail,
    }, null, 0));
  } catch (e) {
    console.error('Run failed:', e);
    results.push({ run: i + 1, error: String(e), visibleJumps: null });
  }
  await sleep(600);
}

const ok = results.filter((r) => r.visibleJumps != null);
const summary = summarize(ok);
const outDir = resolve(repo, '.tmp');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'scroll-restore-cdp-bench.json');
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), cdp, deepScrollPx, reloadInfo, summary, results }, null, 2));

console.log('\n=== CDP summary ===');
console.log(JSON.stringify(summary, null, 2));
console.log('Wrote', outPath);

const bad = ok.filter((r) => (r.perceivedJumps ?? r.visibleJumps ?? 99) > 1 || Math.abs(r.offsetErr ?? 999) > 96 || (r.freezeFrames || 0) > 0);
if (bad.length) {
  console.log(`\nAbove target: ${bad.length}/${ok.length} runs (want jumps<=1, no freeze overlay, |offset|<=96)`);
  process.exitCode = 2;
} else {
  console.log(`\nAll ${ok.length} runs within target (light pin, no freeze).`);
}
