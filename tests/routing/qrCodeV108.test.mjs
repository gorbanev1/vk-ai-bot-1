import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { parseQrCodeCommand } from '../../src/features/donation/qrCodeRouting.js';
import {
    getQrCodeSettings,
    updateQrCodeSettings,
} from '../../src/infrastructure/database/index.js';

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const databaseSource = readFileSync(
    new URL('../../src/infrastructure/database/index.js', import.meta.url),
    'utf8',
);
const telegramSource = readFileSync(
    new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url),
    'utf8',
);

test('V108 QR public and owner commands are deterministic', () => {
    for (const value of ['куаркод', 'куар код', 'qr', 'qr код', 'qr-код']) {
        const parsed = parseQrCodeCommand(value);
        assert.equal(parsed.action, 'respond', value);
        assert.equal(parsed.ownerOnly, false, value);
    }

    const replace = parseQrCodeCommand('заменить сообщение куаркод');
    assert.equal(replace.action, 'replace');
    assert.equal(replace.ownerOnly, true);
    assert.equal(parseQrCodeCommand('покажи мне куаркод').matched, false);
});

test('V108 QR settings preserve image when only text changes and preserve text when only image changes', () => {
    const original = getQrCodeSettings();

    try {
        updateQrCodeSettings({
            messageText: 'старый текст',
            imagePath: 'data/qr-code/old.png',
            updatedBy: 1,
            updatedAt: 100,
        });
        const textOnly = updateQrCodeSettings({
            messageText: 'новый текст',
            imagePath: null,
            updatedBy: 1,
            updatedAt: 200,
        });
        assert.equal(textOnly.messageText, 'новый текст');
        assert.equal(textOnly.imagePath, 'data/qr-code/old.png');

        const imageOnly = updateQrCodeSettings({
            messageText: null,
            imagePath: 'data/qr-code/new.png',
            updatedBy: 1,
            updatedAt: 300,
        });
        assert.equal(imageOnly.messageText, 'новый текст');
        assert.equal(imageOnly.imagePath, 'data/qr-code/new.png');
    } finally {
        updateQrCodeSettings({
            messageText: original.messageText,
            imagePath: original.imagePath,
            updatedBy: original.updatedBy,
            updatedAt: original.updatedAt,
        });
    }
});

test('V108 seeds requested Sber caption and stores QR path separately', () => {
    assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS qr_code_settings/u);
    assert.match(databaseSource, /89968257889 Сбер Игорь Анатольевич\./u);
    assert.match(databaseSource, /image_path TEXT NOT NULL DEFAULT ''/u);
    assert.match(databaseSource, /COALESCE\(\?, image_path\)/u);
});

test('V108 sends QR image and text in one platform-native message and supports image-only Telegram update', () => {
    assert.match(applicationSource, /events-v\d+-[a-z0-9-]+/u);
    assert.match(applicationSource, /maybeHandleQrCodeIncoming\(context, text\)/u);
    assert.match(applicationSource, /singleMediaMessage: true/u);
    assert.match(applicationSource, /createTelegramPhotoAttachment/u);
    assert.match(applicationSource, /vk\.upload\.messagePhoto/u);
    assert.match(applicationSource, /Сообщение QR-кода обновлено\. Картинка оставлена прежней\./u);
    assert.match(applicationSource, /Сообщение и QR-картинка обновлены\./u);
    assert.match(telegramSource, /const hasImageAttachment = Boolean/u);
    assert.match(telegramSource, /context\.text \|\| hasImageAttachment/u);
    assert.match(telegramSource, /заменить\\s\+сообщение/u);
});
