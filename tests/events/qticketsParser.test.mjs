import assert from 'node:assert/strict';
import test from 'node:test';

import {
    QTICKETS_SOURCE_TYPE,
    mergeQticketsCardAndDetail,
    parseQticketsDetailHtml,
    parseQticketsListingHtml,
    qticketsListingCardHash,
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

test('QTickets listing hash ignores unstable whole-card DOM text but tracks event fields', () => {
    const card = {
        externalId: '225260', title: 'Boulevard Depo', eventDate: '2026-11-06',
        eventTime: '20:00', venue: 'Palazzo', sourceText: 'first observed DOM',
        imageUrls: ['https://cdn.qtickets.tech/depo.webp'],
    };
    assert.equal(qticketsListingCardHash(card), qticketsListingCardHash({
        ...card, sourceText: 'same event; updated countdown and UI controls',
    }));
    assert.notEqual(qticketsListingCardHash(card), qticketsListingCardHash({ ...card, eventDate: '2026-11-07' }));
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

test('does not keep the QTickets city listing as an event ticket URL', () => {
    const detail = parseQticketsDetailHtml(
        '<html><head><script type="application/ld+json">' + JSON.stringify({
            '@type': 'Event',
            name: 'Дима Вагин',
            startDate: '2026-10-18T19:30:00+03:00',
            offers: { price: '600', priceCurrency: 'RUB', url: 'https://voronezh.qtickets.events/' },
        }) + '</script></head><body><h1>Дима Вагин</h1></body></html>',
        'https://voronezh.qtickets.events/259022-dima-vagin-kontsert-2809-kopiya',
        { referenceDate },
    );
    assert.equal(detail.ticketUrl, '');
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

test('merge removes a stale QTickets listing root from an existing card', () => {
    const event = mergeQticketsCardAndDetail(
        {
            externalId: '259022',
            detailUrl: 'https://voronezh.qtickets.events/259022-dima-vagin-kontsert-2809-kopiya',
            ticketUrl: 'https://voronezh.qtickets.events/',
        },
        {},
    );
    assert.equal(event.ticketUrl, '');
});

test('does not take event date and time from unrelated page text or publication time', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">${JSON.stringify({
        '@type': 'Event', name: 'Тестовое событие',
        description: 'Концерт в Воронеже.',
    })}</script>
      </head><body>
        <h1>Тестовое событие</h1>
        <time class="published" datetime="2026-10-08T09:00:00+03:00">8 октября, 09:00</time>
        <div>Служебная дата страницы: 28 октября 2026, 23:30</div>
      </body></html>`;
    const detail = parseQticketsDetailHtml(
        html,
        'https://voronezh.qtickets.events/123-test',
        { referenceDate, fallbackCard: { eventDate: '2026-11-14', eventTime: '19:30', dateLabel: '14 ноября' } },
    );
    assert.equal(detail.eventDate, '2026-11-14');
    assert.equal(detail.eventTime, '19:30');
});

test('parses a multi-day numeric event date label without borrowing unrelated body dates', () => {
    const cards = parseQticketsListingHtml(`
      <ul><li class="item"><a href="/123-test" onclick="loadEvent(123)">
        <h2>Ночной фестиваль</h2>
        <time class="place"><span class="event-date">7.10 — 8.10</span></time>
      </a></li></ul>`, { referenceDate: new Date('2026-10-06T12:00:00+03:00') });
    assert.equal(cards[0].eventDate, '2026-10-07');
    assert.equal(cards[0].eventEndDate, '2026-10-08');

    const detail = parseQticketsDetailHtml(`
      <html><body><h1>Ночной фестиваль</h1>
        <div>Публикация страницы 09.10 — 11.10.2026</div>
      </body></html>`,
    'https://voronezh.qtickets.events/123-test', { referenceDate: new Date('2026-10-06T12:00:00+03:00'), fallbackCard: cards[0] });
    assert.equal(detail.eventDate, '2026-10-07');
    assert.equal(detail.eventEndDate, '2026-10-08');
});

test('does not infer a future year for a date that has just passed', () => {
    const cards = parseQticketsListingHtml(`
      <ul><li class="item"><a href="/124-test" onclick="loadEvent(124)">
        <h2>Прошедший концерт</h2><span class="event-date">3 октября</span>
      </a></li></ul>`, { referenceDate: new Date('2026-10-06T12:00:00+03:00') });
    assert.equal(cards[0].eventDate, '2026-10-03');
});

