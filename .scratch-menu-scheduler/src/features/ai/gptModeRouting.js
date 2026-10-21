/**
 * Чистая маршрутизация ключей моделей mini/gpt54/gpt55/pro/pro2/pro3 и профиля прашны.
 */
const ASTRA_TOKEN_SOURCE = [
    'astra',
    'астра',
    'gpt[\s_-]?6(?:[\s_-]?astra)?',
    'gpt[\s_-]?6[\s_-]?астра',
    'max',
    'latest',
    'последн(?:яя|юю|ий)(?:\s+модел(?:ь|и|ью))?',
    '(?:сам(?:ая|ую)\s+)?(?:продвинут(?:ая|ую)|умн(?:ая|ую)|интеллектуальн(?:ая|ую)|мощн(?:ая|ую)|сильн(?:ая|ую)|лучш(?:ая|ую)|топов(?:ая|ую)|максимальн(?:ая|ую))(?:\s+модел(?:ь|и|ью))?',
].join('|');

const PRO3_TOKEN_SOURCE = [
    'pro3',
    'sol',
    'сол',
].join('|');

const PRO2_TOKEN_SOURCE = [
    'pro2',
    'terra',
    'терра',
    '(?:средн(?:яя|юю)|сбалансированн(?:ая|ую))(?:\\s+модел(?:ь|и|ью))?',
].join('|');

const PRO_TOKEN_SOURCE = [
    'pro1',
    'pro',
    'luna',
    'луна',
].join('|');

const GPT55_TOKEN_SOURCE = [
    'gpt[\\s_-]?55',
    'model[\\s_-]?55',
    'модел(?:ь|и|ью)?[\\s_-]?55',
    'classic',
    'классик',
].join('|');

const GPT54_TOKEN_SOURCE = [
    'gpt[\\s_-]?54',
    'model[\\s_-]?54',
    'модел(?:ь|и|ью)?[\\s_-]?54',
    'standard',
    'стандарт',
].join('|');

const DEFAULT_TOKEN_SOURCE = [
    'mini',
    'мини',
    'base',
    'basic',
    'база',
    'эконом',
    'экономн(?:ая|ую)(?:\\s+модел(?:ь|и|ью))?',
    '(?:сам(?:ая|ую)\\s+)?дешев(?:ая|ую)(?:\\s+модел(?:ь|и|ью))?',
].join('|');

const MODE_ALIASES = Object.freeze([
    { mode: 'astra', tokenSource: `(?:${ASTRA_TOKEN_SOURCE})` },
    { mode: 'pro3', tokenSource: `(?:${PRO3_TOKEN_SOURCE})` },
    { mode: 'pro2', tokenSource: `(?:${PRO2_TOKEN_SOURCE})` },
    { mode: 'pro', tokenSource: `(?:${PRO_TOKEN_SOURCE})` },
    { mode: 'gpt55', tokenSource: `(?:${GPT55_TOKEN_SOURCE})` },
    { mode: 'gpt54', tokenSource: `(?:${GPT54_TOKEN_SOURCE})` },
    { mode: 'default', tokenSource: `(?:${DEFAULT_TOKEN_SOURCE})` },
]);

const MODE_LEFT_BOUNDARY = '(^|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';
const MODE_RIGHT_BOUNDARY = '(?=$|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';

function findModeToken(body, alias) {
    const expression = new RegExp(
        `${MODE_LEFT_BOUNDARY}(${alias.tokenSource})${MODE_RIGHT_BOUNDARY}`,
        'iu',
    );
    const match = expression.exec(body);

    if (!match) {
        return null;
    }

    const tokenStart = match.index + match[1].length;

    return {
        mode: alias.mode,
        token: match[2],
        tokenStart,
        tokenEnd: tokenStart + match[2].length,
    };
}

/**
 * Extracts the strongest explicitly requested GPT mode from ANY position.
 *
 * Precedence is deliberately fixed: astra > pro3 > pro2 > pro > gpt55 > gpt54 >
 * mini/default. Exact boundaries prevent partial matches such as profile or
 * pro30. The default aliases are still removed from the prompt when written
 * explicitly, although an omitted mode also resolves to default.
 */
export function extractExplicitGptMode(input) {
    const originalBody = String(input ?? '').trim();

    for (const alias of MODE_ALIASES) {
        const found = findModeToken(originalBody, alias);

        if (!found) {
            continue;
        }

        const prefix = originalBody.slice(0, found.tokenStart);
        const suffix = originalBody
            .slice(found.tokenEnd)
            .replace(/^\s*[,;:–—-]?\s*/u, prefix ? ' ' : '');
        const body = `${prefix}${suffix}`
            .replace(/\s{2,}/gu, ' ')
            .replace(/^\s+|\s+$/gu, '')
            .replace(/^[,.;:!?]+\s*/gu, '')
            .replace(/\s+([,.;:!?])/gu, '$1')
            .trim();

        return {
            mode: found.mode,
            body,
            source: found.tokenStart === 0 ? 'prefix' : 'any-position',
            token: found.token,
        };
    }

    return {
        mode: 'default',
        body: originalBody,
        source: 'implicit',
        token: '',
    };
}

/**
 * Prashna keeps the explicitly selected interpretation model. Ephemerides are
 * calculated locally first for every mode; the model receives the maximum local
 * packet. A model-side Swiss Ephemeris calculation is only an error fallback.
 */
export function resolvePrashnaGptMode(requestedMode) {
    return [
        'default',
        'gpt54',
        'gpt55',
        'pro',
        'pro2',
        'pro3',
        'astra',
    ].includes(requestedMode)
        ? requestedMode
        : 'default';
}

export function getPrashnaPayloadProfile(
    mode,
    { localCalculation = null } = {},
) {
    if (localCalculation === true) {
        return 'maximum';
    }

    return ['pro', 'pro2', 'pro3', 'astra'].includes(mode)
        ? 'none'
        : 'maximum';
}
