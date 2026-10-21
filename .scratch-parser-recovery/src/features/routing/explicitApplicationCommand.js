/**
 * Shared explicit-command detector for platform adapters and the application.
 * It deliberately does not execute anything. Its only job is to answer
 * whether text is an application command that must escape a pending UI mode.
 */
import { resolveCommandPriority } from './commandPriorityRouting.js';
import { parseAutoSummaryCommand } from '../ai/autoSummaryRouting.js';
import { parseProcessControlCommand } from '../runtime/processControlRouting.js';
import { parseVkHistoryPullCommand } from '../history/vkHistoryPullPolicy.js';
import { parseChatHistoryLinkCommand } from '../history/chatHistoryLinkRouting.js';
import {
    parseLeaverCommand,
    parseParticipantDmBroadcastCommand,
} from '../membership/leaverCommandRouting.js';
import { parseQrCodeCommand } from '../donation/qrCodeRouting.js';
import { parseDocumentArtifactRequest } from '../documents/documentRouting.js';
import { parseEventModerationCommand } from '../events/eventModerationRouting.js';

function matched(value) {
    return Boolean(value?.matched ?? value);
}

function publicEventsDirect(value) {
    const text = String(value ?? '').trim();
    return /^(?:тусы?|тусовки|афиша|ближайш(?:ая|ие)\s+тус(?:а|ы)|что\s+по\s+тусам)(?=$|\s)/iu.test(text);
}

function eventProposal(value) {
    return /^(?:предложить|предложи)\s+(?:(?:информацию|инфу)\s+(?:о|об)\s+)?(?:тус(?:е|у|овке|овку)|мероприяти(?:и|е)|событи(?:и|е))(?=$|\s|:)/iu.test(
        String(value ?? '').trim(),
    );
}

function serviceEventsReport(value) {
    const text = String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[«»"'`]/gu, ' ')
        .replace(/[.,!?;:]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return /^(?:полный\s+)?(?:отч[её]т|список)(?:\s+по)?\s+служебн(?:ым|ых)/iu.test(text)
        || /^служебн(?:ые|ых)\s+(?:сообщения|события)/iu.test(text)
        || /^что\s+(?:происходило|было)\s+с\s+(?:участниками|конфой|беседой)/iu.test(text);
}

function requestStats(value) {
    return /^(?:гигорейв[\s,:-]*)?обращени(?:я|й|е)(?=$|\s)/iu.test(String(value ?? '').trim());
}

/**
 * Returns a stable family label when the input is an explicit local command.
 * `default` and semantic public-event guesses are intentionally not commands.
 */
export function detectExplicitApplicationCommand(value) {
    const text = String(value ?? '').trim();
    if (!text) return { matched: false, family: '', route: 'default' };

    const route = resolveCommandPriority(text);
    if (!['default', 'public-events-semantic'].includes(route.route)) {
        return { matched: true, family: `route:${route.route}`, route: route.route, parsed: route.selected };
    }

    const checks = [
        ['auto-summary', () => parseAutoSummaryCommand(text), matched],
        ['process-control', () => parseProcessControlCommand(text), matched],
        ['vk-history-pull', () => parseVkHistoryPullCommand(text), matched],
        ['chat-history-link', () => parseChatHistoryLinkCommand(text), matched],
        ['leavers', () => parseLeaverCommand(text), matched],
        ['participant-dm-broadcast', () => parseParticipantDmBroadcastCommand(text), matched],
        ['qr-code', () => parseQrCodeCommand(text), matched],
        ['document', () => parseDocumentArtifactRequest(text), matched],
        ['event-moderation', () => parseEventModerationCommand(text), Boolean],
        ['event-proposal', () => eventProposal(text), Boolean],
        ['service-events-report', () => serviceEventsReport(text), Boolean],
        ['bot-request-stats', () => requestStats(text), Boolean],
        ['public-events-direct', () => publicEventsDirect(text), Boolean],
    ];

    for (const [family, parse, isMatch] of checks) {
        const parsed = parse();
        if (isMatch(parsed)) {
            return { matched: true, family, route: route.route, parsed };
        }
    }

    return { matched: false, family: '', route: route.route, parsed: null };
}

export function isExplicitApplicationCommand(value) {
    return detectExplicitApplicationCommand(value).matched;
}
