import assert from 'node:assert/strict';
import test from 'node:test';

import {
    QTICKETS_SOURCE_TYPE,
    mergeQticketsCardAndDetail,
    parseQticketsDetailHtml,
    parseQticketsListingHtml,
} from '../../src/features/events/qticketsParser.js';

const referenceDate = new Date('2026-09-15T12:00:00+03:00');

const listingHtml = `
<ul class="events_list">
  <li class="item">
    <section>
      <a href="https://voronezh.qtickets.events/225260-boulevard-depo-6-noyabrya-2026" onclick="loadEvent(225260); return false">
        <div class="img" style="background-image: url('https://cdn.qtickets.tech/thumbs/depo_360.webp')"></div>
        <div class="status"><div class="price">от 1900 руб.</div></div>
        <h2>Boulevard Depo</h2>
        <div class="type">Концерты</div>
        <time class="place" datetime="2026-11-06T20:00:00+03:00">
          <span class="event-date">6 ноября</span>
          <span class="place-name">Palazzo</span>
        </time>
      </a>
    </section>
  </li>
  <li class="item">
    <a href="/246099-epidemiya-30-let-simfonicheskiy-kontsert-s-orkestrom" onclick="loadEvent(246099)">
      <h2>Эпидемия — 30 лет</h2>
      <div class="type">Шоу</div>
      <time class="place" datetime="2026-11-14T19:00:00+03:00"><span class="event-date">14 ноября</span><span class="place-name">Град</span></time>
    </a>
  </li>
</ul>`;

test('parses QTickets listing cards and keeps detail links', () => {
    const cards = parseQticketsListingHtml(listingHtml, {
        referenceDate,
        baseUrl: 'https://voronezh.qtickets.events/',
    });

    assert.equal(cards.length, 2);
    assert.equal(cards[0].externalId, '225260');
    assert.equal(cards[0].detailUrl, 'https://voronezh.qtickets.events/225260-boulevard-depo-6-noyabrya-2026');
    assert.equal(cards[0].eventDate, '2026-11-06');
    assert.equal(cards[0].eventTime, '20:00');
    assert.equal(cards[0].venue, 'Palazzo');
    assert.equal(cards[0].price, 'от 1900 руб.');
    assert.equal(cards[0].imageUrls[0], 'https://cdn.qtickets.tech/thumbs/depo_360.webp');
    assert.equal(cards[1].externalId, '246099');
});

test('parses detail JSON-LD, visible venue, ticket link and poster', () => {
    const detailHtml = `
<!doctype html><html><head>
  <meta property="og:image" content="https://cdn.qtickets.tech/events/depo.webp">
  <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: 'Boulevard Depo',
        startDate: '2026-11-06T20:00:00+03:00',
        endDate: '2026-11-06T23:00:00+03:00',
        image: ['https://cdn.qtickets.tech/events/depo.webp'],
        description: 'Большой концерт в Воронеже.',
        location: {
            '@type': 'Place',
            name: 'Palazzo',
            address: { addressLocality: 'Воронеж', streetAddress: 'Московский просп., 9' },
        },
        offers: { price: '1900', priceCurrency: 'RUB', url: 'https://qtickets.ru/checkout/225260' },
    })}</script>
</head><body>
  <h1>Boulevard Depo</h1>
  <div>пятница 6 ноября, 20:00 Palazzo 16+</div>
  <a href="https://qtickets.ru/checkout/225260">Купить от 1900 руб.</a>
  <p>Большой концерт в Воронеже.</p>
</body></html>`;

    const detail = parseQticketsDetailHtml(
        detailHtml,
        'https://voronezh.qtickets.events/225260-boulevard-depo-6-noyabrya-2026',
        { referenceDate },
    );

    assert.equal(detail.title, 'Boulevard Depo');
    assert.equal(detail.eventDate, '2026-11-06');
    assert.equal(detail.eventTime, '20:00');
    assert.equal(detail.venue, 'Palazzo, Воронеж, Московский просп., 9');
    assert.equal(detail.price, 'от 1900 руб.');
    assert.equal(detail.ticketUrl, 'https://qtickets.ru/checkout/225260');
    assert.equal(detail.imageUrls[0], 'https://cdn.qtickets.tech/events/depo.webp');
    assert.equal(detail.ageRestriction, '16+');
});

test('merges detail data into a separately classified QTickets event', () => {
    const event = mergeQticketsCardAndDetail(
        { externalId: '225260', detailUrl: 'https://voronezh.qtickets.events/225260', title: 'Card title' },
        {
            detailUrl: 'https://voronezh.qtickets.events/225260',
            title: 'Boulevard Depo',
            eventDate: '2026-11-06',
            venue: 'Palazzo',
            imagePaths: ['qtickets_event_announcements/225260-1.webp'],
        },
    );

    assert.equal(event.sourceType, QTICKETS_SOURCE_TYPE);
    assert.equal(event.provenanceSourceType, QTICKETS_SOURCE_TYPE);
    assert.equal(event.title, 'Boulevard Depo');
    assert.equal(event.posterMatchStatus, 'legacy_manual_poster');
    assert.equal(event.sourceUrl, 'https://voronezh.qtickets.events/225260');
});

