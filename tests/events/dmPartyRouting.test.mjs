import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyExplicitDmPartyRequest,
} from '../../src/features/events/dmPartyRouting.js';

test('explicit next-party date question is routed to party_date', () => {
    const result = classifyExplicitDmPartyRequest('Когда наша следующая туса?');

    assert.equal(result.matched, true);
    assert.deepEqual(result.intents, ['party_date']);
});

test('explicit party format and details question returns only supported intents', () => {
    const result = classifyExplicitDmPartyRequest(
        'Какой формат у следующей тусы и когда появятся подробности?',
    );

    assert.equal(result.matched, true);
    assert.deepEqual(result.intents, [
        'party_date',
        'party_format',
        'party_info',
    ]);
});

test('ordinary DM does not get redirected to owner party FAQ', () => {
    const requests = [
        'Что именно нужно сделать с парсером?',
        'Расскажи, что ты умеешь',
        'Проверь отдельный API ключ',
        'Почему ты отвечаешь про мои тусы?',
        'Что сегодня?',
        'Какой у тебя диагноз?',
    ];

    for (const request of requests) {
        const result = classifyExplicitDmPartyRequest(request);
        assert.equal(result.matched, false, request);
    }
});

test('public event query is not treated as private organizer party', () => {
    const result = classifyExplicitDmPartyRequest(
        'Какие мероприятия и концерты сегодня?',
    );

    assert.equal(result.matched, false);
    assert.equal(result.reason, 'public-events-request');
});


test('nearest-party shorthand routes to the fixed organizer announcement', () => {
    for (const request of [
        'ближайшая туса',
        'Ближайшая тусовка?',
        'что за ближайшая туса',
        'когда ближайшая туса',
        'ближайший гиг',
    ]) {
        const result = classifyExplicitDmPartyRequest(request);
        assert.equal(result.matched, true, request);
        assert.ok(result.intents.includes('party_date'), request);
    }
});


test('plural nearest parties stay on the public-events route', () => {
    for (const request of [
        'ближайшие тусы',
        'какие ближайшие тусы',
        'следующие тусы',
        'ближайшие тусовки',
    ]) {
        const result = classifyExplicitDmPartyRequest(request);
        assert.equal(result.matched, false, request);
        assert.equal(result.reason, 'public-events-request', request);
    }
});
