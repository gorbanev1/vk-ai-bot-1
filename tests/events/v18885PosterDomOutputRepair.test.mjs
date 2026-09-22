import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseIndexedImageFacts } from '../../src/features/events/eventPosterMatching.js';
import { mergeVkCapturedImageMedia } from '../../src/features/events/vkCapturedMediaMerge.js';
import { parseQticketsListingHtml, parseQticketsDetailHtml } from '../../src/features/events/qticketsParser.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

test('V188.85 empty venue never consumes Participants line', () => {
  const [fact] = parseIndexedImageFacts(`
[IMAGE 1]
Тип изображения: poster
Это афиша события: да
Уверенность афиши: 99
Читаемость текста: 95
Название: CWT
Дата: 19 сентября
Время: 20:00
Место:
Участники: CWT, STONEHAND
Цена: 500
Причина: текст афиши читается
`);
  assert.equal(fact.venue, '');
  assert.equal(fact.participants, 'CWT, STONEHAND');
});

test('V188.85 strict exact-DOM merge upgrades only same photo currentSrc', () => {
  const merged = mergeVkCapturedImageMedia([
    { url: 'https://vk.test/thumb.jpg', attachmentKey: 'photo-1_100', origin: 'exact' },
  ], [
    { url: 'https://vk.test/full.jpg', attachmentKey: 'photo-1_100', origin: 'rendered' },
    { url: 'https://vk.test/unrelated.jpg', attachmentKey: 'photo-1_999', origin: 'rendered' },
  ], { strictIdentity: true });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, 'https://vk.test/full.jpg');
  assert.equal(merged[0].snapshotUrl, 'https://vk.test/thumb.jpg');
  assert.equal(merged[0].attachmentKey, 'photo-1_100');
});

test('V188.85 QTickets detail keeps exactly one authoritative JSON-LD poster', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="https://cdn.test/og.jpg">
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Event","name":"Test Event",
      "startDate":"2026-09-20T19:00:00+03:00","image":"https://cdn.test/poster.jpg"
    }</script>
  </head><body><h1>Test Event</h1>
    <img src="https://cdn.test/gallery.webp"><img src="https://cdn.test/ad-banner.webp">
  </body></html>`;
  const event = parseQticketsDetailHtml(html, 'https://voronezh.qtickets.events/253299-test');
  assert.deepEqual(event.imageUrls, ['https://cdn.test/poster.jpg']);
});

test('V188.85 QTickets listing recovers numeric detail link outside legacy li.item', () => {
  const html = `<html><body><div class="new-layout"><a href="/253299-test">20 сентября 19:00 Test Event</a></div></body></html>`;
  const events = parseQticketsListingHtml(html, { referenceDate: new Date('2026-09-16T10:00:00Z') });
  assert.equal(events.length, 1);
  assert.equal(events[0].externalId, '253299');
  assert.equal(events[0].parseMethod, 'qtickets-listing-link-recovery-v18885');
});

test('V188.85 forensic DOM snapshot records runtime media, iframe and open shadow state', () => {
  const diagnostics = read('src/features/scrapers/manualParserDiagnostics.js');
  for (const token of ['.dom-state.json', 'htmlSha256', 'currentSrc', 'srcset', 'naturalWidth', 'iframes', 'shadowRoots', 'ownership']) {
    assert.match(diagnostics, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(diagnostics, /artifacts\.domStates\.push/);
});

test('V188.85 output and startup repair preserve cards while preferring real posters', () => {
  const app = read('src/app/botApplication.js');
  const db = read('src/infrastructure/database/index.js');
  assert.match(app, /EVENT POSTER GENERATED FALLBACK/);
  assert.match(app, /prepareEventImages\(\{[\s\S]{0,700}targetFolder:\s*'event_generated_fallbacks'/);
  assert.match(app, /v18885-restored-stored-poster-index/);
  assert.match(app, /repairQticketsSinglePosterV18885\(\)/);
  assert.match(db, /events-v18885-four-contour-media-repair-v2/);
  assert.match(db, /paths\.slice\(0, 1\)/);
});

test('V188.85 media writes are immutable and never overwrite an existing referenced file', () => {
  const assets = read('src/features/events/eventAssets.js');
  assert.match(assets, /createHash\('sha256'\)/);
  assert.match(assets, /flag:\s*'wx'/);
  assert.doesNotMatch(assets, /writeFileSync\([^\n]+buffer\s*\);/);
});
