import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const source = readFileSync(resolve(repo, 'lib/timeline-ad-prune.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(repo, 'manifest.json'), 'utf8'));
const content = readFileSync(resolve(repo, 'content.js'), 'utf8');

function loadApi() {
  const ctx = { window: {}, globalThis: {} };
  vm.runInNewContext(source, ctx);
  return ctx.window.__xvmTimelineAdPrune;
}

function tweetEntry(id, { promoted = false } = {}) {
  const entry = {
    entryId: promoted ? `promoted-tweet-${id}` : `tweet-${id}`,
    sortIndex: String(1000000 - Number(id || 0) * 1000),
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: {
          result: {
            rest_id: String(id),
            legacy: { full_text: `tweet ${id}` },
          },
        },
      },
    },
  };
  if (promoted) {
    entry.content.itemContent.promotedMetadata = {
      impression_id: `imp-${id}`,
      disclosure_type: 'promoted',
    };
  }
  return entry;
}

function moduleEntry(id, moduleItems) {
  return {
    entryId: `home-conversation-${id}`,
    sortIndex: String(id),
    content: {
      entryType: 'TimelineTimelineModule',
      items: moduleItems,
    },
  };
}

function moduleItem(id, { promoted = false } = {}) {
  const item = {
    entryId: promoted ? `promoted-tweet-${id}` : `conversation-${id}`,
    item: {
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: {
          result: { rest_id: String(id), legacy: { full_text: `m ${id}` } },
        },
      },
    },
  };
  if (promoted) {
    item.item.itemContent.promotedMetadata = { impression_id: `imp-${id}` };
  }
  return item;
}

function homeTimeline(entries) {
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            { type: 'TimelineAddEntries', entries },
          ],
        },
      },
    },
  };
}

describe('timeline ad prune', () => {
  it('loads before content.js in the MAIN-world content script', () => {
    const main = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
    const order = main.js;
    expect(order.indexOf('lib/timeline-ad-prune.js')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lib/timeline-ad-prune.js')).toBeLessThan(order.indexOf('content.js'));
    expect(order.indexOf('lib/x-net-hook.js')).toBeLessThan(order.indexOf('lib/timeline-ad-prune.js'));
  });

  it('wires prune ahead of bookmark inject with timeline-only patch matchers', () => {
    expect(content).toContain('__xvmTimelineAdPrune');
    expect(content).toContain('patchTimelineResponse');
    expect(content).toContain('TIMELINE_AD_PRUNE_RE');
    // Must NOT patch every GraphQL op — BookmarkFoldersSlice shares MAIN fetch.
    expect(content).not.toMatch(/onResponsePatch\(GRAPHQL_RE/);
    const pruneIdx = content.indexOf('onResponsePatch(TIMELINE_AD_PRUNE_RE');
    const injectIdx = content.indexOf('maybeInjectBookmarkTimeline');
    expect(pruneIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(pruneIdx);
  });

  it('does not treat BookmarkFoldersSlice as a timeline prune target', () => {
    const api = loadApi();
    const folderUrl = 'https://x.com/i/api/graphql/i78YDd0Tza-dV4SYs58kRg/BookmarkFoldersSlice?variables=%7B%7D';
    expect(api.matchesTimelineUrl(folderUrl)).toBe(false);
    const json = {
      data: {
        viewer: {
          user_results: {
            result: {
              bookmark_collections_slice: {
                items: [{ id: '1', name: 'Work', entryId: 'promoted-nope' }],
              },
            },
          },
        },
      },
    };
    expect(api.patchTimelineResponse({ url: folderUrl, json })).toBeUndefined();
    expect(json.data.viewer.user_results.result.bookmark_collections_slice.items).toHaveLength(1);
  });

  it('detects promoted entries by entryId and promotedMetadata', () => {
    const api = loadApi();
    expect(api.isPromotedEntry(tweetEntry('1'))).toBe(false);
    expect(api.isPromotedEntry(tweetEntry('2', { promoted: true }))).toBe(true);
    expect(api.isPromotedEntry({
      entryId: 'tweet-3',
      content: { itemContent: { promoted_metadata: { impression_id: 'x' } } },
    })).toBe(true);
  });

  it('removes promoted timeline entries and keeps organic ones', () => {
    const api = loadApi();
    const json = homeTimeline([
      tweetEntry('10'),
      tweetEntry('11', { promoted: true }),
      tweetEntry('12'),
      tweetEntry('13', { promoted: true }),
    ]);
    const out = api.pruneTimelineAds(json);
    expect(out).toBe(json);
    const entries = json.data.home.home_timeline_urt.instructions[0].entries;
    expect(entries.map((e) => e.entryId)).toEqual(['tweet-10', 'tweet-12']);
  });

  it('returns undefined when nothing is promoted', () => {
    const api = loadApi();
    const json = homeTimeline([tweetEntry('20'), tweetEntry('21')]);
    expect(api.pruneTimelineAds(json)).toBeUndefined();
    expect(json.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);
  });

  it('prunes promoted items inside modules and drops empty modules', () => {
    const api = loadApi();
    const json = homeTimeline([
      tweetEntry('30'),
      moduleEntry('40', [
        moduleItem('41'),
        moduleItem('42', { promoted: true }),
      ]),
      moduleEntry('50', [
        moduleItem('51', { promoted: true }),
      ]),
    ]);
    expect(api.pruneTimelineAds(json)).toBe(json);
    const entries = json.data.home.home_timeline_urt.instructions[0].entries;
    expect(entries.map((e) => e.entryId)).toEqual(['tweet-30', 'home-conversation-40']);
    expect(entries[1].content.items.map((m) => m.entryId)).toEqual(['conversation-41']);
  });

  it('prunes TimelineAddToModule moduleItems', () => {
    const api = loadApi();
    const json = {
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                type: 'TimelineAddToModule',
                moduleItems: [
                  moduleItem('61'),
                  moduleItem('62', { promoted: true }),
                ],
              },
            ],
          },
        },
      },
    };
    expect(api.pruneTimelineAds(json)).toBe(json);
    expect(json.data.home.home_timeline_urt.instructions[0].moduleItems.map((m) => m.entryId))
      .toEqual(['conversation-61']);
  });

  it('matches HomeTimeline and SearchTimeline URLs but not unrelated GraphQL', () => {
    const api = loadApi();
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/HomeTimeline?variables=1')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/HomeLatestTimeline')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/SearchTimeline')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/UserTweets')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/TweetDetail')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/Viewer')).toBe(false);
    expect(api.matchesTimelineUrl('https://x.com/i/api/1.1/statuses/update.json')).toBe(false);
  });

  it('patchTimelineResponse only rewrites matched timeline ops', () => {
    const api = loadApi();
    const json = homeTimeline([tweetEntry('70'), tweetEntry('71', { promoted: true })]);
    expect(api.patchTimelineResponse({
      url: 'https://x.com/i/api/graphql/abc/Viewer',
      json,
    })).toBeUndefined();
    expect(json.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);

    const patched = api.patchTimelineResponse({
      url: 'https://x.com/i/api/graphql/abc/HomeTimeline?variables={}',
      json,
    });
    expect(patched).toBe(json);
    expect(json.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId))
      .toEqual(['tweet-70']);
  });

  it('aligns detection with content.js promotedTweetIdFrom signals', () => {
    expect(content).toContain(" /^promoted-/i.test(String(obj.entryId || ''))");
    expect(content).toContain('itemContent.promotedMetadata');
    expect(content).toContain('itemContent.promoted_metadata');
    expect(source).toContain('/^promoted-/i');
    expect(source).toContain('promotedMetadata');
    expect(source).toContain('promoted_metadata');
  });

  it('__xvmDisableAdPrune skips rewriting without mutating', () => {
    const ctx = { window: { __xvmDisableAdPrune: true }, globalThis: {} };
    vm.runInNewContext(source, ctx);
    const api = ctx.window.__xvmTimelineAdPrune;
    const json = homeTimeline([tweetEntry('1'), tweetEntry('9', { promoted: true })]);
    expect(api.patchTimelineResponse({
      url: 'https://x.com/i/api/graphql/abc/HomeTimeline',
      json,
    })).toBeUndefined();
    expect(json.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);
  });

});
