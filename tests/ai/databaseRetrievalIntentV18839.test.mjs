import assert from 'node:assert/strict';
import { parseDatabaseMessageRetrievalQuery } from '../../src/features/ai/globalWhoDatabaseRouting.js';

const ordinaryKnowledgeRequests = [
    'расскажи про новый риддим звук и про исполнителей',
    'расскажи про riddim',
    'расскажи всё про dubstep',
    'что известно про riddim',
    'что знаешь про riddim',
    'что такое riddim',
    'что это за riddim',
    'Гигорейв, расскажи про исполнителей riddim',
];

for (const request of ordinaryKnowledgeRequests) {
    assert.equal(
        parseDatabaseMessageRetrievalQuery(request).matched,
        false,
        `ordinary knowledge request must not enter DB retrieval: ${request}`,
    );
}

const identity = parseDatabaseMessageRetrievalQuery('Гигорейв, кто такая ЕВИК?');
assert.equal(identity.matched, true);
assert.equal(identity.kind, 'identity');
assert.equal(identity.scope, 'global');
assert.equal(identity.term, 'ЕВИК');

const currentPeerQuestion = parseDatabaseMessageRetrievalQuery('кто сегодня идет гулять?');
assert.equal(currentPeerQuestion.matched, true);
assert.equal(currentPeerQuestion.kind, 'question');
assert.equal(currentPeerQuestion.scope, 'current-peer');

const historyRequests = [
    ['проанализируй переписку про ЕВИК', 'conversation-analysis', 'current-peer'],
    ['что писали про ЕВИК', 'topic', 'global'],
    ['что говорили о ЕВИК', 'topic', 'global'],
    ['что обсуждали об ЕВИК', 'topic', 'global'],
    ['найди сообщения про ЕВИК', 'topic', 'global'],
    ['найди упоминания ЕВИК', 'topic', 'global'],
];

for (const [request, kind, scope] of historyRequests) {
    const parsed = parseDatabaseMessageRetrievalQuery(request);
    assert.equal(parsed.matched, true, `history request must enter DB retrieval: ${request}`);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.scope, scope);
}

assert.equal(
    parseDatabaseMessageRetrievalQuery('проанализируй по всей базе сообщений про ЕВИК').scope,
    'global',
);

console.log('databaseRetrievalIntentV18839 tests: OK');
