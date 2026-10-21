import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQticketsCommand } from '../../src/features/events/qticketsRouting.js';

test('recognizes public QTickets category aliases', () => {
    for (const input of ['qtickets', '/qtickets', 'qtickets события', 'qtickets events', 'события кутикетс', 'ивенты q-tickets']) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        assert.equal(result.action, 'list', input);
    }
});

test('recognizes the owner-only refresh namespace separately', () => {
    for (const input of ['qtickets парсер', 'qtickets обновить', 'парсер qtickets', 'q tickets run']) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        assert.equal(result.action, 'scrape', input);
    }
});

test('keeps an optional public date range after the namespace', () => {
    const result = parseQticketsCommand('qtickets события на выходных');
    assert.equal(result.matched, true);
    assert.equal(result.action, 'list');
    assert.equal(result.rangeText, 'на выходных');
});
