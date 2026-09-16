#!/usr/bin/env node
// Package the current channel build into ./release for manual upload.
//
// Usage: node scripts/package-zip.mjs --channel store|community-dev [--target chrome|edge]
//
// Chrome and Edge get byte-identical archives — this extension carries no
// store-specific manifest keys, and Edge is Chromium. The target only names the
// file, so the two uploads cannot be confused on disk.
//
// What Edge does NOT share is the extension ID: the Edge listing gets its own,
// and the license Worker allows activation by extension origin. Until that new
// ID is in ALLOWED_ORIGIN, every activation from the Edge build fails CORS.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const releaseDir = resolve(root, 'release');
const CHANNELS = new Set(['store', 'community-dev']);
const TARGETS = new Set(['chrome', 'edge']);
// Keys a store rejects or that pin the extension to one listing.
const FORBIDDEN_MANIFEST_KEYS = ['key', 'update_url'];

function readChannel(argv) {
  const idx = argv.indexOf('--channel');
  const raw = idx >= 0 ? argv[idx + 1] : 'store';
  if (!CHANNELS.has(raw)) {
    throw new Error(`[package-zip] invalid --channel ${raw || '(missing)'}; expected store or community-dev`);
  }
  return raw;
}

function readTarget(argv) {
  const idx = argv.indexOf('--target');
  const raw = idx >= 0 ? argv[idx + 1] : 'chrome';
  if (!TARGETS.has(raw)) {
    throw new Error(`[package-zip] invalid --target ${raw || '(missing)'}; expected chrome or edge`);
  }
  return raw;
}

function zipName(channel, target) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const suffix = channel === 'community-dev'
    ? 'community-dev'
    : (target === 'edge' ? 'edge-addons' : 'chrome-web-store');
  return `x-viral-monitor-v${pkg.version}-${suffix}.zip`;
}

function checkManifest() {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  const found = FORBIDDEN_MANIFEST_KEYS.filter((k) => k in manifest);
  if (found.length) {
    throw new Error(`[package-zip] dist/manifest.json still has ${found.join(', ')} — a store build must not ship these`);
  }
  for (const [size, path] of Object.entries(manifest.icons || {})) {
    if (!existsSync(resolve(dist, path))) {
      throw new Error(`[package-zip] manifest icon ${size} points at missing ${path}`);
    }
  }
  return manifest;
}


// Edge certification rejects an extension whose name or description says
// "Chrome" — https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/port-chrome-extension
function checkEdgeBranding(manifest) {
  const hits = [];
  const look = (where, text) => {
    if (typeof text === 'string' && /chrome/i.test(text)) hits.push(`${where}: ${text.slice(0, 80)}`);
  };
  look('manifest.name', manifest.name);
  look('manifest.description', manifest.description);
  const localesDir = resolve(dist, '_locales');
  if (existsSync(localesDir)) {
    for (const locale of readdirSync(localesDir)) {
      const file = resolve(localesDir, locale, 'messages.json');
      if (!existsSync(file)) continue;
      const msgs = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, val] of Object.entries(msgs)) {
        if (/^ext(Name|Desc|Description)$/i.test(key)) look(`_locales/${locale} ${key}`, val && val.message);
      }
    }
  }
  if (hits.length) {
    throw new Error(`[package-zip] Edge 认证不接受名称/描述里出现 "Chrome"，改掉这些再打包：\n  ${hits.join('\n  ')}`);
  }
}

function main() {
  const channel = readChannel(process.argv.slice(2));
  const target = readTarget(process.argv.slice(2));
  if (!existsSync(dist)) throw new Error('[package-zip] dist/ missing; run build first');
  const manifest = checkManifest();
  if (target === 'edge') checkEdgeBranding(manifest);
  mkdirSync(releaseDir, { recursive: true });
  const out = resolve(releaseDir, zipName(channel, target));
  if (existsSync(out)) rmSync(out, { force: true });

  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop";',
      `$items = Get-ChildItem -LiteralPath '${dist.replaceAll("'", "''")}';`,
      `Compress-Archive -Path $items.FullName -DestinationPath '${out.replaceAll("'", "''")}' -CompressionLevel Optimal`,
    ].join(' ');
    execFileSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
  } else {
    // Finder litter and editor backups are upload warnings at best and a
    // rejected review at worst.
    execFileSync('zip', ['-r', out, '.', '-x', '.DS_Store', '*/.DS_Store', '*.map', '__MACOSX/*'], {
      cwd: dist,
      stdio: 'inherit',
    });
  }
  console.log(`\n[package-zip] wrote ${out}`);
  if (target === 'edge') {
    console.log(
      '[package-zip] 上架 Edge 后，把它分配的扩展 ID 加进 License Worker：\n'
      + '  在 license-worker 仓库 worker/wrangler.toml 的 ALLOWED_ORIGIN 追加 chrome-extension://<EDGE_ID>，然后 npx wrangler deploy\n'
      + '  否则 Edge 版用户激活会被 CORS 挡掉。',
    );
  }
}

main();
