import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    TELEGRAM_MENU_BUTTONS,
    createTelegramBot,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

function telegramMessage(updateId, text, { chatId = 1001, userId = 2001 } = {}) {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: 'private' },
            from: { id: userId, is_bot: false, first_name: 'Test' },
            text,
        },
    };
}

test('Telegram pending mode always has a textual emergency exit', () => {
    const pending = { pendingAction: 'image', pendingModel: 'pro2' };
    for (const command of ['отмена', 'отменить', 'cancel', 'стоп', 'сбросить режим', 'выйти']) {
        const result = resolveTelegramMenuInput(command, pending, { isOwner: false });
        assert.equal(result.type, 'response', command);
        assert.equal(result.state.pendingAction, '', command);
        assert.equal(result.state.pendingModel, '', command);
        assert.match(result.text, /отменено/iu, command);
    }
});

test('Telegram cancel without menu state is forwarded to application pending-state cancel', () => {
    const result = resolveTelegramMenuInput('отмена', {}, { isOwner: false });
    assert.equal(result.type, 'command');
    assert.equal(result.text, 'отмена');
});

test('Telegram long polling keeps dispatching while an earlier user task never resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18847-tg-'));
    const never = new Promise(() => {});
    const seen = [];
    let batchReturned = false;
    let stopped = false;

    const fakeApi = {
        async getMe() { return { id: 777, username: 'Gigorave_bot' }; },
        async deleteWebhook() {},
        async getUpdates() {
            if (!batchReturned) {
                batchReturned = true;
                return [
                    telegramMessage(1, 'первый запрос'),
                    telegramMessage(2, 'второй запрос'),
                ];
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [];
        },
        async sendMessage() { return { message_id: 999 }; },
        async sendChatAction() {},
    };

    const bot = createTelegramBot({
        token: 'fake-token',
        apiOverride: fakeApi,
        resolvePeerId: () => -3000000001,
        resolveUserId: () => 3000000001,
        statePath: join(root, 'offset.json'),
        logger: { log() {}, error() {} },
        onMessage(context) {
            seen.push(context.text);
            if (context.text === 'первый запрос') return never;
            return Promise.resolve();
        },
    });

    try {
        await bot.start();
        const deadline = Date.now() + 500;
        while (seen.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepEqual(seen.slice(0, 2), ['первый запрос', 'второй запрос']);
    } finally {
        if (!stopped) {
            stopped = true;
            await bot.stop();
        }
        rmSync(root, { recursive: true, force: true });
    }
});

test('Telegram menu API send cannot pinball-lock polling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18847-menu-'));
    const seen = [];
    let batchReturned = false;
    const neverSend = new Promise(() => {});

    const fakeApi = {
        async getMe() { return { id: 777, username: 'Gigorave_bot' }; },
        async deleteWebhook() {},
        async getUpdates() {
            if (!batchReturned) {
                batchReturned = true;
                return [
                    telegramMessage(10, TELEGRAM_MENU_BUTTONS.parties),
                    telegramMessage(11, 'обычный второй запрос'),
                ];
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [];
        },
        sendMessage() { return neverSend; },
        async sendChatAction() {},
    };

    const bot = createTelegramBot({
        token: 'fake-token',
        apiOverride: fakeApi,
        resolvePeerId: () => -3000000002,
        resolveUserId: () => 3000000002,
        statePath: join(root, 'offset.json'),
        logger: { log() {}, error() {} },
        onMessage(context) {
            seen.push(context.text);
            return Promise.resolve();
        },
    });

    try {
        await bot.start();
        const deadline = Date.now() + 500;
        while (!seen.includes('обычный второй запрос') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(seen.includes('обычный второй запрос'));
    } finally {
        await bot.stop();
        rmSync(root, { recursive: true, force: true });
    }
});

test('VK and provider wiring has no global user-request serialization', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.doesNotMatch(source, /let\s+gigaQueue\s*=\s*Promise\.resolve/u);
    assert.match(
        source,
        /function enqueueGigaChat\(task\)\s*\{\s*return Promise\.resolve\(\)\.then\(task\);\s*\}/su,
    );
    assert.match(
        source,
        /connection\.client\.updates\.on\('message_new',\s*\(incomingContext\)\s*=>\s*\{[\s\S]*?void task\.catch/su,
    );
    assert.doesNotMatch(
        source,
        /await\s+connection\.client\.updates\.start\(\)/u,
    );
    assert.match(source, /maybeHandleGlobalInteractionCancel\(context, text\)/u);
    assert.match(source, /maybeHandleGlobalInteractionCancel\(context, originalText \|\| text\)/u);
    assert.match(source, /GIGACHAT_INTERACTIVE_TIMEOUT_MS/u);
    assert.match(source, /GIGACHAT_IMAGE_TIMEOUT_MS/u);
    assert.match(source, /OPTIONAL_PROVIDER_STARTUP_TIMEOUT_MS/u);
    assert.match(
        source,
        /runDetachedSupervisedOperation\(\{ name: 'startup-telegram-connect'[\s\S]*?const telegramConnection = await attemptTelegramConnection/su,
    );
    assert.match(
        source,
        /void Promise\.resolve\(\)[\s\S]*?connection\.client\.updates\.start\(\)/su,
    );
    assert.match(source, /cancelPostEventFeedbackRequest\(/u);
});
