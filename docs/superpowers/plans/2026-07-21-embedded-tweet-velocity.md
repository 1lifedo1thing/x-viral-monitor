# Embedded Tweet Velocity — Implementation Plan

**Goal:** On X long-form article pages, score embedded tweets independently, show their existing velocity badges, and let leaderboard clicks jump to the correct nested tweet card.

**Constraints:** Reuse the current badge, leaderboard, connector, and highlight UI. Do not add styles or derive metrics from localized DOM labels. Keep the outer article tweet independent from each embedded tweet.

## Task 1: Lock nested GraphQL extraction with a regression test

**Files:**
- Modify: `tests/tweet-data-extraction.test.js`
- Modify: `content.js`

1. Add a fixture whose outer `tweet_results.result` contains another `tweet_results.result` in its article data.
2. Assert that `scanForTweets` stores both tweet IDs with their own view counts and timestamps.
3. Run the targeted test and confirm it fails because recursion currently skips the handled `tweet_results` subtree.
4. Make `scanForTweets` recurse into the handled result after extracting the outer tweet, without changing `extractTweetData` semantics.
5. Re-run the targeted test and confirm it passes.

## Task 2: Lock nested-card leaderboard targeting with a regression test

**Files:**
- Modify: `tests/tweet-data-extraction.test.js`
- Modify: `content.js`

1. Model an outer article containing its own status link plus a nested article status link.
2. Assert that `findArticleByTweetId` returns the nested article for the nested tweet ID.
3. Run the targeted test and confirm the current ancestor-wide link query fails by returning the outer article.
4. Scope `getTweetIdFromArticle` to status links whose nearest tweet article is the article being inspected.
5. Re-run the targeted test and confirm the nested article is selected.

## Task 3: Verify the complete extension behavior

**Files:**
- Generated build output only if the repository build updates it.

1. Run the targeted regression test, then the full test suite.
2. Build the extension and confirm the generated bundle contains the changes.
3. Load the current build on the supplied X article and verify all embedded tweet cards receive independent badges.
4. Verify each embedded tweet appears independently in the floating leaderboard and clicking it scrolls to/highlights the matching nested card.
5. Capture fresh visual evidence and run the required independent visual QA reviews.
