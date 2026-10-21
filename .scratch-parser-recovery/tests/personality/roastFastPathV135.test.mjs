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

test('VK and Telegram group handlers have absolute roast command fast-paths', () => {
    const matches = applicationSource.match(/\[ROAST COMMAND FASTPATH\]/gu) ?? [];
    assert.equal(matches.length, 2);
    assert.match(
        applicationSource,
        /const roastFastCommand = parseRoastCommand\(roastFastText\);[\s\S]{0,500}platform=vk[\s\S]{0,500}await handleRoastCommand\(context, roastFastCommand\);/u,
    );
    assert.match(
        applicationSource,
        /const roastFastCommand = parseRoastCommand\(roastFastText\);[\s\S]{0,500}platform=telegram[\s\S]{0,500}await handleRoastCommand\(context, roastFastCommand\);/u,
    );
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

test('Telegram non-image command detector recognizes all roast aliases', () => {
    assert.match(telegramSource, /доебаться\|доебись\|докопаться\|фас/u);
});
