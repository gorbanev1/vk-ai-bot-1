import assert from 'node:assert/strict';
import {
    containsRememberCommandMarker,
    findMemoriesToForget,
    formatMemoryContext,
    parseRememberCommand,
    parseForgetCommand,
    parseStoredRememberCommand,
    isMemoryDatabaseScanCommand,
    rankMemoryEntries,
    tokenizeMemoryText,
} from '../../src/features/memory/memoryRouting.js';

assert.deepEqual(
    parseRememberCommand('запомни: Тимасин любит острые огурцы'),
    {
        matched: true,
        body: 'Тимасин любит острые огурцы',
        useReply: false,
    },
);

assert.equal(
    parseRememberCommand('что ты запомнил про Тимасина?').matched,
    false,
);

assert.deepEqual(
    parseRememberCommand('запоминай Тимасин любит острые огурцы'),
    {
        matched: true,
        body: 'Тимасин любит острые огурцы',
        useReply: false,
    },
);

assert.deepEqual(
    parseRememberCommand('внеси в память что Котёл — это бар'),
    {
        matched: true,
        body: 'Котёл — это бар',
        useReply: false,
    },
);

assert.equal(
    containsRememberCommandMarker('Гигорейв, сохрани в память это правило'),
    true,
);

assert.deepEqual(
    parseForgetCommand('распомни Тимасина'),
    {
        matched: true,
        body: 'Тимасина',
        useReply: false,
    },
);

assert.deepEqual(
    parseForgetCommand('разпомни ключевое слово цыжмюк'),
    {
        matched: true,
        body: 'цыжмюк',
        useReply: false,
    },
);

assert.deepEqual(
    parseForgetCommand('забудь про Котёл'),
    {
        matched: true,
        body: 'Котёл',
        useReply: false,
    },
);

assert.equal(parseForgetCommand('забудь это').useReply, true);
assert.equal(parseForgetCommand('что ты забыл про Тимасина?').matched, false);
assert.equal(parseRememberCommand('сохрани картинку').matched, false);
assert.equal(parseForgetCommand('удали фон с картинки').matched, false);

assert.equal(
    parseRememberCommand('сохрани в память это').useReply,
    true,
);


assert.equal(
    isMemoryDatabaseScanCommand('сканируй на запомнить'),
    true,
);

assert.equal(
    isMemoryDatabaseScanCommand('Просканируй всю базу сообщений на команду «запомни»'),
    true,
);

assert.equal(
    isMemoryDatabaseScanCommand('пересобери память из базы'),
    true,
);

assert.equal(
    isMemoryDatabaseScanCommand('кто просил тебя что-то запомнить?'),
    false,
);

assert.deepEqual(
    parseStoredRememberCommand('Гигорейв, запомни Тимасин любит острые огурцы'),
    {
        matched: true,
        body: 'Тимасин любит острые огурцы',
        useReply: false,
        commandText: 'запомни Тимасин любит острые огурцы',
    },
);

assert.deepEqual(
    parseStoredRememberCommand('[club123|Гигорейв] запомни что цыжмюк — это блюдо'),
    {
        matched: true,
        body: 'цыжмюк — это блюдо',
        useReply: false,
        commandText: 'запомни что цыжмюк — это блюдо',
    },
);

assert.equal(
    parseStoredRememberCommand('Он сказал мне запомни этот день').matched,
    false,
);

const entries = [
    {
        id: 1,
        authorId: 10,
        createdAt: 100,
        memoryText: 'Тимасин — организатор локальных концертов и любит острые огурцы.',
    },
    {
        id: 2,
        authorId: 11,
        createdAt: 200,
        memoryText: 'Цыжмюк — выдуманное блюдо из хлеба, соуса и маринованных овощей.',
    },
    {
        id: 3,
        authorId: 12,
        createdAt: 300,
        memoryText: 'В августе концерт MAUSOLEUM пройдёт в Diesel Hall.',
    },
    {
        id: 4,
        authorId: 13,
        createdAt: 400,
        memoryText: 'Тимасин также помогает с афишами и концертами.',
    },
    {
        id: 5,
        authorId: 14,
        createdAt: 500,
        memoryText: 'Котёл — локальный бар и площадка.',
    },
];

const who = rankMemoryEntries(entries, 'Кто такой Тимасин?');
assert.ok([1, 4].includes(who.matches[0].id));
assert.ok(who.matches[0].score >= 8);

const meaning = rankMemoryEntries(entries, 'Что значит цыжмюк?');
assert.equal(meaning.matches[0].id, 2);

const morphology = rankMemoryEntries(entries, 'Что известно о концерте Mausoleum?');
assert.equal(morphology.matches[0].id, 3);

const nothing = rankMemoryEntries(entries, 'Какая сегодня погода?');
assert.equal(nothing.matches.length, 0);

const forgottenTimasin = findMemoriesToForget(entries, 'Тимасин');
assert.deepEqual(
    forgottenTimasin.matches.map((entry) => entry.id).sort((a, b) => a - b),
    [1, 4],
);

const forgottenDefinition = findMemoriesToForget(entries, 'Котёл');
assert.deepEqual(
    forgottenDefinition.matches.map((entry) => entry.id),
    [5],
);

const forgottenUnknown = findMemoriesToForget(entries, 'несуществующее');
assert.equal(forgottenUnknown.matches.length, 0);

assert.deepEqual(
    tokenizeMemoryText('Кто такой Тимасин и что про него известно?'),
    ['тимасин'],
);

const context = formatMemoryContext(who.matches);
assert.match(context, /Тимасин/u);
assert.match(context, /автор VK 10/u);


assert.equal(
    parseRememberCommand('запомни: теперь ты лох').matched,
    false,
);
assert.equal(
    parseRememberCommand('ты запомни это').matched,
    false,
);
assert.equal(
    parseStoredRememberCommand('Гигарейф, запомни: теперь ты долбоёб').matched,
    false,
);
console.log('memoryRouting tests: OK');
