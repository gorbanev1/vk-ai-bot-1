import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    createBotMentionTools,
} from '../../src/shared/commands.js';
import {
    COMMAND_ROUTING_AUDIT_CASES,
    resolveCommandPriorityCandidates,
} from '../../src/features/routing/commandPriorityRouting.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';
import { parseAutoSummaryCommand } from '../../src/features/ai/autoSummaryRouting.js';
import { parseVkHistoryPullCommand } from '../../src/features/history/vkHistoryPullPolicy.js';
import { parseChatHistoryLinkCommand } from '../../src/features/history/chatHistoryLinkRouting.js';
import {
    parseLeaverCommand,
    parseParticipantDmBroadcastCommand,
} from '../../src/features/membership/leaverCommandRouting.js';
import { parseQrCodeCommand } from '../../src/features/donation/qrCodeRouting.js';
import { parseCoordsOverrideCommand } from '../../src/features/coords/coordsOverrideRouting.js';
import {
    isExplicitTelegramNonImageCommand,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

const rangeService = createPublicEventRangeService({
    timeZone: 'Europe/Moscow',
    now: () => new Date('2026-09-12T12:00:00.000Z'),
});
const routeOptions = {
    parsePublicEventsRangeCommand: rangeService.parsePublicEventsRangeCommand,
    looksLikePublicEventsQuestion: rangeService.looksLikePublicEventsQuestion,
};
const tools = createBotMentionTools({
    groupId: '233007447',
    groupIds: ['240709021'],
    getTelegramBotUsername: () => 'Gigorave_bot',
});

function candidates(value) {
    return tools.getBotAddressedCommandCandidates(value);
}

function routeAddressed(value) {
    return resolveCommandPriorityCandidates(candidates(value), routeOptions);
}

function parseAddressed(value, parser, matcher = (parsed) => Boolean(parsed?.matched ?? parsed)) {
    for (const candidate of candidates(value)) {
        const parsed = parser(candidate);
        if (matcher(parsed)) return { candidate, parsed };
    }
    return null;
}

test('every built-in central route survives Gigorave before or after command in one sentence', () => {
    for (const [base, expected] of COMMAND_ROUTING_AUDIT_CASES) {
        for (const wrapped of [
            `Гигорейв, ${base}`,
            `${base}, Гигорейв`,
            `слушай, Гигорейв, пожалуйста, ${base}`,
        ]) {
            assert.equal(routeAddressed(wrapped).route, expected, wrapped);
        }
    }
});

test('address marker may touch command without comma and command may be on either side', () => {
    assert.equal(routeAddressed('помощь Гигорейв привет').route, 'help');
    assert.equal(routeAddressed('скажи Гигорейв версия').route, 'version');
    assert.equal(routeAddressed('Гигорейв pro3 резюмируй 500 сообщений').route, 'summary');
    assert.equal(routeAddressed('досье Иван Гигорейв').route, 'dossier');
});

test('bot addressing never leaks into adjacent sentence', () => {
    assert.equal(routeAddressed('Гигорейв, привет. помощь').route, 'default');
    assert.equal(routeAddressed('помощь. Гигорейв, привет').route, 'default');
    assert.equal(routeAddressed('Гигорейв. версия').route, 'default');
    assert.deepEqual(candidates('Гигорейв. помощь'), []);
});

test('normal prose does not become a local command because it contains command word', () => {
    assert.equal(
        routeAddressed('Гигорейв, расскажи, что означает слово помощь').route,
        'default',
    );
    assert.equal(
        routeAddressed('Гигорейв расскажи что значит версия приложения').route,
        'default',
    );
});

test('VK mentions and Telegram username use the same same-sentence router', () => {
    assert.equal(routeAddressed('[club233007447|Гигорейв], помощь').route, 'help');
    assert.equal(routeAddressed('версия, [club240709021|Пересоздание]').route, 'version');
    assert.equal(routeAddressed('@Gigorave_bot, пинг').route, 'ping');
    assert.equal(routeAddressed('id @Gigorave_bot').route, 'id');
});

test('special fast-path command families accept command before/after bot name', () => {
    const matrix = [
        [parseAutoSummaryCommand, 'резюмирование статус', (p) => p?.matched && p.action === 'status'],
        [parseVkHistoryPullCommand, 'подтяни историю 2 дня', (p) => p?.matched && p.valid],
        [parseChatHistoryLinkCommand, 'привязать старую историю peer 2000000001', (p) => p?.matched],
        [parseLeaverCommand, 'кто вышел за 7 дней', (p) => p?.matched],
        [parseParticipantDmBroadcastCommand, 'лс участникам всем привет', (p) => p?.matched && p.message === 'всем привет'],
        [parseQrCodeCommand, 'куаркод', (p) => p?.matched],
        [parseCoordsOverrideCommand, 'корды', (p) => p?.matched],
    ];

    for (const [parser, command, matcher] of matrix) {
        for (const wrapped of [`Гигорейв, ${command}`, `${command}, Гигорейв`]) {
            const result = parseAddressed(wrapped, parser, matcher);
            assert.ok(result, wrapped);
        }
    }
});

test('payload command remains intact when Gigorave is inside the same sentence', () => {
    const broadcast = parseAddressed(
        'лс участникам Гигорейв всем привет',
        parseParticipantDmBroadcastCommand,
        (p) => p?.matched,
    );
    assert.ok(broadcast);
    assert.equal(broadcast.parsed.message, 'всем привет');
});

test('Telegram pending menu yields to addressed command regardless of name position', () => {
    for (const text of [
        'помощь, Гигорейв',
        'Гигорейв, помощь',
        'резюмирование статус, Гигорейв',
        'версия @Gigorave_bot',
    ]) {
        assert.equal(
            isExplicitTelegramNonImageCommand(text, { botUsername: 'Gigorave_bot' }),
            true,
            text,
        );
        const result = resolveTelegramMenuInput(
            text,
            { pendingAction: 'image', pendingModel: 'pro2' },
            { botUsername: 'Gigorave_bot' },
        );
        assert.equal(result.type, 'command', text);
        assert.equal(result.text, text, text);
    }

    assert.equal(
        isExplicitTelegramNonImageCommand('Гигорейв. помощь', { botUsername: 'Gigorave_bot' }),
        false,
    );
});

test('application wires sentence-scoped candidates into all six normal handleRequest entries and fast paths', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    const calls = source.match(/await handleRequest\(context,[\s\S]{0,500}?commandCandidates:/gu) || [];
    assert.equal(calls.length, 6, `expected 6 candidate-aware handleRequest calls, got ${calls.length}`);
    assert.match(source, /parseIncomingCommand\(\s*requestText,\s*parseVkHistoryPullCommand/su);
    assert.match(source, /parseIncomingCommand\(\s*requestText,\s*parseChatHistoryLinkCommand/su);
    assert.match(source, /parseIncomingCommand\(\s*requestText,\s*parseLeaverCommand/su);
    assert.match(source, /parseIncomingCommand\(\s*requestText,\s*parseParticipantDmBroadcastCommand/su);
    assert.match(source, /const explicitCommandScope = Array\.isArray\(commandCandidates\)/u);
    assert.match(source, /detectExplicitIncomingCommand/u);
});
