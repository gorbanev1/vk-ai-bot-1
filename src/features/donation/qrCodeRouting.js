import { normalizeLocalCommand } from '../../shared/commands.js';

const QR_RESPONSE_COMMANDS = new Set([
    'куаркод',
    'куар код',
    'qr',
    'qr код',
    'qr-code',
    'qr-код',
]);

const QR_REPLACE_COMMANDS = new Set([
    'заменить сообщение куаркод',
    'заменить сообщение куар код',
    'куаркод сообщение',
    'qr сообщение',
]);

export function parseQrCodeCommand(value) {
    const normalized = normalizeLocalCommand(value);

    if (QR_REPLACE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'replace',
            normalized,
            ownerOnly: true,
        };
    }

    if (QR_RESPONSE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'respond',
            normalized,
            ownerOnly: false,
        };
    }

    return {
        matched: false,
        action: 'none',
        normalized,
        ownerOnly: false,
    };
}
