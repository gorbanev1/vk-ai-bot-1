import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    classifyTelegramConnectionError,
    formatTelegramConnectivityDiagnostics,
    runTelegramConnectivityDiagnostics,
} from '../../src/platforms/telegram/telegramConnectivity.js';

test('classifies nested ECONNRESET as retryable TLS reset', () => {
    const error = new TypeError('fetch failed', {
        cause: Object.assign(
            new Error('Client network socket disconnected before secure TLS connection was established'),
            { code: 'ECONNRESET' },
        ),
    });
    const result = classifyTelegramConnectionError(error);

    assert.equal(result.kind, 'tls-reset');
    assert.equal(result.retryable, true);
    assert.equal(result.code, 'ECONNRESET');
});

test('classifies Telegram HTTP 401 as non-retryable invalid token', () => {
    const error = Object.assign(new Error('Telegram Bot API getMe: Unauthorized'), {
        status: 401,
        code: 401,
    });
    const result = classifyTelegramConnectionError(error);

    assert.equal(result.kind, 'invalid-token');
    assert.equal(result.retryable, false);
});

test('probes Bot API and t.me independently', async () => {
    const requested = [];
    const result = await runTelegramConnectivityDiagnostics({
        timeoutMs: 1000,
        async fetchImpl(url) {
            requested.push(url);
            return new Response('', {
                status: url.includes('api.telegram.org') ? 404 : 200,
            });
        },
    });

    assert.deepEqual(requested.sort(), [
        'https://api.telegram.org',
        'https://t.me',
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.probes[0].status, 404);
    assert.equal(result.probes[1].status, 200);
});

test('formats endpoint failure without object stringification', async () => {
    const result = await runTelegramConnectivityDiagnostics({
        timeoutMs: 1000,
        async fetchImpl(url) {
            if (url.includes('t.me')) {
                throw Object.assign(new Error('connection reset'), {
                    code: 'ECONNRESET',
                });
            }

            return new Response('', { status: 404 });
        },
    });
    const formatted = formatTelegramConnectivityDiagnostics(result);

    assert.equal(result.ok, false);
    assert.match(formatted, /Telegram Web: недоступен/iu);
    assert.match(formatted, /ECONNRESET/iu);
    assert.doesNotMatch(formatted, /\[object Object\]/u);
});

test('application wires startup retries, diagnostics command and reconnect timer', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    const routingSource = readFileSync(
        new URL('../../src/features/routing/commandPriorityRouting.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /TELEGRAM_STARTUP_ATTEMPTS\s*=\s*3/u);
    assert.match(source, /scheduleTelegramReconnect/u);
    assert.match(source, /runTelegramConnectivityDiagnostics/u);
    assert.match(source, /routeDecision\.route === 'telegram-diagnostic'/u);
    assert.match(routingSource, /телеграм\|телега\|telegram/u);
    assert.match(routingSource, /explicit-telegram-diagnostic/u);
    assert.match(source, /owner-diagnostic-command/u);
});
