import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    parseRoastCommand,
} from '../../src/features/personality/roastCommandRouting.js';

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const telegramSource = readFileSync(
    new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url),
    'utf8',
);

test('доебись works as standalone and with Gigorave prefix', () => {
    assert.deepEqual(parseRoastCommand('доебись'), {
        matched: true,
        mode: 'random',
        targetQuery: '',
    });
    assert.deepEqual(parseRoastCommand('Гигорейв доебись @donwi'), {
        matched: true,
        mode: 'named',
        targetQuery: '@donwi',
    });
    assert.deepEqual(parseRoastCommand('гигорейв доебаться @deoko'), {
        matched: true,
        mode: 'named',
        targetQuery: '@deoko',
    });
});

test('VK and Telegram use centralized roast parser on their absolute fast paths', () => {
    const matches=applicationSource.match(/\[ROAST COMMAND FASTPATH\]/gu) ?? [];
    assert.equal(matches.length,2);
    assert.match(applicationSource,/const roastFastMatch = parseIncomingCommand\(\s*text,\s*parseRoastCommand,/u);
    assert.match(applicationSource,/const roastFastMatch = parseIncomingCommand\(\s*originalText \|\| text,\s*parseRoastCommand,/u);
    assert.equal((applicationSource.match(/const roastFastCommand = roastFastMatch\.parsed/gu)??[]).length,2);
    assert.equal((applicationSource.match(/await handleRoastCommand\(context, roastFastCommand\);/gu)??[]).length,2);
    assert.match(applicationSource,/platform=vk/u);
    assert.match(applicationSource,/platform=telegram/u);
});

test('explicit VK target is resolved before loading the whole conversation roster', () => {
    const start = applicationSource.indexOf('async function handleRoastCommand');
    const end = applicationSource.indexOf('function randomUnitInterval', start);
    const block = applicationSource.slice(start, end);
    const directIndex = block.indexOf('resolveExplicitVkRoastParticipant');
    const rosterIndex = block.indexOf('collectRoastParticipants');

    assert.ok(directIndex >= 0);
    assert.ok(rosterIndex > directIndex);
});

test('Telegram route uses the same tested aliases as VK',()=>{
    assert.match(applicationSource,/originalText \|\| text,\s*parseRoastCommand,/u);
    for(const phrase of [
        '\u0434\u043e\u0435\u0431\u0430\u0442\u044c\u0441\u044f',
        '\u0434\u043e\u0435\u0431\u0438\u0441\u044c',
        '\u0434\u043e\u043a\u043e\u043f\u0430\u0442\u044c\u0441\u044f',
        '\u0444\u0430\u0441'
    ])assert.equal(parseRoastCommand(phrase).matched,true,phrase);
});
