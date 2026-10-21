import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    shouldReviewEventDuplicatePairWithAi,
} from '../src/features/events/eventDuplicateAiPolicy.js';
import {
    parseActiveCommunicationCommand,
} from '../src/features/personality/activeCommunicationRouting.js';

function pair({ leftTitle, rightTitle, leftDate = '2026-09-12', rightDate = '2026-09-12', hardConflicts = [] }) {
    return {
        left: { title: leftTitle, date: leftDate, eventDays: [{ date: leftDate }] },
        right: { title: rightTitle, date: rightDate, eventDays: [{ date: rightDate }] },
        contour1: { hardConflicts },
    };
}

test('AI duplicate gate reviews shared-title and partial-title candidates only on the same date', () => {
    assert.equal(shouldReviewEventDuplicatePairWithAi(pair({
        leftTitle: 'Industrial Madness',
        rightTitle: 'INDUSTRIAL MADNESS',
    })), true);

    assert.equal(shouldReviewEventDuplicatePairWithAi(pair({
        leftTitle: 'Industrial Madness',
        rightTitle: 'Industrial Madness — Live Noise Ritual',
    })), true);

    assert.equal(shouldReviewEventDuplicatePairWithAi(pair({
        leftTitle: 'Industrial Madness',
        rightTitle: 'Industrial Madness — Live Noise Ritual',
        rightDate: '2026-09-13',
    })), false);

    assert.equal(shouldReviewEventDuplicatePairWithAi(pair({
        leftTitle: 'Industrial Madness',
        rightTitle: 'Industrial Madness — Live Noise Ritual',
        hardConflicts: ['venue-conflict'],
    })), false);
});

test('participant fallback runs only when same-date titles have no shared identity', () => {
    assert.equal(shouldReviewEventDuplicatePairWithAi({
        left: { title: 'ЗАЕЗЖАЕМ', eventDate: '2026-10-03', participants: 'Дездемон Сидоров, Артём Фатеев, Максим Долин' },
        right: { title: 'Moonlight', eventDate: '2026-10-03', participants: 'Дездемон Сидоров; Артема Фатеева; Максима Долина' },
        contour1: { hardConflicts: [] },
    }), true);

    assert.equal(shouldReviewEventDuplicatePairWithAi({
        left: { title: 'ЗАЕЗЖАЕМ', eventDate: '2026-10-03', participants: 'Дездемон Сидоров' },
        right: { title: 'Moonlight', eventDate: '2026-10-04', participants: 'Дездемон Сидоров' },
        contour1: { hardConflicts: [] },
    }), false);

    assert.equal(shouldReviewEventDuplicatePairWithAi({
        left: { title: 'Концерт Альфа', eventDate: '2026-10-03', participants: 'Дездемон Сидоров' },
        right: { title: 'Концерт Альфа акустика', eventDate: '2026-10-03', participants: 'Дездемон Сидоров' },
        contour1: { hardConflicts: [] },
    }), true, 'shared title follows the existing title path');
});

test('active communication interval command accepts persistent windows', () => {
    assert.deepEqual(parseActiveCommunicationCommand('Гигорейв активное общение 100'.replace(/^Гигорейв\s+/iu, '')), {
        matched: true,
        action: 'enable',
        interval: 100,
    });
});

test('runtime V149 wires smart AI dedupe and restart-safe active chat state', () => {
    const app = readFileSync(new URL('../src/app/botApplication.js', import.meta.url), 'utf8');
    const db = readFileSync(new URL('../src/infrastructure/database/index.js', import.meta.url), 'utf8');

    assert.match(app, /shouldReviewEventDuplicatePairWithAi/u);
    assert.match(app, /arbitrateAmbiguous:\s*arbitrateAmbiguousEventDuplicatesWithMini/u);
    assert.match(app, /точные название\+дата решаю локально/u);
    assert.match(app, /chooseRandomActiveCommunicationPersona/u);
    assert.match(app, /settings\.activeChatInterval/u);
    assert.match(app, /COMMUNICATION STATE RESTORED FROM SQLITE/u);
    assert.doesNotMatch(app, /const rescheduledOutbursts = rescheduleCommunicationOutburstsWithinWindow/u);

    assert.match(db, /active_chat_interval INTEGER NOT NULL DEFAULT 10/u);
    assert.match(db, /active_chat_target_offset INTEGER NOT NULL DEFAULT 0/u);
    assert.match(db, /activeChatInterval/u);
    assert.match(db, /activeChatTargetOffset/u);
});
