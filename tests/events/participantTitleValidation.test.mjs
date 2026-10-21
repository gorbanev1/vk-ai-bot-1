import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';

const text = '10 октября 2026 вечеринка. HANTU, BARNI, XWILL. Кольцовская, 24/3. Начало в 22:00.';
const event = { date: '2026-10-10', time: '22:00', title: '', participants: 'HANTU, BARNI, XWILL', venue: 'Кольцовская, 24/3', evidence: text };
const post = { text, publishedAt: 1791417600 };

test('unnamed AI event with participants survives strict validation', () => {
    const result = validatePublicAiEvents(setPublicAiResponseMetadata([{ ...event }], { structure: 'single_event_program', valid: true }), post);
    assert.equal(result.length, 1);
    assert.equal(result.aiResponseValid, true);
    assert.equal(result[0].title, event.participants);
    assert.equal(result[0].eventDate, event.date);
});

test('participant fallback does not bypass date or evidence validation', () => {
    for (const change of [{ date: '2026-10-11' }, { evidence: 'Выдуманная цитата' }, { participants: '' }]) {
        const result = validatePublicAiEvents([{ ...event, ...change }], post);
        assert.equal(result.length, 0);
        assert.equal(result.aiResponseValid, false);
    }
});
