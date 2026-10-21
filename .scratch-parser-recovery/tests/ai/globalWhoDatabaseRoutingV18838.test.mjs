import assert from 'node:assert/strict';
import {
    parseDatabaseMessageRetrievalQuery,
    parseGlobalWhoDatabaseQuery,
    messageTextMatchesRetrievalTerm,
} from '../../src/features/ai/globalWhoDatabaseRouting.js';

assert.deepEqual(parseGlobalWhoDatabaseQuery('кто такая ЕВИК?'), { matched: true, term: 'ЕВИК' });
assert.deepEqual(parseGlobalWhoDatabaseQuery('Гигорейв, кто такой евик'), { matched: true, term: 'евик' });
assert.deepEqual(parseGlobalWhoDatabaseQuery('кто за Blackозём!'), { matched: true, term: 'Blackозём' });
assert.equal(parseGlobalWhoDatabaseQuery('кто сегодня идет гулять').matched, false);
assert.equal(parseGlobalWhoDatabaseQuery('расскажи новости').matched, false);

assert.equal(messageTextMatchesRetrievalTerm('Где же евик...', 'ЕВИК'), true);
assert.equal(messageTextMatchesRetrievalTerm('С евиком?', 'ЕВИК'), true);
assert.equal(messageTextMatchesRetrievalTerm('Куда евика дели', 'ЕВИК'), true);
assert.equal(messageTextMatchesRetrievalTerm('новый боевик вышел', 'ЕВИК'), false);
assert.equal(messageTextMatchesRetrievalTerm('солевик опиушник', 'ЕВИК'), false);

assert.deepEqual(parseDatabaseMessageRetrievalQuery('кто такая ЕВИК?'), {
    matched: true,
    kind: 'identity',
    scope: 'global',
    term: 'ЕВИК',
    searchTerms: ['ЕВИК'],
});

const conversationalWho = parseDatabaseMessageRetrievalQuery('кто сегодня идет гулять?');
assert.equal(conversationalWho.matched, true);
assert.equal(conversationalWho.kind, 'question');
assert.equal(conversationalWho.scope, 'current-peer');
assert.ok(conversationalWho.searchTerms.some((term) => /гуля/iu.test(term)));
assert.ok(!conversationalWho.searchTerms.some((term) => /^сегодня$/iu.test(term)));

assert.equal(parseDatabaseMessageRetrievalQuery('что известно про ЕВИК').matched, false);
assert.equal(parseDatabaseMessageRetrievalQuery('что знаешь про riddim').matched, false);
assert.equal(parseDatabaseMessageRetrievalQuery('расскажи про riddim').matched, false);
assert.equal(parseDatabaseMessageRetrievalQuery('расскажи про новый риддим звук и про исполнителей').matched, false);

assert.deepEqual(parseDatabaseMessageRetrievalQuery('что писали про ЕВИК'), {
    matched: true,
    kind: 'topic',
    scope: 'global',
    term: 'ЕВИК',
    searchTerms: ['ЕВИК'],
});

assert.deepEqual(parseDatabaseMessageRetrievalQuery('найди сообщения про ЕВИК'), {
    matched: true,
    kind: 'topic',
    scope: 'global',
    term: 'ЕВИК',
    searchTerms: ['ЕВИК'],
});

assert.deepEqual(parseDatabaseMessageRetrievalQuery('проанализируй переписку про ЕВИК'), {
    matched: true,
    kind: 'conversation-analysis',
    scope: 'current-peer',
    term: 'ЕВИК',
    searchTerms: ['ЕВИК'],
});

assert.deepEqual(parseDatabaseMessageRetrievalQuery('проанализируй переписку'), {
    matched: true,
    kind: 'conversation-analysis',
    scope: 'current-peer',
    term: '',
    searchTerms: [],
});

assert.equal(parseDatabaseMessageRetrievalQuery('проанализируй по всей базе сообщений про ЕВИК').scope, 'global');
assert.equal(parseDatabaseMessageRetrievalQuery('расскажи новости').matched, false);
console.log('globalWhoDatabaseRoutingV18838 tests: OK');
