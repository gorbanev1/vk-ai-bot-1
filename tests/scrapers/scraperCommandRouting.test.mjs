import assert from 'node:assert/strict';

import {
    parseScraperStartCommand,
} from '../../src/features/scrapers/scraperCommandRouting.js';
import {
    formatScraperErrorForUser,
} from '../../src/features/scrapers/scraperError.js';

const positiveCases = [
    ['парсер', '', false, false, true],
    ['парсеры', '', false, false, true],
    ['парсер все', '', false, true, false],
    ['парсер все чисто', '', false, true, false],
    ['тусы парсер все чисто', '', false, true, false],
    ['тусы парсер все', '', false, true, false],
    ['Гигорейв тусы парсер все', '', false, true, false],
    ['парсер всё', '', false, true, false],
    ['парсер запустить все', '', false, true, false],
    ['run all scrapers', '', false, true, false],
    ['парсер tg:kurazhcity', 'tg:kurazhcity', false, false, false],
    ['парсер VK:OVERLOCKBAR', 'vk:overlockbar', false, false, false],
    ['scraper chat:2000000014', 'chat:2000000014', false, false, false],
    ['парсер запустить tg:kurazhcity', 'tg:kurazhcity', false, false, false],
    ['скрейпер старт chat:2000000022', 'chat:2000000022', false, false, false],
    ['run scraper vk:overlockbar', 'vk:overlockbar', false, false, false],
    ['парсер запустить', '', false, false, true],
    ['парсер сейчас', '', true, false, true],
    ['парсер бесед запустить', '', true, false, true],
    ['добавить источник https://t.me/new_channel', '', false, false, false, true, 'https://t.me/new_channel'],
    ['тусы добавить источник https://vk.ru/new_club', '', false, false, false, true, 'https://vk.ru/new_club'],
    ['Гигорейв добавить источник @new_channel', '', false, false, false, true, '@new_channel'],
];

for (const [input, sourceId, legacy, all, help, addSource = false, sourceInput = ''] of positiveCases) {
    const parsed = parseScraperStartCommand(input);

    assert.equal(parsed.matched, true, input);
    assert.equal(parsed.sourceId, sourceId, input);
    assert.equal(parsed.legacy, legacy, input);
    assert.equal(parsed.all, all, input);
    assert.equal(parsed.help, help, input);
    assert.equal(Boolean(parsed.addSource), addSource, input);
    if (addSource) assert.equal(parsed.sourceInput, sourceInput, input);
}

for (const input of ['парсер статус', 'обычный вопрос', 'парсер остановить']) {
    assert.equal(parseScraperStartCommand(input).matched, false, input);
}



assert.equal(
    formatScraperErrorForUser({
        code: 'ECONNRESET',
        message: 'socket disconnected',
    }),
    'socket disconnected; код ECONNRESET',
);
assert.match(
    formatScraperErrorForUser({
        foo: 'bar',
        nested: { value: 1 },
    }),
    /foo.*bar/u,
);
assert.doesNotMatch(
    formatScraperErrorForUser({ foo: 'bar' }),
    /\[object Object\]/u,
);
const fakeTelegramToken = `${'1'.repeat(9)}:${'A'.repeat(32)}`;
assert.doesNotMatch(
    formatScraperErrorForUser(new Error(`token ${fakeTelegramToken}`)),
    /1{9}:A{10}/u,
);

console.log('scraperCommandRouting tests: OK');

const applicationSource = await import('node:fs/promises')
    .then(({ readFile }) => readFile(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    ));

assert.match(applicationSource, /async function startAllManualScraperSources\(\{ incrementalOnly = false \} = \{\}\)/u);
assert.match(applicationSource, /Запускаю сбор всех настроенных источников/u);
assert.match(applicationSource, /Гигорейв парсер все/u);
assert.match(applicationSource, /events-v\d+-[a-z0-9-]+/u);
assert.match(applicationSource, /handleManualScraperCommand/u);
assert.match(applicationSource, /formatScraperErrorForUser/u);
assert.match(applicationSource, /reason=telegram-offline/u);
assert.match(applicationSource, /routeDecision\.route === 'scraper-start'/u);
assert.match(applicationSource, /resolveCommandPriority\(requestText/u);

const singleReparse = parseScraperStartCommand('Гигорейв парсер ссылка https://vk.ru/wall-240894883_12');
assert.equal(singleReparse.matched, true);
assert.equal(singleReparse.reparseUrl, 'https://vk.ru/wall-240894883_12');
assert.equal(singleReparse.all, false);
assert.equal(singleReparse.help, false);

const singleReparseShort = parseScraperStartCommand('парсер https://vk.ru/wall-240894883_12');
assert.equal(singleReparseShort.matched, true);
assert.equal(singleReparseShort.reparseUrl, 'https://vk.ru/wall-240894883_12');
