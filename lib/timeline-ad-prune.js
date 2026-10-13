// Timeline ad prune: drop promoted entries from GraphQL timeline JSON before
// React mounts cells. Exposed on window for content.js + unit tests.
//
// X marks ads on the timeline ENTRY (entryId /^promoted-/ or itemContent
// promotedMetadata), never on the tweet result itself — same signals as
// content.js promotedTweetIdFrom.
(() => {
  const TIMELINE_OPS = /\/(?:i\/api\/)?graphql\/[^/]+\/(?:HomeTimeline|HomeLatestTimeline|ListLatestTweetsTimeline|UserTweets|UserTweetsAndReplies|UserMedia|SearchTimeline|TweetDetail|CommunityTweetsTimeline|CommunitiesMainTimeline|ExplorePage)\b/;

  function isObject(v) {
    return !!v && typeof v === 'object';
  }

  function itemContentOf(node) {
    if (!isObject(node)) return null;
    return node.content?.itemContent
      || node.item?.itemContent
      || node.itemContent
      || null;
  }

  function isPromotedItemContent(itemContent) {
    if (!isObject(itemContent)) return false;
    return !!itemContent.promotedMetadata || !!itemContent.promoted_metadata;
  }

  function isPromotedEntry(entry) {
    if (!isObject(entry)) return false;
    if (/^promoted-/i.test(String(entry.entryId || ''))) return true;
    return isPromotedItemContent(itemContentOf(entry));
  }

  function isPromotedModuleItem(mod) {
    if (!isObject(mod)) return false;
    if (/^promoted-/i.test(String(mod.entryId || ''))) return true;
    return isPromotedItemContent(itemContentOf(mod));
  }

  // Returns true when the array was mutated.
  function pruneModuleItems(items) {
    if (!Array.isArray(items) || !items.length) return false;
    let changed = false;
    for (let i = items.length - 1; i >= 0; i--) {
      if (!isPromotedModuleItem(items[i])) continue;
      items.splice(i, 1);
      changed = true;
    }
    return changed;
  }

  // Returns true when the array was mutated.
  function pruneEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return false;
    let changed = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (isPromotedEntry(entry)) {
        entries.splice(i, 1);
        changed = true;
        continue;
      }
      // Conversation / carousel modules may mix organic + promoted items.
      const items = entry?.content?.items;
      if (Array.isArray(items) && items.length) {
        if (pruneModuleItems(items)) {
          changed = true;
          if (!items.length) entries.splice(i, 1);
        }
      }
    }
    return changed;
  }

  // Walk instructions / nested URT trees. Mutates json in place.
  // Returns the same json when anything was removed, else undefined
  // (matches onResponsePatch "no change" convention).
  function pruneTimelineAds(json) {
    if (!isObject(json)) return undefined;
    let changed = false;
    const seen = new Set();

    function walk(obj) {
      if (!isObject(obj) || seen.has(obj)) return;
      seen.add(obj);
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item);
        return;
      }
      if (Array.isArray(obj.entries) && pruneEntries(obj.entries)) changed = true;
      if (Array.isArray(obj.moduleItems) && pruneModuleItems(obj.moduleItems)) changed = true;
      for (const value of Object.values(obj)) walk(value);
    }

    walk(json);
    return changed ? json : undefined;
  }

  function matchesTimelineUrl(url) {
    return TIMELINE_OPS.test(String(url || ''));
  }

  // Patch subscriber helper: prune only known timeline ops.
  // Diagnostic: set window.__xvmDisableAdPrune = true then hard-refresh
  // to A/B whether API ad-prune correlates with back-nav scroll jumps.
  function patchTimelineResponse({ url, json }) {
    const g = typeof window !== 'undefined' ? window : globalThis;
    if (g.__xvmDisableAdPrune) return undefined;
    if (!matchesTimelineUrl(url)) return undefined;
    return pruneTimelineAds(json);
  }

  const api = {
    TIMELINE_OPS,
    isPromotedEntry,
    isPromotedModuleItem,
    pruneEntries,
    pruneModuleItems,
    pruneTimelineAds,
    matchesTimelineUrl,
    patchTimelineResponse,
  };

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.__xvmTimelineAdPrune = api;
})();
