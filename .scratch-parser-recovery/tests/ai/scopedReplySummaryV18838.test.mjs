import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(source, /shouldUseScopedVkSummary\(context, requestText\)/u);
assert.match(source, /sendScopedVkAttachmentSummary/u);
assert.match(source, /resolveDeepestVkAttachmentContent/u);
assert.match(source, /trySendDatabaseMessageRetrievalAnswer[\s\S]*trySendParticipantDatabaseAnswer/u);
assert.match(source, /searchStoredMessagesByText\(term\)/u);
assert.match(source, /Резюмируй ТОЛЬКО приложенное содержимое конкретного сообщения\/репоста VK/u);

const retrievalRoute = source.indexOf("await trySendDatabaseMessageRetrievalAnswer({");
const genericChatDatabaseRoute = source.indexOf("if (parsed.action === 'chat-context')", retrievalRoute);
assert.ok(retrievalRoute >= 0 && genericChatDatabaseRoute > retrievalRoute, 'database retrieval must run before generic chat-context analysis');
assert.match(source, /rawMatches\.push\(\.\.\.searchStoredMessagesByText\(term\)\)/u);
assert.match(source, /Все найденные сообщения из этого фрагмента являются материалом для анализа и должны быть учтены/u);
assert.match(source, /if \(!unique\.length\)[\s\S]*return true;/u);

console.log('scopedReplySummaryV18838 tests: OK');
