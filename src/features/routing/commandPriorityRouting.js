/**
 * Единая чистая таблица приоритетов верхнеуровневых команд.
 *
 * Правила:
 * 1. Явные административные/локальные команды сильнее любых семантических
 *    классификаторов и ключей модели, которые для них неприменимы.
 * 2. Явные AI-действия (прашна, GPT, резюме, генерация/анализ изображения)
 *    сильнее семантической афиши и FAQ.
 * 3. Семантические классификаторы запускаются только когда не найдено ни
 *    одной явной команды.
 */
import {
    isHelpCommand,
    isPublicSourcesStatusCommand,
    isVersionCommand,
    isVkChatManualStopCommand,
    normalizeLocalCommand,
} from '../../shared/commands.js';
import { parseProviderCommand } from '../ai/providerDiagnostics.js';
import { extractExplicitGptMode } from '../ai/gptModeRouting.js';
import { buildVisionTaskDescriptor } from '../ai/visionRouting.js';
import { parseImageEditRequest } from '../ai/imageEditRouting.js';
import { classifyChatContextRequest } from '../ai/chatContextRouting.js';
import { getAstrologyRequestKind } from '../astrology/astrologyRouting.js';
import {
    isMemoryDatabaseScanCommand,
    parseForgetCommand,
    parseRememberCommand,
} from '../memory/memoryRouting.js';
import { parseActiveCommunicationCommand } from '../personality/activeCommunicationRouting.js';
import { parseCommunicationStyleCommand } from '../personality/communicationStyleRouting.js';
import { parseBotIdentityProvocation } from '../personality/botIdentityProvocationRouting.js';
import { parseFlatterCommand } from '../personality/flatterCommandRouting.js';
import { parseRoastCommand } from '../personality/roastCommandRouting.js';
import { parseScraperStartCommand } from '../scrapers/scraperCommandRouting.js';
import { parseCoordsOverrideCommand } from '../coords/coordsOverrideRouting.js';
import { parseQticketsCommand } from '../events/qticketsRouting.js';
import { parseAllPartiesRequest } from '../events/allPartyDedupe.js';

const IMAGE_GENERATION_PREFIX = /^(?:image|img|картин(?:ка|ку|ки|кой)?|изображени(?:е|я|ю|ем)?|нарисуй|рисуй|нарисовать|рисовать|сгенерируй\s+(?:картинку|изображение)|создай\s+(?:картинку|изображение)|сделай\s+(?:картинку|изображение))(?=$|\s)/iu;
const GPT_PREFIX = /^gpt(?:\s|$)/iu;
const DOSSIER_TOKEN = /(?<![\p{L}\p{N}_])(?:полное\s+)?досье(?![\p{L}\p{N}_])/iu;

export const COMMAND_ROUTE_PRIORITY = Object.freeze([
    'routing-audit',
    'routing-explain',
    'coords-override',
    'provider',
    'telegram-diagnostic',
    'qtickets-events',
    'all-parties',
    'scraper-start',
    'source-status',
    'vk-chat-stop',
    'gigachat',
    'active-communication',
    'bot-identity-provocation',
    'communication-style',
    'flatter',
    'roast',
    'manual-event',
    'memory-scan',
    'memory-forget',
    'memory-remember',
    'help',
    'version',
    'ping',
    'id',
    'stats',
    'dossier',
    'rate-limit-reset',
    'summary',
    'vision',
    'gpt-explicit-action',
    'public-events-direct',
    'gpt-explicit-selector',
    'public-events-semantic',
    'default',
]);

const MODEL_SELECTOR_AWARE_ROUTES = new Set([
    'summary',
    'vision',
    'gpt-explicit-action',
    'gpt-explicit-selector',
]);

export function parseExplicitGigaChatCommand(value) {
    const source = String(value ?? '').trim();
    const match = source.match(
        /^(?:гига\s*чат|гигачат|giga\s*chat|gigachat)(?=$|\s)/iu,
    );

    return match
        ? source.slice(match[0].length).trim()
        : null;
}

export function parseManualEventCommand(value) {
    const source = String(value ?? '').trim();
    const match = source.match(
        /^(?:добавить|добавь|внести|внеси|записать|запиши)\s+(?:информацию\s+(?:о|об)\s+)?(?:событи(?:е|я)|мероприяти(?:е|я)|тус(?:у|овку))(?=$|\s|:)/iu,
    );

    return match
        ? source.slice(match[0].length).replace(/^\s*:\s*/u, '').trim()
        : null;
}

export function isTelegramDiagnosticCommand(value) {
    return /^(?:телеграм|телега|telegram)\s+(?:проверить|проверка|диагностика|статус|check|status)$|^(?:проверить|диагностика)\s+(?:телеграм|телегу|telegram)$/iu.test(
        String(value ?? '').trim(),
    );
}

export function isSummaryRequest(value) {
    const text = String(value ?? '').trim();
    return (
        /^(?:сделай\s+|дай\s+)?резюм[\p{L}]*/iu.test(text) ||
        /^(?:подведи\s+)?итог[\p{L}]*/iu.test(text) ||
        /^(?:сделай\s+)?кратк[\p{L}]*\s+(?:итог|обзор)/iu.test(text)
    );
}

function parseRoutingControl(value) {
    const text = String(value ?? '').trim();
    if (/^(?:маршрутизац(?:ия|ию)|роутинг)\s+(?:проверить|проверка|тест|аудит)$/iu.test(text)) {
        return { route: 'routing-audit', body: '' };
    }

    const explain = text.match(/^(?:маршрут|роут|route)\s+([\s\S]+)$/iu);
    if (explain) {
        return { route: 'routing-explain', body: explain[1].trim() };
    }

    return null;
}

function isPingCommand(value) {
    const normalized = normalizeLocalCommand(value);
    return normalized === 'пинг' || normalized === 'ping';
}

function isIdCommand(value) {
    return ['id', 'айди', 'ид'].includes(normalizeLocalCommand(value));
}

function isStatsCommand(value) {
    const normalized = normalizeLocalCommand(value);
    return (
        ['статистика', 'статы', 'стат'].includes(normalized) ||
        normalized.startsWith('покажи статистику')
    );
}

export function parseDossierCommand(value) {
    const original = String(value ?? '').normalize('NFKC').trim();
    if (!original) {
        return { matched: false, fullMode: false, targetQuery: '', commandText: original };
    }

    const withoutBotName = original
        .replace(/(?<![\p{L}\p{N}_])(?:гигорейв|gigorave)(?![\p{L}\p{N}_])/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    const match = withoutBotName.match(DOSSIER_TOKEN);
    if (!match) {
        return { matched: false, fullMode: false, targetQuery: '', commandText: original };
    }

    const before = withoutBotName.slice(0, match.index).trim();
    const after = withoutBotName.slice(match.index + match[0].length).trim();
    let targetQuery = [before, after]
        .filter(Boolean)
        .join(' ')
        .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/gu, '')
        .replace(/^(?:на|про)\s+/iu, '')
        .replace(/\s+/gu, ' ')
        .trim();

    // “досье на Иван”, “Иван досье”, “Иван полное досье” — один маршрут.
    // Служебные вежливые хвосты не должны становиться частью имени цели.
    targetQuery = targetQuery
        .replace(/(?:\s+)?(?:пожалуйста|плиз|плз)$/iu, '')
        .trim();

    const fullMode = /^полное\s+досье$/iu.test(match[0].replace(/\s+/gu, ' ').trim());
    return {
        matched: true,
        fullMode,
        targetQuery,
        commandText: `${fullMode ? 'полное ' : ''}досье${targetQuery ? ` ${targetQuery}` : ''}`,
    };
}

function isDossierCommand(value) {
    return parseDossierCommand(value).matched;
}

function isRateLimitResetCommand(value) {
    const normalized = normalizeLocalCommand(value);
    return normalized === 'лимиты сбросить' || normalized === 'сбросить лимиты';
}

function isExplicitImageGeneration(value) {
    return IMAGE_GENERATION_PREFIX.test(String(value ?? '').trim());
}

function compactCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
        if (!candidate?.route || seen.has(candidate.route)) return false;
        seen.add(candidate.route);
        return true;
    });
}

/**
 * Возвращает выбранный маршрут и все совпавшие семейства для диагностики.
 */
export function resolveCommandPriority(value, options = {}) {
    const requestText = String(value ?? '').trim();
    const normalized = normalizeLocalCommand(requestText);
    const explicitMode = extractExplicitGptMode(requestText);
    const modeBody = explicitMode.body;
    const commandText = explicitMode.source === 'implicit'
        ? requestText
        : modeBody;
    const commandNormalized = normalizeLocalCommand(commandText);
    const candidates = [];
    const add = (route, reason, data = {}) => {
        candidates.push({
            route,
            reason,
            commandText,
            ...data,
        });
    };

    const routingControl = parseRoutingControl(commandText);
    if (routingControl) {
        add(routingControl.route, 'explicit-routing-control', {
            body: routingControl.body,
        });
    }

    const coordsOverride = parseCoordsOverrideCommand(commandText);
    if (coordsOverride.matched && coordsOverride.ownerOnly) {
        add('coords-override', 'explicit-owner-coords-control', {
            command: coordsOverride,
        });
    }

    /*
     * Provider model IDs can themselves contain words such as "pro".
     * Therefore a valid raw provider command wins. The model-stripped form is
     * used only when the raw form did not match or degraded into unknown
     * syntax because a GPT selector was written before/after the command.
     */
    const rawProvider = parseProviderCommand(requestText);
    const adjustedProvider = commandText === requestText
        ? rawProvider
        : parseProviderCommand(commandText);
    const provider = rawProvider.matched && rawProvider.action !== 'direct_unknown'
        ? { parsed: rawProvider, input: requestText }
        : adjustedProvider.matched
            ? { parsed: adjustedProvider, input: commandText }
            : rawProvider.matched
                ? { parsed: rawProvider, input: requestText }
                : null;
    if (provider) {
        add('provider', 'explicit-provider-namespace', {
            command: provider.parsed,
            commandText: provider.input,
        });
    }

    if (isTelegramDiagnosticCommand(commandText)) {
        add('telegram-diagnostic', 'explicit-telegram-diagnostic');
    }

    const scraper = parseScraperStartCommand(commandText);
    if (scraper.matched) {
        add('scraper-start', 'explicit-scraper-command', { command: scraper });
    }

    const qtickets = parseQticketsCommand(commandText);
    if (qtickets.matched) {
        add('qtickets-events', 'explicit-qtickets-command', { command: qtickets });
    }

    const allParties = parseAllPartiesRequest(commandText);
    if (allParties.matched) {
        add('all-parties', 'explicit-all-parties-command', { command: allParties });
    }

    if (isPublicSourcesStatusCommand(commandText)) {
        add('source-status', 'explicit-source-status');
    }
    if (isVkChatManualStopCommand(commandText)) {
        add('vk-chat-stop', 'explicit-vk-chat-stop');
    }

    const gigaChatBody = parseExplicitGigaChatCommand(commandText);
    if (gigaChatBody !== null) {
        add('gigachat', 'explicit-gigachat-namespace', { body: gigaChatBody });
    }

    const activeCommunication = parseActiveCommunicationCommand(commandText);
    if (activeCommunication.matched) {
        add('active-communication', 'explicit-active-communication', {
            command: activeCommunication,
        });
    }

    const botIdentity = parseBotIdentityProvocation(commandText);
    if (botIdentity.matched) {
        add('bot-identity-provocation', botIdentity.reason, {
            command: botIdentity,
        });
    }

    const communicationStyle = parseCommunicationStyleCommand(
        commandText
            .replace(/\bдурачиной\b/giu, 'дурачилой')
            .replace(/\bдурачина\b/giu, 'дурачила'),
    );
    if (communicationStyle.matched) {
        add('communication-style', 'explicit-style-command', {
            command: communicationStyle,
        });
    }

    const flatter = parseFlatterCommand(commandText);
    if (flatter.matched) {
        add('flatter', 'explicit-flatter-command', { command: flatter });
    }

    const roast = parseRoastCommand(commandText);
    if (roast.matched) {
        add('roast', 'explicit-roast-command', { command: roast });
    }

    const manualEventBody = parseManualEventCommand(commandText);
    if (manualEventBody !== null) {
        add('manual-event', 'explicit-manual-event', { body: manualEventBody });
    }

    if (isMemoryDatabaseScanCommand(commandText)) {
        add('memory-scan', 'explicit-memory-scan');
    }

    const forget = parseForgetCommand(commandText);
    if (forget.matched) {
        add('memory-forget', 'explicit-memory-forget', { command: forget });
    }

    const remember = parseRememberCommand(commandText);
    if (remember.matched) {
        add('memory-remember', 'explicit-memory-remember', { command: remember });
    }

    if (isHelpCommand(commandText)) add('help', 'exact-local-help');
    if (isVersionCommand(commandText)) add('version', 'exact-local-version');
    if (isPingCommand(commandText)) add('ping', 'exact-local-ping');
    if (isIdCommand(commandText)) add('id', 'exact-local-id');
    if (isStatsCommand(commandText)) add('stats', 'explicit-local-stats');
    const dossier = parseDossierCommand(commandText);
    if (dossier.matched) {
        add('dossier', 'explicit-local-dossier', {
            commandText: dossier.commandText,
            dossier,
        });
    }
    if (isRateLimitResetCommand(commandText)) {
        add('rate-limit-reset', 'explicit-rate-limit-reset');
    }

    if (isSummaryRequest(modeBody)) {
        add('summary', 'explicit-summary-action', { explicitMode });
    }

    const visionTask = buildVisionTaskDescriptor(modeBody);
    if (visionTask.matched) {
        add('vision', 'explicit-vision-action', {
            explicitMode,
            visionTask,
        });
    }

    const imageEdit = parseImageEditRequest(modeBody);
    const astrologyKind = getAstrologyRequestKind(modeBody);
    const chatContext = astrologyKind === 'none'
        ? classifyChatContextRequest(modeBody)
        : { usesChatDatabase: false, wantsImage: false };
    const explicitGptPrefix = GPT_PREFIX.test(commandNormalized);
    const explicitImageGeneration = isExplicitImageGeneration(modeBody);

    if (
        explicitGptPrefix ||
        astrologyKind !== 'none' ||
        explicitImageGeneration ||
        imageEdit.matched ||
        chatContext.usesChatDatabase
    ) {
        add(
            'gpt-explicit-action',
            explicitGptPrefix ? 'explicit-gpt-prefix'
                : astrologyKind !== 'none' ? `explicit-astrology-${astrologyKind}`
                    : explicitImageGeneration ? 'explicit-image-generation'
                        : imageEdit.matched ? 'explicit-image-edit'
                            : 'explicit-chat-context',
            {
                explicitMode,
                astrologyKind,
                imageEdit,
                chatContext,
            },
        );
    }

    const directPublicEventsRange = typeof options.parsePublicEventsRangeCommand === 'function'
        ? options.parsePublicEventsRangeCommand(commandText)
        : null;
    if (directPublicEventsRange) {
        add('public-events-direct', 'deterministic-public-event-range', {
            range: directPublicEventsRange,
        });
    }

    if (explicitMode.source !== 'implicit') {
        add('gpt-explicit-selector', 'explicit-model-selector', {
            explicitMode,
            commandText: requestText,
        });
    }

    if (
        typeof options.looksLikePublicEventsQuestion === 'function' &&
        options.looksLikePublicEventsQuestion(commandText)
    ) {
        add('public-events-semantic', 'semantic-public-events-classifier');
    }

    const uniqueCandidates = compactCandidates(candidates);
    const priorityIndex = new Map(
        COMMAND_ROUTE_PRIORITY.map((route, index) => [route, index]),
    );
    uniqueCandidates.sort((left, right) => (
        (priorityIndex.get(left.route) ?? Number.MAX_SAFE_INTEGER) -
        (priorityIndex.get(right.route) ?? Number.MAX_SAFE_INTEGER)
    ));

    const selected = uniqueCandidates[0] ?? {
        route: 'default',
        reason: 'no-explicit-command',
        commandText,
    };
    const modelSelectorPresent = explicitMode.source !== 'implicit';
    const modelSelectorApplicable = modelSelectorPresent &&
        MODEL_SELECTOR_AWARE_ROUTES.has(selected.route);
    const modelSelectorDisposition = !modelSelectorPresent
        ? 'absent'
        : modelSelectorApplicable
            ? 'applied'
            : 'not-applicable';

    if (modelSelectorDisposition === 'not-applicable') {
        selected.suppressedExplicitMode = explicitMode.mode;
    }

    return {
        requestText,
        commandText,
        normalized,
        route: selected.route,
        reason: selected.reason,
        selected,
        candidates: uniqueCandidates,
        explicitMode,
        modelSelector: {
            present: modelSelectorPresent,
            mode: explicitMode.mode,
            token: explicitMode.token,
            applicable: modelSelectorApplicable,
            disposition: modelSelectorDisposition,
        },
        suppressedRoutes: uniqueCandidates
            .slice(1)
            .map((candidate) => candidate.route),
    };
}


/**
 * Проверяет несколько вариантов ОДНОГО явно адресованного предложения и
 * выбирает самый приоритетный детерминированный маршрут. Это позволяет
 * команде стоять до/после «Гигорейв» или в отдельной пунктуационной клаузе,
 * не распространяя обращение на соседнее предложение.
 */
export function resolveCommandPriorityCandidates(values, options = {}) {
    const candidates = [...new Set(
        (Array.isArray(values) ? values : [values])
            .map((value) => String(value ?? '').trim())
            .filter(Boolean),
    )];

    if (!candidates.length) {
        return resolveCommandPriority('', options);
    }

    const priorityIndex = new Map(
        COMMAND_ROUTE_PRIORITY.map((route, index) => [route, index]),
    );
    let selected = null;

    candidates.forEach((candidate, candidateIndex) => {
        const decision = resolveCommandPriority(candidate, options);
        if (decision.route === 'default') return;

        const score = priorityIndex.get(decision.route) ?? Number.MAX_SAFE_INTEGER;
        const selectedScore = selected
            ? priorityIndex.get(selected.route) ?? Number.MAX_SAFE_INTEGER
            : Number.MAX_SAFE_INTEGER;

        if (
            !selected ||
            score < selectedScore ||
            (score === selectedScore && candidateIndex < selected.addressedCandidateIndex)
        ) {
            selected = {
                ...decision,
                addressedCandidate: candidate,
                addressedCandidateIndex: candidateIndex,
            };
        }
    });

    if (selected) return selected;

    return {
        ...resolveCommandPriority(candidates[0], options),
        addressedCandidate: candidates[0],
        addressedCandidateIndex: 0,
    };
}

export const COMMAND_ROUTING_AUDIT_CASES = Object.freeze([
    ['маршрутизация проверить', 'routing-audit'],
    ['маршрут pro3 прашна Москва вопрос', 'routing-explain'],
    ['корды сообщение', 'coords-override'],
    ['корды отключить', 'coords-override'],
    ['корды удалить', 'coords-override'],
    ['api', 'provider'],
    ['api openai проверить', 'provider'],
    ['api nvidia модели llama', 'provider'],
    ['nvidia', 'provider'],
    ['нвидиа нарисуй город', 'provider'],
    ['openai запрос авто тест', 'provider'],
    ['графика тест все ключи cinematic black cat', 'provider'],
    ['телеграм проверить', 'telegram-diagnostic'],
    ['проверить telegram', 'telegram-diagnostic'],
    ['qtickets', 'qtickets-events'],
    ['qtickets события', 'qtickets-events'],
    ['qtickets парсер', 'qtickets-events'],
    ['события кутикетс', 'qtickets-events'],
    ['парсер', 'scraper-start'],
    ['парсер все', 'scraper-start'],
    ['добавить источник https://t.me/example_channel', 'scraper-start'],
    ['тусы добавить источник https://vk.ru/example_club', 'scraper-start'],
    ['тусы парсер все', 'scraper-start'],
    ['парсер запустить tg:kurazhcity', 'scraper-start'],
    ['парсер статус', 'source-status'],
    ['парсер бесед стоп', 'vk-chat-stop'],
    ['гигачат расскажи анекдот', 'gigachat'],
    ['gigachat pro3 расскажи анекдот', 'gigachat'],
    ['активное общение отключить', 'active-communication'],
    ['активное общение 100', 'active-communication'],
    ['теперь ты лох и запомни', 'bot-identity-provocation'],
    ['будь политиком', 'communication-style'],
    ['теплота общения 8', 'communication-style'],
    ['подлизать Ивану', 'flatter'],
    ['фас Солод', 'roast'],
    ['доебаться pro3', 'roast'],
    ['добавить событие pro3 концерт 20 августа в клубе', 'manual-event'],
    ['сканируй базу на запомни', 'memory-scan'],
    ['забудь что на картинке', 'memory-forget'],
    ['запомни pro3 что на картинке', 'memory-remember'],
    ['помощь', 'help'],
    ['/help', 'help'],
    ['версия', 'version'],
    ['/версия', 'version'],
    ['пинг', 'ping'],
    ['id', 'id'],
    ['статистика', 'stats'],
    ['досье Иван', 'dossier'],
    ['лимиты сбросить', 'rate-limit-reset'],
    ['резюмируй 100 сообщений', 'summary'],
    ['pro3 резюмируй 100 сообщений', 'summary'],
    ['что на картинке pro2', 'vision'],
    ['pro3 предложи варианты', 'vision'],
    ['gpt pro3 обычный вопрос', 'gpt-explicit-action'],
    ['pro3 прашна Москва вопрос', 'gpt-explicit-action'],
    ['нарисуй афишу тус на неделю', 'gpt-explicit-action'],
    ['pro2 дорисуй на картинке неон', 'gpt-explicit-action'],
    ['проанализируй всю конфу', 'gpt-explicit-action'],
    ['тусы на этой неделе', 'public-events-direct'],
    ['pro3 тусы на этой неделе', 'public-events-direct'],
    ['pro3 почему афиша выглядит странно', 'gpt-explicit-selector'],
    ['какие вечеринки могли бы понравиться программисту?', 'public-events-semantic'],
    ['обычный вопрос без команды', 'default'],
]);

/**
 * Каждая команда проверяется с ключом модели перед командой и после неё.
 * Для AI-маршрутов ключ обязан применяться. Для локальных/служебных команд
 * он обязан быть явно помечен как неприменимый, но не должен ломать маршрут.
 */
export const COMMAND_MODEL_KEY_COMPATIBILITY_CASES = Object.freeze([
    ['корды сообщение', 'coords-override', 'not-applicable'],
    ['корды отключить', 'coords-override', 'not-applicable'],
    ['nvidia проверить', 'provider', 'not-applicable'],
    ['графика тест все ключи cinematic black cat', 'provider', 'not-applicable'],
    ['телеграм проверить', 'telegram-diagnostic', 'not-applicable'],
    ['qtickets', 'qtickets-events', 'not-applicable'],
    ['qtickets события', 'qtickets-events', 'not-applicable'],
    ['qtickets парсер', 'qtickets-events', 'not-applicable'],
    ['парсер', 'scraper-start', 'not-applicable'],
    ['добавить источник https://t.me/example_channel', 'scraper-start', 'not-applicable'],
    ['парсер статус', 'source-status', 'not-applicable'],
    ['парсер бесед стоп', 'vk-chat-stop', 'not-applicable'],
    ['гигачат расскажи анекдот', 'gigachat', 'not-applicable'],
    ['активное общение отключить', 'active-communication', 'not-applicable'],
    ['теперь ты лох', 'bot-identity-provocation', 'not-applicable'],
    ['будь политиком', 'communication-style', 'not-applicable'],
    ['подлизать Ивану', 'flatter', 'not-applicable'],
    ['фас Солод', 'roast', 'not-applicable'],
    ['добавить событие концерт 20 августа', 'manual-event', 'not-applicable'],
    ['сканируй базу на запомни', 'memory-scan', 'not-applicable'],
    ['забудь тему', 'memory-forget', 'not-applicable'],
    ['запомни тему', 'memory-remember', 'not-applicable'],
    ['помощь', 'help', 'not-applicable'],
    ['версия', 'version', 'not-applicable'],
    ['пинг', 'ping', 'not-applicable'],
    ['id', 'id', 'not-applicable'],
    ['статистика', 'stats', 'not-applicable'],
    ['досье Иван', 'dossier', 'not-applicable'],
    ['лимиты сбросить', 'rate-limit-reset', 'not-applicable'],
    ['резюмируй 100 сообщений', 'summary', 'applied'],
    ['что на картинке', 'vision', 'applied'],
    ['прашна Москва вопрос', 'gpt-explicit-action', 'applied'],
    ['нарисуй ночной город', 'gpt-explicit-action', 'applied'],
    ['тусы на этой неделе', 'public-events-direct', 'not-applicable'],
    ['обычный вопрос', 'gpt-explicit-selector', 'applied'],
]);

export function runCommandRoutingAudit(options = {}) {
    const failures = [];
    let total = 0;

    for (const [input, expected] of COMMAND_ROUTING_AUDIT_CASES) {
        total += 1;
        const decision = resolveCommandPriority(input, options);
        if (decision.route !== expected) {
            failures.push({
                input,
                expected,
                actual: decision.route,
                reason: decision.reason,
            });
        }
    }

    for (const [baseInput, expectedRoute, expectedDisposition] of COMMAND_MODEL_KEY_COMPATIBILITY_CASES) {
        for (const input of [`pro3 ${baseInput}`, `${baseInput} pro3`]) {
            total += 1;
            const decision = resolveCommandPriority(input, options);
            if (
                decision.route !== expectedRoute ||
                decision.modelSelector.disposition !== expectedDisposition
            ) {
                failures.push({
                    input,
                    expected: `${expectedRoute}/${expectedDisposition}`,
                    actual: `${decision.route}/${decision.modelSelector.disposition}`,
                    reason: decision.reason,
                });
            }
        }
    }

    return {
        total,
        passed: total - failures.length,
        failures,
    };
}

export function formatCommandRouteDecision(decision) {
    const candidates = decision.candidates.length
        ? decision.candidates.map((candidate) => candidate.route).join(' > ')
        : 'default';
    const modelKey = decision.explicitMode.source === 'implicit'
        ? 'не задан'
        : `${decision.explicitMode.mode} (${decision.explicitMode.token})`;
    const modelPolicy = decision.modelSelector.disposition === 'applied'
        ? 'применяется к AI-вызову'
        : decision.modelSelector.disposition === 'not-applicable'
            ? `не применим к локальной команде ${decision.route}; маршрут команды сохранён`
            : 'не задан';

    return [
        `Маршрут: ${decision.route}`,
        `Причина: ${decision.reason}`,
        `Текст после удаления ключа модели: ${decision.commandText || '—'}`,
        `Кандидаты по приоритету: ${candidates}`,
        `Ключ модели: ${modelKey}`,
        `Политика ключа: ${modelPolicy}`,
    ].join('\n');
}
