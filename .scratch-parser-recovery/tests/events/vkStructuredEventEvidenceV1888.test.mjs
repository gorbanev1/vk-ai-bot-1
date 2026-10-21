import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    extractVkStructuredBootstrapSourcesFromHtml,
    extractVkStructuredEventsFromBootstrap,
    formatVkStructuredEventEvidence,
} from '../../src/features/events/vkStructuredEventEvidence.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const browserSource = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);
const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V188.8 reads VK apiPrefetchCache from raw HTML before SPA can consume it', () => {
    const html = String.raw`<!doctype html><html><body><script>
        window.cur.apiPrefetchCache = [
          {"method":"groups.getById","response":{"groups":[{
            "id":239795426,
            "type":"event",
            "name":"Соня / Марина, я умираю / 19.09 / Воронеж",
            "start_date":1789833600
          }]}}
        ];
        window.apiPrefetchReadyResolve();
    </script></body></html>`;

    const sources = extractVkStructuredBootstrapSourcesFromHtml(html);
    assert.equal(sources.length, 1);

    const [event] = extractVkStructuredEventsFromBootstrap(sources);
    assert.ok(event);
    assert.equal(event.id, 239795426);
    assert.equal(event.startAt, 1789833600);
    assert.equal(event.title, 'Соня / Марина, я умираю / 19.09 / Воронеж');

    const evidence = formatVkStructuredEventEvidence(event, {
        timeZone: 'Europe/Moscow',
    });
    assert.equal(evidence.eventDate, '2026-09-19');
    assert.equal(evidence.eventTime, '19:00');
});

test('V188.8 raw bootstrap reader is not tied to one exact groups.getById object shape', () => {
    const html = String.raw`<script type="application/json">
      {"payload":{"thing":{"eventId":77,"isEvent":true,"eventName":"Тест","startDate":1789833600000}}}
    </script>`;
    const [event] = extractVkStructuredEventsFromBootstrap(
        extractVkStructuredBootstrapSourcesFromHtml(html),
    );
    assert.ok(event);
    assert.equal(event.id, 77);
    assert.equal(event.startAt, 1789833600);
});

test('V188.8 deterministic fallback extracts venue from common venue + date/time line', () => {
    const text = [
        'Название: Соня / Марина, я умираю / 19.09 / Воронеж',
        'Дата: 19.09.2026',
        'Время: 19:00',
        '',
        'Дополнительные данные со страницы VK:',
        'КОТЕЛЬНАЯ, 19 сентября в 19:00.',
    ].join('\n');

    const [event] = parsePublicPostLocally({
        text,
        sourceUrl: 'https://vk.ru/club239795426',
        screenName: 'club239795426',
        publishedAt: 0,
    });
    assert.ok(event);
    assert.equal(event.eventDate, '2026-09-19');
    assert.equal(event.eventTime, '19:00');
    assert.equal(event.venue, 'КОТЕЛЬНАЯ');
});

test('V188.8 VK event capture snapshots structured data before scrolling and closes finite tabs', () => {
    const captureIndex = browserSource.indexOf('captureVkStructuredEventEvidence(page)');
    const scrollIndex = browserSource.indexOf('for (let step = 0; step < automaticScanSteps; step += 1)');
    assert.ok(captureIndex >= 0 && scrollIndex > captureIndex);
    assert.match(browserSource, /keepPageOpen = false/u);
    assert.match(browserSource, /extractVkStructuredBootstrapSourcesFromHtml/u);
    assert.match(browserSource, /extractionMethod: 'vk-whole-page-fallback'/u);
    assert.match(browserSource, /finally \{[\s\S]{0,600}!keepPageOpen[\s\S]{0,300}page\.close/u);
});

test('V188.8 public/manual source parsing is finite by default; only explicit live mode stays open', () => {
    assert.match(
        appSource,
        /SCRAPER_KEEP_MANUAL_SOURCE_TABS_OPEN',[\s\S]{0,80}false/u,
    );
    assert.match(appSource, /keepPageOpen: false/u);
    assert.match(appSource, /vk-structured-event-first-pass\+generic-page-fallback/u);
    assert.match(appSource, /const hasStructuredVkEvent = pagePosts\.some/u);
});
