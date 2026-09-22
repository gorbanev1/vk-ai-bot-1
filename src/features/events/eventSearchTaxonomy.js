const GENERIC_VENUE_WORDS = new Set([
    'бар','bar','паб','pub','клуб','club','hall','холл','rock','рок','рокбар','рокпаб',
    'ресторан','restobar','ресто','кафе','cafe','центр','арт','art','лоунж','lounge',
]);

function normalize(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[«»„“”"'`]/gu, ' ')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function compact(value) {
    return normalize(value).replace(/\s+/gu, '');
}

function meaningfulVenueTokens(value) {
    return normalize(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !GENERIC_VENUE_WORDS.has(token) && !/^\d+$/u.test(token));
}

export const EVENT_VENUE_KEYS = Object.freeze([
    { key: 'diesel', label: 'Diesel', aliases: ['diesel','дизель'] },
    { key: 'diesel-bar', label: 'Diesel Bar', aliases: ['diesel bar','rock bar diesel','дизель бар','рок бар дизель','rockbar diesel','diesel rock bar'] },
    { key: 'diesel-hall', label: 'Diesel Hall', aliases: ['diesel hall','дизель холл','дизель хол','dieselhall'] },
    { key: 'tupik', label: 'Тупик', aliases: ['тупик','bar tupik','бар тупик'] },
    { key: 'mama-anarhiya', label: 'Мама Анархия', aliases: ['мама анархия','mama anarhiya','mama anarchia','mama anarkhiya','паб мама анархия','рок паб мама анархия'] },
    { key: 'vavilon', label: 'The Last of Vavilone / Вавилон', aliases: ['the last of vavilone','the last of vavilon','last of vavilone','last of vavilon','vavilone','vavilon','вавилон','зе ласт оф вавилон'] },
    { key: 'sto-ruchev', label: 'Сто Ручьёв', aliases: ['сто ручьев','сто ручьёв','100 ручьев','100 ручьёв','sto ruchev'] },
    { key: 'liverpool', label: 'Ливерпуль', aliases: ['ливерпуль','liverpool','liverpool pub','ливерпуль паб'] },
    { key: 'balagan-city', label: 'Балаган Сити', aliases: ['балаган сити','balagan city','балаган'] },
    { key: 'kotelnaya', label: 'Котельная', aliases: ['котельная','kotelnaya'] },
    { key: 'overlock', label: 'Overlock', aliases: ['overlock','оверлок','underlock','андерлок'] },
    { key: 'poneslos', label: 'Понеслось', aliases: ['понеслось','poneslos','poneslos bar'] },
    { key: 'pinta-haus', label: 'Pinta Haus', aliases: ['pinta haus','пинта хаус','pinta'] },
    { key: 'club-12', label: 'Клуб 12', aliases: ['клуб 12','club 12'] },
    { key: 'club-72', label: 'Клуб 72', aliases: ['клуб 72','club 72'] },
    { key: 'ce', label: 'ЦЕ', aliases: ['це','ce','це воронеж'] },
    { key: 'arena-hall', label: 'Арена Холл', aliases: ['арена холл','arena hall'] },
    { key: 'bashnya', label: 'Башня / Винзавод', aliases: ['башня','винзавод','bashnya','vinzavod'] },
    { key: 'chaika', label: 'Артель Чайка', aliases: ['артель чайка','чайка','chaika'] },
    { key: 'koptilnya', label: 'Коптильня', aliases: ['коптильня','koptilnya'] },
    { key: 'litera', label: 'Литера', aliases: ['литера','litera','рестобар литера'] },
    { key: 'malina', label: 'Malina', aliases: ['malina','малина','malina lounge','малина lounge'] },
]);

export const EVENT_TAG_KEYS = Object.freeze([
    { key: 'rock', label: 'рок', aliases: ['rock','рок'] },
    { key: 'russian-rock', label: 'русский рок', aliases: ['русский рок','russian rock'] },
    { key: 'metal', label: 'metal', aliases: ['metal','метал','металл'] },
    { key: 'black-metal', label: 'black metal', aliases: ['black metal','black-metal','блэк метал','блэк-метал','черный метал','чёрный метал'] },
    { key: 'death-metal', label: 'death metal', aliases: ['death metal','death-metal','дэт метал','дэт-метал'] },
    { key: 'deathcore', label: 'deathcore', aliases: ['deathcore','death core','death-core','дэткор','дэт кор','дэт-кор'] },
    { key: 'screamo', label: 'screamo', aliases: ['screamo','скримо'] },
    { key: 'indie', label: 'indie', aliases: ['indie','инди'] },
    { key: 'post-punk', label: 'post-punk', aliases: ['post-punk','post punk','пост-панк','пост панк'] },
    { key: 'punk-rock', label: 'punk rock', aliases: ['punk rock','punk-rock','панк рок','панк-рок','панк'] },
    { key: 'hardcore', label: 'hardcore', aliases: ['hardcore','hard core','хардкор','хард-кор'] },
    { key: 'electronics', label: 'электроника', aliases: ['электроника','электронная музыка','electronic','electronics','electro','электро'] },
    { key: 'rave', label: 'rave', aliases: ['rave','рейв'] },
    { key: 'dj', label: 'DJ', aliases: ['dj','djs','диджей','диджеи','диджейская туса','диджейская вечеринка'] },
    { key: 'acoustic', label: 'акустика', aliases: ['акустика','акустический','акустическая','acoustic','электроакустика','электроакустический'] },
    { key: 'author-song', label: 'авторская песня', aliases: ['авторская песня','авторские песни','бард','бардовская'] },
    { key: 'party', label: 'вечеринка', aliases: ['вечеринка','party','туса','тусовка'] },
    { key: 'apartment-concert', label: 'квартирник', aliases: ['квартирник','квартирники'] },
    { key: 'folk', label: 'folk', aliases: ['folk','фолк'] },
    { key: 'reggae-ska', label: 'reggae / ska', aliases: ['reggae','регги','ska','ска'] },
    { key: 'blues', label: 'blues', aliases: ['blues','блюз'] },
    { key: 'emo', label: 'emo', aliases: ['emo','эмо'] },
    { key: 'alternative', label: 'alternative', aliases: ['alternative','альтернатива','альтернативный'] },
    { key: 'industrial', label: 'industrial', aliases: ['industrial','индастриал'] },
    { key: 'techno', label: 'techno', aliases: ['techno','техно'] },
    { key: 'house', label: 'house', aliases: ['house','хаус'] },
    { key: 'hip-hop-rap', label: 'hip-hop / rap', aliases: ['hip hop','hip-hop','хип хоп','хип-хоп','rap','рэп'] },
    { key: 'cover-tribute', label: 'cover / tribute', aliases: ['cover','кавер','кавер концерт','tribute','трибьют'] },
    { key: 'grunge', label: 'grunge', aliases: ['grunge','гранж'] },
    { key: 'nu-metal', label: 'nu metal', aliases: ['nu metal','nu-metal','ню метал','ню-метал'] },
    { key: 'metalcore', label: 'metalcore', aliases: ['metalcore','metal core','metal-core','металкор','метал-кор'] },
    { key: 'poetry', label: 'поэзия', aliases: ['поэзия','поэтический','стихи','стихотворения'] },
    { key: 'jam', label: 'jam / джем', aliases: ['jam','джем','джем-сейшн','jam session'] },
    { key: 'open-mic', label: 'open mic', aliases: ['open mic','open-mic','открытый микрофон'] },
]);

const VENUE_BY_KEY = new Map(EVENT_VENUE_KEYS.map((item) => [item.key, item]));
const TAG_BY_KEY = new Map(EVENT_TAG_KEYS.map((item) => [item.key, item]));

const aliases = (rows) => rows.flatMap((item) => item.aliases.map((alias) => ({
    key: item.key,
    alias,
    normalized: normalize(alias),
    compact: compact(alias),
}))).sort((a, b) => b.normalized.length - a.normalized.length);
const VENUE_ALIASES = aliases(EVENT_VENUE_KEYS);
const TAG_ALIASES = aliases(EVENT_TAG_KEYS);

export function normalizeEventSearchTag(value) {
    const raw = normalize(value);
    if (!raw) return '';
    const known = TAG_ALIASES.find((item) => item.normalized === raw || item.compact === compact(raw));
    if (known) return known.key;
    return raw.replace(/\s+/gu, '-').slice(0, 80);
}

export function normalizeEventTags(values) {
    const source = Array.isArray(values) ? values : String(values ?? '').split(/[,;|]/u);
    return [...new Set(source.map(normalizeEventSearchTag).filter(Boolean))].slice(0, 16);
}

export function inferVenueKey(value) {
    const text = normalize(value);
    if (!text) return '';
    const compactText = compact(text);
    const specific = VENUE_ALIASES.filter((item) => item.key !== 'diesel').find((item) => (
        text.includes(item.normalized) || compactText.includes(item.compact)
    ));
    if (specific) return specific.key;
    if (/(?:^|\s)(?:diesel|дизель)(?:\s|$)/u.test(text)) return 'diesel';

    const tokens = new Set(meaningfulVenueTokens(text));
    const byToken = EVENT_VENUE_KEYS.find((item) => item.aliases.some((alias) => {
        const aliasTokens = meaningfulVenueTokens(alias);
        return aliasTokens.length && aliasTokens.some((token) => tokens.has(token));
    }));
    return byToken?.key || '';
}

export function inferEventSearchTags(event = {}) {
    const haystack = normalize([
        event?.title,
        event?.participants,
        event?.description,
        event?.eventType,
        event?.program,
        ...(Array.isArray(event?.eventTags) ? event.eventTags : []),
    ].filter(Boolean).join(' '));
    const compactText = compact(haystack);
    const result = new Set(normalizeEventTags(event?.eventTags));
    for (const item of TAG_ALIASES) {
        if (haystack.includes(item.normalized) || compactText.includes(item.compact)) result.add(item.key);
    }
    return [...result].slice(0, 16);
}

export function isKnownEventTag(value) {
    return TAG_BY_KEY.has(normalizeEventSearchTag(value));
}

export function findUnknownEventTags(values) {
    return normalizeEventTags(values).filter((tag) => !TAG_BY_KEY.has(tag));
}

function stripAliases(text, matchedAliases) {
    let output = ` ${String(text ?? '')} `;
    for (const item of matchedAliases) {
        const escaped = item.alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
        output = output.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu'), ' ');
    }
    return output.replace(/\s+/gu, ' ').trim();
}

function collectAliases(text, rows) {
    const normalizedText = normalize(text);
    const compactText = compact(text);
    const found = [];
    for (const item of aliases(rows)) {
        if (!item.normalized) continue;
        const exactWord = normalizedText === item.normalized;
        const phrase = normalizedText.includes(item.normalized);
        const compactPhrase = item.compact.length >= 5 && compactText.includes(item.compact);
        if (exactWord || phrase || compactPhrase) found.push(item);
    }
    const byKey = new Map();
    for (const item of found) if (!byKey.has(item.key)) byKey.set(item.key, item);
    return [...byKey.values()];
}

export function parseEventSearchRequest(value) {
    const raw = String(value ?? '').normalize('NFKC').trim();
    const clean = raw.replace(/^гигорейв[\s,:-]*/iu, '').trim();
    const lower = normalize(clean);
    const showCatalog = /^(?:тусы\s+)?(?:ключи|фильтры|жанры|площадки)$/iu.test(lower);
    if (showCatalog) return { matched: true, showCatalog: true, rangeText: '', venueKeys: [], tags: [] };

    let venueMatches = collectAliases(clean, EVENT_VENUE_KEYS);
    if (venueMatches.some((item) => item.key === 'diesel-bar' || item.key === 'diesel-hall')) {
        venueMatches = venueMatches.filter((item) => item.key !== 'diesel');
    }
    const tagMatches = collectAliases(clean, EVENT_TAG_KEYS);
    const isPartyCommand = /^(?:тусы|тусовки|события)(?:\s|$)/iu.test(clean);
    const bareKnownKey = !isPartyCommand && Boolean(venueMatches.length || tagMatches.length) && (
        venueMatches.some((item) => normalize(item.alias) === lower) ||
        tagMatches.some((item) => normalize(item.alias) === lower)
    );
    if (!isPartyCommand && !bareKnownKey) {
        return { matched: false, showCatalog: false, rangeText: clean, venueKeys: [], tags: [] };
    }

    const stripped = stripAliases(clean, [...venueMatches, ...tagMatches]);
    const rangeText = /^(?:тусы|тусовки|события)$/iu.test(stripped) || !stripped
        ? 'тусы все'
        : stripped;
    return {
        matched: true,
        showCatalog: false,
        rangeText,
        venueKeys: [...new Set(venueMatches.map((item) => item.key))],
        tags: [...new Set(tagMatches.map((item) => item.key))],
    };
}

export function eventMatchesSearchFilters(event, filters = {}) {
    const venueKeys = Array.isArray(filters?.venueKeys) ? filters.venueKeys.filter(Boolean) : [];
    const tags = Array.isArray(filters?.tags) ? filters.tags.filter(Boolean) : [];
    if (!venueKeys.length && !tags.length) return true;

    const eventVenueKey = String(event?.venueKey || inferVenueKey(event?.venue)).trim();
    const eventTags = new Set(inferEventSearchTags(event));
    const venueOk = !venueKeys.length || venueKeys.some((key) => {
        if (key === 'diesel') return eventVenueKey === 'diesel' || eventVenueKey === 'diesel-bar' || eventVenueKey === 'diesel-hall';
        return eventVenueKey === key;
    });
    const tagsOk = !tags.length || tags.every((tag) => eventTags.has(tag));
    return venueOk && tagsOk;
}

export function formatEventSearchKeyCatalog() {
    return [
        'Фильтры афиши:',
        '',
        `Площадки: ${EVENT_VENUE_KEYS.map((item) => item.label).join(', ')}.`,
        `Жанры/форматы: ${EVENT_TAG_KEYS.map((item) => item.label).join(', ')}.`,
        '',
        'Примеры: «тусы Ливерпуль», «тусы дизель», «тусы Diesel Hall», «тусы black metal», «тусы DJ», «тусы rave», «тусы на месяц акустика».',
        'Для «дизель» показываются и Diesel Bar, и Diesel Hall; точные «Diesel Bar»/«Diesel Hall» разделяются.',
    ].join('\n');
}

export function formatEventTagPromptInstruction() {
    return [
        `Поле tags — массив из 0–6 ключей. Сначала выбирай из: ${EVENT_TAG_KEYS.map((item) => item.key).join(', ')}.`,
        'Можно вернуть несколько ключей одновременно (например dj + rave).',
        'Если ни один ключ действительно не подходит, добавь ОДИН короткий новый жанровый/форматный ключ; не придумывай тег без явного основания в материале.',
    ].join(' ');
}

export function eventVenueKeyLabel(key) {
    return VENUE_BY_KEY.get(String(key ?? ''))?.label || String(key ?? '');
}

export function eventTagLabel(key) {
    return TAG_BY_KEY.get(String(key ?? ''))?.label || String(key ?? '');
}
