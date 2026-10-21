import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { splitTelegramLongReply, sendTelegramLongReply } from '../../src/platforms/telegram/telegramLongReply.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');

test('splitter never drops whitespace, code blocks, or emoji and respects conservative limit', () => {
    const input = '🤖 Модель: gpt-5.6-terra\n\n' + ('🌍Пример_текст_ с пробелом\n\n```js\nconst a = 1;\n```\n').repeat(375);
    const chunks = splitTelegramLongReply(input);
    assert.ok(chunks.length > 3);
    assert.equal(chunks.join(''), input);
    assert.ok(chunks.every(chunk => chunk.length <= 3500));
    assert.ok(chunks.every(chunk => !chunk.includes('\uFFFD')));
    assert.ok(chunks.every(chunk => !(chunk.charCodeAt(chunk.length - 1) >= 0xD800 && chunk.charCodeAt(chunk.length - 1) <= 0xDBFF)));
});

test('long complete answer is sent sequentially with distinct part headers and actual message IDs', async () => {
    const texts = []; const logs = [];
    const reply = '🤖 Модель: gpt-5.6-terra\n\n' + 'abcdef 🌍\n'.repeat(1800);
    let active = false;
    const result = await sendTelegramLongReply({
        api: { async sendMessage({ text }) { assert.equal(active, false); active = true; texts.push(text); await Promise.resolve(); active = false; return { message_id: 100 + texts.length }; } },
        chatId: 42, text: reply, log: (event, data) => logs.push([event, data]),
    });
    assert.ok(texts.length > 2);
    assert.equal(texts.map(part => part.replace(/^Часть \d+\/\d+\n/u, '')).join(''), reply);
    assert.ok(texts.every((part) => part.length <= 3500));
    assert.equal(result.parts, texts.length);
    assert.equal(result.messageIds.length, texts.length);
    assert.equal(logs.filter(([event]) => event === 'part-sent').length, texts.length);
});

test('Telegram 429 with retry_after retries only rejected part, without another AI request', async () => {
    let sends = 0; let slept = 0;
    await sendTelegramLongReply({ api: { async sendMessage() {
        sends++;
        if (sends === 1) throw Object.assign(new Error('Too Many Requests'), {status:429, response:{body:{parameters:{retry_after:1}}}});
        return {message_id: 1};
    }}, chatId: 2, text: 'hello', sleep: async ms => { slept = ms; }});
    assert.equal(sends, 2); assert.equal(slept, 2000);
});

test('ambiguous Telegram transport exception is not blindly retried or logged with private answer', async () => {
    const events = []; const answer = 'PRIVATE_TEXT_' + 'x'.repeat(8000); let sends = 0;
    await assert.rejects(sendTelegramLongReply({
        api: { async sendMessage() { sends++; if (sends === 2) throw new Error('fetch failed'); return {message_id:sends}; } },
        chatId: 4, text:answer, log: (event, data) => events.push([event, data]),
    }), (err) => err.telegramDelivery.sentParts === 1 && err.telegramDelivery.part === 2);
    assert.equal(sends, 2);
    assert.equal(JSON.stringify(events).includes('PRIVATE_TEXT_'), false);
});

// Extract actual streaming delivery factory without starting the full bot.
function getStreamSession(api) {
    const begin = app.indexOf('function createTelegramTextStreamSession(context) {');
    const end = app.indexOf('\n}\n', begin) + 2;
    assert.ok(begin >= 0 && end > begin);
    const source = app.slice(begin, end);
    return runInNewContext(`${source}\ncreateTelegramTextStreamSession`, {
        getRawContext: c => c,
        splitTelegramStreamingText: text => splitTelegramLongReply(text),
        TELEGRAM_STREAM_FIRST_FLUSH_MS: 100,
        TELEGRAM_STREAM_EDIT_INTERVAL_MS: 100,
        TELEGRAM_STREAM_MIN_DELTA_CHARS: 72,
        formatPrivateError: e => e?.name || 'Error',
        console: { info() {}, warn() {} },
        setTimeout, clearTimeout, Date,
    })({platform:'telegram',telegramApi:api,externalPeerId:'1',conversationMessageId:17});
}

test('actual streaming session delivers full 16K response across Telegram messages', async () => {
    const sent=[]; let id=0;
    const api={ async sendMessage(p){sent.push({...p,message_id:++id});return {message_id:id};},async editMessageText(){} };
    const session=getStreamSession(api);
    const text='HELLO\n'+'🌍 строка\n'.repeat(1600);
    session.push(text);
    const result=await session.finalize(text);
    assert.equal(result.handled,true);
    assert.ok(sent.length >= 4);
    assert.equal(sent.map(x=>x.text).join(''),text);
});

test('partial streaming delivery failure marks already-delivered messages; app uses complete TXT rescue without replay', async () => {
    let id=0;
    const api={ async sendMessage(){ id++; if(id===2) throw Error('fetch failed'); return {message_id:id};}, async editMessageText(){} };
    const session=getStreamSession(api);
    const text='a'.repeat(9000);
    session.push(text);
    const result=await session.finalize(text);
    assert.equal(result.handled,false);
    assert.equal(result.sentAny,true);
    assert.equal(result.failed,true);
    assert.equal(result.messageIds.length,1);
    assert.match(app,/streamResult\?\.failed && streamResult\?\.sentAny/u);
    assert.match(app,/filename: 'gigorave-complete-ai-answer\.txt'/u);
    assert.match(app,/streamedTelegramAnswerHandled = true;/u);
    assert.match(adapter,/await sendTelegramLongReply\(/u);
});
