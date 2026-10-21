/**
 * Решает, является запрос наталом или прашной, и выбирает локальный либо модельный расчёт.
 */
function normalizeAstrologyText(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/\s+/gu, ' ')
        .trim();
}

const ASTROLOGY_LEFT_BOUNDARY = '(?:^|[\\s,.;:!?()\\[\\]{}«»"\'`/\\\\|+-])';
const ASTROLOGY_RIGHT_BOUNDARY = '(?=$|[\\s,.;:!?()\\[\\]{}«»"\'`/\\\\|+-])';

const NATAL_PATTERN = /(?:^|[\s,.;:!?()\[\]{}«»"'`/\\|+-])(?:натал(?:ьн(?:ая|ую|ой|ую|ые|ых)?(?:\s+карт(?:а|у|ы|е|ой))?)?|натальн(?:ая|ую|ой)\s+карт(?:а|у|ы|е|ой)|natal(?:\s+chart)?|birth\s+chart)(?=$|[\s,.;:!?()\[\]{}«»"'`/\\|+-])/iu;
const PRASHNA_PATTERN = /(?:^|[\s,.;:!?()\[\]{}«»"'`/\\|+-])(?:прашн(?:а|у|е|ы|ой|ую)?|prashna|хорар(?:н(?:ая|ую|ой)?(?:\s+карт(?:а|у|ы|е|ой))?)?|horary)(?=$|[\s,.;:!?()\[\]{}«»"'`/\\|+-])/iu;
const NON_LOCAL_PATTERN = /(?:^|[\s,.;:!?()\[\]{}«»"'`/\\|+-])(?:нелокал(?:ьн(?:о|ый|ая|ую|ого|ой))?|не\s+локал(?:ьн(?:о|ый|ая|ую|ого|ой))?|не\s+локальн(?:ый|ая|ую|ого|ой)\s+расч[её]т|без\s+локальн(?:ого|ой)\s+расч[её]та|без\s+расч[её]та\s+локально|не\s+считай\s+локально|моделью\s+без\s+локальн(?:ого|ой)\s+расч[её]та)(?=$|[\s,.;:!?()\[\]{}«»"'`/\\|+-])/iu;

const LOCAL_TOKEN_SOURCE = [
    'локалэфемерид(?:ы|а|ам|ами|ах)?',
    'локал(?:ьн(?:ые|ая|ый|ую|ого|ой))?\\s+эфемерид(?:ы|а|ам|ами|ах)?',
    'эфемерид(?:ы|а|ам|ами|ах)?\\s+локально',
    'локальн(?:ый|ая|ую|ого|ой)\\s+расч[её]т',
    'расч[её]т\\s+локально',
    'рассчитай\\s+локально',
    'рассчитать\\s+локально',
    'считай\\s+локально',
    'посчитай\\s+локально',
    'локальн(?:ым|ого|ой|ый|ая|ую|ые|ых)\\s+(?:софтом|софте|по|движком|кодом)',
    '(?:своим|ботовским)\\s+локальн(?:ым|ого|ой)\\s+(?:софтом|по|движком|кодом)',
    'локал',
    'local(?:\\s+ephemeris|\\s+ephemerides|\\s+calculation)?',
].join('|');
const LOCAL_PATTERN = new RegExp(
    `${ASTROLOGY_LEFT_BOUNDARY}(?:${LOCAL_TOKEN_SOURCE})${ASTROLOGY_RIGHT_BOUNDARY}`,
    'iu',
);

const PRO_ASTROLOGY_MODES = Object.freeze(['pro', 'pro2', 'pro3', 'astra']);

export function isNatalRequest(text) {
    return NATAL_PATTERN.test(normalizeAstrologyText(text));
}

export function isPrashnaRequest(text) {
    const normalized = normalizeAstrologyText(text);

    if (NATAL_PATTERN.test(normalized)) {
        return false;
    }

    return PRASHNA_PATTERN.test(normalized);
}

export function isNonLocalAstrologyRequest(text) {
    return NON_LOCAL_PATTERN.test(normalizeAstrologyText(text));
}

/**
 * Явный локальный ключ принудительно включает максимальный пакет даже для pro.
 * Формулировки «не локал»/«без локального расчёта» имеют приоритет и не должны
 * случайно распознаваться как положительный ключ из-за отдельного слова «локал».
 */
export function isLocalAstrologyRequest(text) {
    const normalized = normalizeAstrologyText(text);

    if (NON_LOCAL_PATTERN.test(normalized)) {
        return false;
    }

    return LOCAL_PATTERN.test(normalized);
}

export function getAstrologyRequestKind(text) {
    if (isNatalRequest(text)) {
        return 'natal';
    }

    if (isPrashnaRequest(text)) {
        return 'prashna';
    }

    return 'none';
}

export function isProAstrologyMode(mode) {
    return PRO_ASTROLOGY_MODES.includes(String(mode ?? ''));
}

/**
 * V188.49 astrology execution contract:
 * - EVERY natal/prashna request is calculated locally first;
 * - pro/pro2/pro3/astra are interpreters of the bot-calculated packet, never the
 *   primary ephemeris engine;
 * - an explicit "non-local" phrase cannot bypass the local-first gate;
 * - if local calculation fails, caller may use only the controlled model
 *   fallback that requires a REAL Swiss Ephemeris library execution.
 */
export function resolveAstrologyExecution({
    kind = 'none',
    mode = 'default',
    nonLocalRequested = false,
    localRequested = false,
} = {}) {
    const normalizedKind = ['natal', 'prashna'].includes(kind)
        ? kind
        : 'none';
    const astrologyRequest = normalizedKind !== 'none';
    const proModel = astrologyRequest && isProAstrologyMode(mode);
    const explicitLocal = astrologyRequest && Boolean(localRequested);
    const explicitNonLocal = astrologyRequest && Boolean(nonLocalRequested);
    const localCalculation = astrologyRequest;
    const modelCalculation = false;

    let reason = 'not-astrology';
    if (astrologyRequest) {
        reason = explicitNonLocal
            ? 'mandatory-local-swiss-overrides-nonlocal'
            : 'mandatory-local-swiss';
    }

    return {
        kind: normalizedKind,
        astrologyRequest,
        proModel,
        localRequested: explicitLocal,
        nonLocalRequested: explicitNonLocal,
        localCalculation,
        modelCalculation,
        modelFallbackAllowed: astrologyRequest,
        packet: localCalculation ? 'maximum' : 'none',
        reason,
    };
}
