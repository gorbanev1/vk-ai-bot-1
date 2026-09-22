import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    parseLeaverCommand,
    parseParticipantDmBroadcastCommand,
} from '../../src/features/membership/leaverCommandRouting.js';

const botSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const dbSource = await readFile(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');

test('V182 parses manual leaver periods', () => {
    assert.deepEqual(parseLeaverCommand('Гигорейв кто вышел сегодня').period.kind, 'today');
    assert.deepEqual(parseLeaverCommand('Гигорейв кто вышел вчера').period.kind, 'yesterday');
    assert.equal(parseLeaverCommand('Гигорейв кто вышел за 2 дня').period.days, 2);
    assert.deepEqual(parseLeaverCommand('Гигорейв кто вышел 08.09').period, { kind: 'date', day: 8, month: 9, year: 0, label: '08.09' });
    assert.equal(parseLeaverCommand('Гигорейв кто вышел день').period.days, 1);
    assert.equal(parseLeaverCommand('Гигорейв кто вышел 3 дня').period.days, 3);
    assert.deepEqual(parseLeaverCommand('Гигорейв кто вышел на этой неделе').period.kind, 'current-week');
    assert.equal(parseLeaverCommand('Гигорейв кто вышел неделя').period.days, 7);
});

test('V182 parses durable automatic leaver periods', () => {
    assert.equal(parseLeaverCommand('Гигорейв кто вышел авто день').action, 'auto-enable');
    assert.equal(parseLeaverCommand('Гигорейв кто вышел авто 5 дней').period.days, 5);
    assert.equal(parseLeaverCommand('Гигорейв кто вышел авто неделя').period.days, 7);
    assert.equal(parseLeaverCommand('Гигорейв кто вышел авто выкл').action, 'auto-disable');
    assert.equal(parseLeaverCommand('Гигорейв кто вышел авто статус').action, 'auto-status');
});

test('V182 parses owner participant-DM broadcasts', () => {
    assert.deepEqual(
        parseParticipantDmBroadcastCommand('Гигорейв лс участникам привет всем'),
        { matched: true, invalid: false, activeDays: 0, message: 'привет всем' },
    );
    assert.deepEqual(
        parseParticipantDmBroadcastCommand('Гигорейв лс участникам активным 7 дней тест'),
        { matched: true, invalid: false, activeDays: 7, message: 'тест' },
    );
});

test('V182 has durable leaver auto settings and owner-only DM delivery', () => {
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS chat_leaver_auto_settings/);
    assert.match(dbSource, /export function getDueChatLeaverAutoSettings/);
    assert.match(botSource, /async function runChatLeaverAutoTick/);
    assert.match(botSource, /async function maybeHandleParticipantDmBroadcastCommand/);
    assert.match(botSource, /if \(!isOwnerContext\(rawContext\)\)/);
    assert.match(botSource, /runChatLeaverAutoTick/);
});
