import { parseBulkSourceAddCommand } from './bulkSourceAddCommand.js';
/**
 * Разбирает административные команды ручного запуска конкретного скрейпера.
 */
function normalizeCommand(value) {
    return String(value ?? '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .trim()
        .replace(/^[/\\]+/u, '')
        .replace(/[?!.,;]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .replace(/^(?:гигорейв|gigorave)(?:[,:]\s*|\s+)/u, '')
        .trim();
}

const HELP_COMMANDS = new Set([
    'парсер',
    'парсеры',
    'скрейпер',
    'скрейперы',
    'scraper',
    'scrapers',
]);

const CLEAN_ALL_COMMANDS = new Set([
    'парсер все чисто',
    'парсер всё чисто',
    'парсеры все чисто',
    'парсеры всё чисто',
    'скрейпер все чисто',
    'скрейпер всё чисто',
    'scraper all clean',
    'scrapers all clean',
    // Explicit name for the incremental mode.  `парсер все` is the full
    // reparse; `парсер все новые` is the ledger/hash filtered pass.
    'парсер все новые',
    'парсер всё новые',
    'парсеры все новые',
    'парсеры всё новые',
    'скрейпер все новые',
    'скрейпер всё новые',
    'скрейперы все новые',
    'скрейперы всё новые',
    'scraper all new',
    'scrapers all new',
]);

// Resume the latest interrupted parser-all run from its durable checkpoint.
// This is intentionally a separate command so a normal full/incremental run
// can never accidentally consume an old checkpoint.
const RECOVER_ALL_COMMANDS = new Set([
    'парсер все восстановить',
    'парсер всё восстановить',
    'парсеры все восстановить',
    'парсеры всё восстановить',
    'скрейпер все восстановить',
    'скрейпер всё восстановить',
    'тусы парсер все восстановить',
    'тусы парсер всё восстановить',
    'scraper all resume',
    'scrapers all resume',
]);

const ALL_COMMANDS = new Set([
    'парсер все',
    'парсер всё',
    'парсеры все',
    'парсеры всё',
    'скрейпер все',
    'скрейпер всё',
    'скрейперы все',
    'скрейперы всё',
    'scraper all',
    'scrapers all',
    'парсер запустить все',
    'парсер запустить всё',
    'парсеры запустить все',
    'парсеры запустить всё',
    'скрейпер запустить все',
    'скрейпер запустить всё',
    'запустить все парсеры',
    'запустить все скрейперы',
    'run all scrapers',
]);

const LEGACY_START_COMMANDS = new Set([
    'парсер сейчас',
    'парсеры сейчас',
    'источники обновить',
    'тг парсер сейчас',
    'вк парсер сейчас',
    'telegram parser run',
    'vk parser run',
    'парсер бесед запустить',
    'парсер бесед сейчас',
    'парсер чатов запустить',
    'парсер чатов сейчас',
    'беседы открыть',
    'чаты открыть',
    'сканировать беседы',
    'сканировать чаты',
    'vk chat parser start',
]);

/**
 * Parses only manual scraper commands.
 *
 * Canonical syntax:
 *   парсер
 *   парсер все
 *   парсер <source-id>
 *   парсер запустить <source-id>
 */
function parseScraperStartCommandInternal(input) {
    const bulkSourceCommand = parseBulkSourceAddCommand(input);
    if (bulkSourceCommand) {
        return {
            matched: true, sourceId: '', legacy: false, all: false, help: false,
            addSourcesBulk: true,
            partyPool: bulkSourceCommand.partyPool,
            bulkSources: bulkSourceCommand.sources,
            bulkInvalid: bulkSourceCommand.invalid,
            bulkDuplicates: bulkSourceCommand.duplicates,
        };
    }

    let command = normalizeCommand(input)
        .replace(/^(?:гигорейв|gigorave)\s+/u, '')
        .trim();
    if (['обработать ошибки парсера', 'обработать ошибку парсера', 'повторить ошибки парсера'].includes(command)) {
        return { matched: true, parserErrors: true, sourceId: '', legacy: false, all: false, help: false };
    }
    if (['попытаться исправить ошибки', 'перепарсить нескачанное'].includes(command)) {
        return { matched: true, parserErrors: true, missingCapture: command === 'перепарсить нескачанное', sourceId: '', legacy: false, all: false, help: false };
    }
    // Turbo is an orthogonal modifier; strip it before the established
    // command grammar so all primary/secondary/clean aliases continue to
    // resolve exactly as before. The public wrapper restores the mode.
    // Modifiers are orthogonal to the command grammar.  Strip them wherever
    // they occur, so ``парсер все быдлячьи новые 2фазы турбо3`` and
    // ``турбо3 2фазы новые быдлячьи парсер все`` resolve identically.
    const phaseMatches = [...command.matchAll(/(?:^|\s)(?:(?:фаз(?:а|ы)|phase)\s*[:=]?\s*([12])|([12])\s*фаз(?:а|ы))(?=\s|$)/giu)];
    const phaseCount = phaseMatches.length ? Number(phaseMatches.at(-1)[1] || phaseMatches.at(-1)[2]) : 2;
    command = command
        .replace(/(?:^|\s)(?:турбо(?:[1-4])?|turbo(?:[1-4])?)(?=\s|$)/giu, ' ')
        .replace(/(?:^|\s)(?:(?:фаз(?:а|ы)|phase)\s*[:=]?\s*[12]|[12]\s*фаз(?:а|ы))(?=\s|$)/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();

    // The pool, run mode and phase are independent tokens.  Handle the
    // order-insensitive forms before the legacy positional regexes below.
    const commandTokens = command.split(/\s+/u).filter(Boolean);
    const parserToken = /^(?:парсер|парсеры|скрейпер|скрейперы|scraper|scrapers)$/iu;
    const secondaryToken = /^(?:быдлячьи|второстепенные)$/iu;
    const allToken = /^(?:все|всё|all)$/iu;
    const cleanToken = /^(?:новые|new|чисто|clean)$/iu;
    const recoverToken = /^(?:восстановить|resume)$/iu;
    const hasParser = commandTokens.some(token => parserToken.test(token));
    const hasSecondary = commandTokens.some(token => secondaryToken.test(token));
    if (hasParser && hasSecondary) {
        const rest = commandTokens.filter(token =>
            !parserToken.test(token) && !secondaryToken.test(token) && !/^тус(?:а|ы)$/iu.test(token),
        );
        const recover = rest.some(token => recoverToken.test(token));
        const cleanOnly = rest.some(token => cleanToken.test(token));
        const all = rest.some(token => allToken.test(token)) || cleanOnly || recover || !rest.length;
        const sourceId = rest.filter(token => !allToken.test(token) && !cleanToken.test(token) && !recoverToken.test(token)).join(' ').trim();
        return {
            matched: true,
            sourceId: all ? '' : sourceId,
            legacy: false,
            all,
            cleanOnly: cleanOnly || recover,
            recover,
            help: false,
            partyPool: 'secondary',
            phaseCount,
        };
    }
    if (hasParser) {
        const rest = commandTokens.filter(token =>
            !parserToken.test(token) && !/^тус(?:а|ы)$/iu.test(token),
        );
        const recover = rest.some(token => recoverToken.test(token));
        const cleanOnly = rest.some(token => cleanToken.test(token));
        const all = rest.some(token => allToken.test(token)) || cleanOnly || recover;
        // Only claim a primary run when an explicit run target/mode is
        // present.  This keeps ``парсер статус`` and source-management
        // commands available to their established handlers.
        if (all) {
            const sourceId = rest
                .filter(token => !allToken.test(token) && !cleanToken.test(token) && !recoverToken.test(token))
                .join(' ')
                .trim();
            return {
                matched: true,
                sourceId: '',
                legacy: false,
                all: true,
                cleanOnly: cleanOnly || recover,
                recover,
                help: false,
                partyPool: 'primary',
                phaseCount,
                ...(sourceId ? { requestedSourceHint: sourceId } : {}),
            };
        }
    }

    const sourceListMatch = command.match(/^(?:(?:источник(?:и|ов)?(?:\s+(все|второстепенные|быдлячьи))?)|(?:(второстепенные|быдлячьи)\s+источники))$/u);
    if (sourceListMatch) {
        const qualifier = String(sourceListMatch[1] || sourceListMatch[2] || '').trim();
        return {
            matched: true, sourceId: '', legacy: false, all: false, help: false,
            listSources: true,
            partyPool: qualifier === 'второстепенные' || qualifier === 'быдлячьи'
                ? 'secondary' : 'primary',
            includeAllPools: qualifier === 'все',
        };
    }
    const sourceListUpdate = String(input || '').trim().match(/^источник(?:и|ов)?\s+(?:изменить|обновить)[ \t]*(?::|\r?\n)([\s\S]+)$/iu);
    if (sourceListUpdate) {
        return { matched: true, sourceId: '', legacy: false, all: false, help: false, listSourcesUpdate: true, sourceListBody: String(sourceListUpdate[1] || '').trim() };
    }

    // V18878: the secondary party pool has its own source registry and parser
    // namespace.  Parse it before the generic `тусы ...` compatibility rules so
    // a secondary command can never fall through into the primary pool.
    const secondaryAddSourceMatch = command.match(
        /^тус[аы]\s+(?:быдлячьи|второстепенные)\s+(?:добавить|добавь)\s+источник(?:\s+(.+))?$/u,
    );
    if (secondaryAddSourceMatch) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: false,
            help: false,
            addSource: true,
            partyPool: 'secondary',
            sourceInput: String(secondaryAddSourceMatch[1] ?? '').trim(),
        };
    }

    // Removal is a source-registry action, not an event deletion. Match the
    // complete phrase before the generic secondary/parser and party routes.
    const secondaryRemoveSourceMatch = command.match(
        /^тус[аы]\s+(?:быдлячьи|второстепенные)\s+(?:удалить|удали|убрать|убери)\s+источник(?:\s+(.+))?$/u,
    );
    if (secondaryRemoveSourceMatch) {
        return {
            matched: true, sourceId: '', legacy: false, all: false,
            help: false, removeSource: true, partyPool: 'secondary',
            sourceInput: String(secondaryRemoveSourceMatch[1] ?? '').trim(),
        };
    }

    const secondaryParserMatch = command.match(
        /^(?:тус[аы]\s+)?(?:быдлячьи|второстепенные)(?:\s+тус[аы])?\s+(?:парсер|парсеры|скрейпер|скрейперы|scraper|scrapers)(?:\s+(.+))?$/u,
    );
    if (secondaryParserMatch) {
        const tail = String(secondaryParserMatch[1] ?? '').trim();
        const cleanOnly = /^(?:все|всё|all)\s+(?:чисто|новые|new|clean)$/u.test(tail);
        const recover = /^(?:(?:все|all)\s+)?(?:восстановить|resume)$/u.test(tail);
        // A bare secondary namespace means «run the whole secondary pool»;
        // it must not degrade into a help response.
        const all = !tail || cleanOnly || recover || /^(?:все|всё|all)$/u.test(tail);
        return {
            matched: true,
            sourceId: all ? '' : tail,
            legacy: false,
            all,
            cleanOnly: cleanOnly || recover,
            recover,
            help: false,
            partyPool: 'secondary',
            phaseCount,
        };
    }

    // Accept the natural reverse order used in chat: «парсер второстепенные» / «парсер быдлячьи».
    // Keep this before generic primary parser aliases so the pool is never
    // silently changed to primary.
    const reverseSecondaryParserMatch = command.match(
        /^(?:тус[аы]\s+)?(?:парсер|парсеры|скрейпер|скрейперы|scraper|scrapers)\s+(?:быдлячьи|второстепенные)(?:\s+тус[аы])?(?:\s+(.+))?$/u,
    );
    if (reverseSecondaryParserMatch) {
        const tail = String(reverseSecondaryParserMatch[1] ?? '').trim();
        const cleanOnly = /^(?:все|всё|all)\s+(?:чисто|новые|new|clean)$/u.test(tail);
        const recover = /^(?:(?:все|all)\s+)?(?:восстановить|resume)$/u.test(tail);
        const all = !tail || cleanOnly || recover || /^(?:все|всё|all)$/u.test(tail);
        return {
            matched: true,
            sourceId: all ? '' : tail,
            legacy: false,
            all,
            cleanOnly: cleanOnly || recover,
            recover,
            help: false,
            partyPool: 'secondary',
            phaseCount,
        };
    }

    /*
     * Пользовательская привычка «тусы парсер ...» не должна проваливаться в
     * листинг событий. Убираем только этот префикс и только перед явным
     * namespace парсера, чтобы обычные команды «тусы ...» не затрагивать.
     */
    if (/^тус[аы]\s+(?:парсер|парсеры|скрейпер|скрейперы|scraper|scrapers)(?:\s|$)/u.test(command)) {
        command = command.replace(/^тус[аы]\s+/u, '').trim();
    }

    const reparseLinkMatch = command.match(
        /^(?:парсер|скрейпер|scraper)\s+(?:(?:перепарсить|перепарс|reparse)\s+)?(?:ссылк(?:а|у)|link)?\s*(https?:\/\/\S+)$/u,
    );
    if (reparseLinkMatch) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: false,
            help: false,
            reparseUrl: String(reparseLinkMatch[1] ?? '').trim(),
        };
    }

    const addSourceMatch = command.match(
        /^(?:(?:тус[аы]\s+)?(?:добавить|добавь)\s+источник|(?:парсер|скрейпер|scraper)\s+(?:добавить|добавь)\s+источник)(?:\s+(.+))?$/u,
    );
    if (addSourceMatch) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: false,
            help: false,
            addSource: true,
            sourceInput: String(addSourceMatch[1] ?? '').trim(),
        };
    }

    const removeSourceMatch = command.match(
        /^(?:(?:тус[аы]\s+)?(?:удалить|удали|убрать|убери)\s+источник|(?:парсер|скрейпер|scraper)\s+(?:удалить|удали|убрать|убери)\s+источник)(?:\s+(.+))?$/u,
    );
    if (removeSourceMatch) {
        return {
            matched: true, sourceId: '', legacy: false, all: false,
            help: false, removeSource: true,
            sourceInput: String(removeSourceMatch[1] ?? '').trim(),
        };
    }

    if (HELP_COMMANDS.has(command)) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: false,
            help: true,
        };
    }

    if (RECOVER_ALL_COMMANDS.has(command)) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: true,
            cleanOnly: true,
            recover: true,
            help: false,
        };
    }

    if (CLEAN_ALL_COMMANDS.has(command)) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: true,
            cleanOnly: true,
            help: false,
            phaseCount,
        };
    }

    if (ALL_COMMANDS.has(command)) {
        return {
            matched: true,
            sourceId: '',
            legacy: false,
            all: true,
            cleanOnly: false,
            help: false,
            phaseCount,
        };
    }

    if (LEGACY_START_COMMANDS.has(command)) {
        return {
            matched: true,
            sourceId: '',
            legacy: true,
            all: false,
            help: true,
        };
    }

    const patterns = [
        /^(?:парсер|скрейпер|scraper)\s+(?:запустить|старт|run)(?:\s+(.+))?$/u,
        /^(?:запустить|старт|run)\s+(?:парсер|скрейпер|scraper)(?:\s+(.+))?$/u,
        /^(?:парсер|скрейпер|scraper)\s+((?:tg|vk|chat):[^\s]+)$/u,
    ];

    for (const pattern of patterns) {
        const match = command.match(pattern);

        if (!match) {
            continue;
        }

        const sourceId = String(match[1] ?? '').trim();
        const all = /^(?:все|всё|all)$/u.test(sourceId);

        return {
            matched: true,
            sourceId: all ? '' : sourceId,
            legacy: false,
            all,
            help: !sourceId,
        };
    }

    return {
        matched: false,
        sourceId: '',
        legacy: false,
        all: false,
        help: false,
    };
}

export function parseScraperStartCommand(input) {
    const parsed = parseScraperStartCommandInternal(input);
    const match = normalizeCommand(input).match(/(?:^|\s)(турбо[1-4]|турбо|turbo[1-4]|turbo)(?=\s|$)/iu);
    if (!match) return parsed;
    const rawMode = String(match[1]).toLowerCase();
    const turboMode = rawMode.replace(/^турбо/iu, 'turbo');
    return { ...parsed, turboMode: turboMode === 'turbo1' ? 'turbo' : turboMode };
}
