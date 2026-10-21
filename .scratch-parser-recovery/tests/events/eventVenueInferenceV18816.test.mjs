import assert from 'node:assert/strict';
import test from 'node:test';

import {
    inferEventVenueFromText,
    knownVenueCatalog,
} from '../../src/features/events/eventVenueInference.js';

test('V188.16 explicit venue labels beat city-only VK structured placeholders', () => {
    const text = [
        'Название: 03.10 | Shoegaze Fall Night 2',
        'Дата: 03.10.2026',
        'Время: 18:00',
        'Место: Воронеж',
        'Описание: Dog Silent',
        'goodnight kisses',
        'муссон',
        'объект под видеонаблюдением',
        'Место: Котельная (https://t.me/kotelnaya_inc)',
        'Двери: 18:00',
    ].join('\n');

    const result = inferEventVenueFromText(text);
    assert.equal(result.canonical, 'Котельная');
    assert.equal(result.venue, 'Котельная');
    assert.equal(result.confidence, 1);
});

test('V188.16 generic labeled venues work without hard-coding every club name', () => {
    const result = inferEventVenueFromText([
        'Место: Воронеж',
        'Где: Черный квадрат',
        'Начало: 20:00',
    ].join('\n'));

    assert.equal(result.venue, 'Черный квадрат');
    assert.equal(result.method, 'explicit-labeled-venue');
    assert.ok(result.confidence >= 0.95);
});

test('V188.16 labeled address is a deterministic venue fallback', () => {
    const result = inferEventVenueFromText('Адрес: пр-т Революции 31а\nНачало 19:00');
    assert.match(result.venue, /Революции 31а/u);
    assert.equal(result.method, 'explicit-labeled-address');
});

test('V188.16 Kotelnaya is present in the canonical venue catalog', () => {
    assert.ok(knownVenueCatalog().some((item) => item.canonical === 'Котельная'));
    assert.equal(inferEventVenueFromText('в Котельной в 18:00').canonical, 'Котельная');
});
