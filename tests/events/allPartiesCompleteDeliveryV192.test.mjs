import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packCompactVkEventList } from '../../src/features/events/compactEventListMessages.js';

test('VK compact all-parties response preserves every numbered card across message chunks', () => {
    const cards = Array.from({ length: 24 }, (_, index) =>
        [String(index + 1) + '. 🎸 Мероприятие ' + (index + 1), '📅 04.11', '📍 Клуб', '📝 ' + 'Описание '.repeat(28), '🔗 https://example.org/' + (index + 1)].join('\n'));
    const message = ['Тусы сегодня:', ...cards].join('\n\n');
    const chunks = packCompactVkEventList(message, 3500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 3500));
    assert.equal(chunks.join('\n\n'), message);
    cards.forEach((card) => assert.ok(chunks.some((chunk) => chunk.includes(card))));
});

test('VK compact output preserves oversized card rather than truncating it', () => {
    const event = '1. 🎸 Событие\n📝 ' + 'abc '.repeat(1500);
    const chunks = packCompactVkEventList('Тусы сегодня:\n\n' + event, 3500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 3500));
    assert.ok(chunks.join(' ').includes('abc'));
    assert.ok(chunks.join(' ').length >= event.length);
});

test('Telegram scraper accepts recentDays from the caller (undefined-variable regression)', () => {
    const source = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
    const signatureStart = source.indexOf('    async function run({');
    const signature = source.slice(signatureStart, signatureStart + 1400);
    assert.match(signature, /recentDays\s*=\s*0/);
    assert.match(source, /explainRecentOrFuturePost\(\{[\s\S]*?recentDays,/);
});
