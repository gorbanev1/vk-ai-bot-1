import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseRoastCommand } from '../../src/features/personality/roastCommandRouting.js';

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const telegramSource = readFileSync(
    new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url),
    'utf8',
);

test('both screenshot command forms are accepted exactly', () => {
    assert.deepEqual(parseRoastCommand('гигорейв доебись Денни'), {
        matched: true,
        mode: 'named',
        targetQuery: 'Денни',
    });
    assert.deepEqual(parseRoastCommand('гигорейв доебаться @deoko'), {
        matched: true,
        mode: 'named',
        targetQuery: '@deoko',
    });
});

test('common imperative aliases are accepted too', () => {
    for (const command of [
        'доебайся Денни',
        'доебывайся Денни',
        'докопайся Денни',
        'докопаться Денни',
        'фас Денни',
    ]) {
        assert.equal(parseRoastCommand(command).matched, true, command);
    }
});

test('named roast path does not wait for full VK conversation roster', () => {
    const start = applicationSource.indexOf('async function handleRoastCommand');
    const end = applicationSource.indexOf('function randomUnitInterval', start);
    const block = applicationSource.slice(start, end);

    assert.match(
        block,
        /includeVkRoster:\s*parsedCommand\.mode === 'random'/u,
    );
    assert.match(applicationSource, /Roast target lookup timeout after/u);
});

test('Telegram local command detector knows all roast aliases', () => {
    assert.match(
        telegramSource,
        /доебаться\|доебись\|докопаться\|фас\|доебайся\|доебывайся\|докопайся/u,
    );
});
