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
export function parseScraperStartCommand(input) {
    let command = normalizeCommand(input)
        .replace(/^(?:гигорейв|gigorave)\s+/u, '')
        .trim();

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
        const recover = /^(?:все|all)\s+(?:восстановить|resume)$/u.test(tail);
        const all = cleanOnly || recover || /^(?:все|всё|all)$/u.test(tail);
        return {
            matched: true,
            sourceId: all ? '' : tail,
            legacy: false,
            all,
            cleanOnly: cleanOnly || recover,
            recover,
            help: !tail,
            partyPool: 'secondary',
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
