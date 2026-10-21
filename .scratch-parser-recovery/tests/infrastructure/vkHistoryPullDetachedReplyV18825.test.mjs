import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    createVkIncomingReplyContext,
    getVkIncomingReplyTarget,
} from '../../src/shared/incomingReplyTransport.js';

const botSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V18825 can unwrap incoming-reply proxy for detached VK sends', async () => {
    const calls = [];
    const context = {
        reply(payload) {
            calls.push({ type: 'reply', payload });
        },
        send(payload, params) {
            calls.push({ type: 'send', payload, params });
        },
    };
    const proxy = createVkIncomingReplyContext(context);
    await proxy.send('immediate');
    await getVkIncomingReplyTarget(proxy).send('detached');

    assert.deepEqual(calls.map((item) => item.type), ['reply', 'send']);
    assert.equal(calls[1].payload, 'detached');
});

test('V18825 history pull completion and failure use detached transport after recovery', () => {
    assert.match(botSource, /function sendVkDetached\(context, payload, params\)/u);
    assert.match(botSource, /const target = getVkIncomingReplyTarget\(raw\)/u);

    const start = botSource.indexOf('async function maybeHandleVkHistoryPullCommand');
    const end = botSource.indexOf('async function maybeHandleServiceEventsReportCommand', start);
    assert.ok(start >= 0 && end > start);
    const handler = botSource.slice(start, end);
    const recoveryAt = handler.indexOf('const recovery = await runVkHistoryRecovery');
    assert.ok(recoveryAt >= 0);
    const afterRecovery = handler.slice(recoveryAt);
    assert.match(afterRecovery, /await sendVkDetached\(rawContext,[\s\S]*Не удалось полностью подтянуть историю/u);
    assert.match(afterRecovery, /await sendVkDetached\(rawContext, \[[\s\S]*✅ История за/u);
});
