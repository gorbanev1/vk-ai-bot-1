import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

test('V188.30 bulk event reparse opens at least ten links concurrently per batch', () => {
  assert.match(app, /const EVENT_REPARSE_BROWSER_BATCH_SIZE = Math\.max\(\s*10,/u);
  const start = app.indexOf('async function reparseAllStoredEventLinks()');
  const end = app.indexOf('function rankEventDeletionCandidates', start);
  const block = app.slice(start, end);
  assert.match(block, /groupedEntries\.slice\(batchStart, batchStart \+ EVENT_REPARSE_BROWSER_BATCH_SIZE\)/u);
  assert.match(block, /Promise\.allSettled\(batch\.map\(async \(\[sourceUrl, records\]\) => \{/u);
  assert.match(block, /\[EVENT SOURCE REPARSE BATCH OPEN\]/u);
  assert.match(block, /acquireScraperBrowserActivityLease/u);
});

test('V188.30 browser opening is not serialized behind VK API hydration', () => {
  const start = app.indexOf('async function reparseStoredEventSourceUrl');
  const end = app.indexOf('const EVENT_REPARSE_BROWSER_BATCH_SIZE', start);
  const block = app.slice(start, end);
  assert.match(block, /const \[exactVkPost, browserReview\] = await Promise\.all\(\[/u);
  assert.match(block, /hydrateExactVkWallPostForEvent\(canonicalUrl\),[\s\S]*openEventLinkForReview\(\{/u);
});

test('V188.30 keeps the hard one-minute dwell for every concurrently opened tab', () => {
  assert.match(browser, /const EVENT_REVIEW_MINIMUM_OPEN_MS = 60_000/u);
  assert.match(browser, /\[EVENT LINK MINIMUM DWELL\]/u);
});
