const TRANSLIT = new Map(Object.entries({
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
}));

const FUNCTION_WORDS = new Set(`
    a an the and or but nor if then else when where who whom whose what which that this these those
    of to in on at by for from with without into onto over under as is are was were be been being am
    do does did doing have has had having can could may might must shall should will would ought need dare
    about across after against along among around before behind below beneath beside between beyond despite
    down during except inside near off out outside past since through throughout till toward towards upon
    via within because although though while unless until whether
    и а но или либо да же бы быть чтобы что как когда где кто который которая которые которое
    это этот эта эти тот та те его ее её их мы вы они он она оно мой моя мое моё мои твой твоя
    твое твои наше наши все всё только еще ещё уже если то ли меня тебя себя нас вас им ему ей ним них
    нашими вашими которыми которого которой которое является являются был была было были будет будут есть
    в во на над о об обо около от ото перед по под при про ради с со сквозь среди у через без до за из изо к ко кроме между вместо вне
`.trim().split(/\s+/u));

const GENERIC_WORDS = new Set(`
    bar pub club hall zal rock venue place ploshchadka studio loft restaurant cafe restaurant
    art space cultural kulturnoe prostranstvo artel center tsentr theatre theater park
    бар паб клуб холл зал рок площадка студия лофт ресторан кафе пространство культурное
    артель центр театр парк помещение
`.trim().split(/\s+/u));
const transliterate = value => [...String(value)].map(char => TRANSLIT.get(char) ?? char).join('');
for (const word of [...FUNCTION_WORDS]) FUNCTION_WORDS.add(transliterate(word));
for (const word of [...GENERIC_WORDS]) GENERIC_WORDS.add(transliterate(word));

const TOKEN_ALIASES = new Map([
    ['dizel', 'diesel'], ['diesel', 'diesel'], ['kholl', 'hall'], ['holl', 'hall'],
    ['klub', 'club'], ['pab', 'pub'], ['kafe', 'cafe'], ['restoran', 'restaurant'],
]);

const FUNCTION_STEMS = new Set(['клуб', 'клубе', 'баре', 'холле', 'студии', 'лофте', 'пабе', 'роке'].map(transliterate));

export function isNameComparisonStopWord(value) {
    const raw = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    const token = TOKEN_ALIASES.get(transliterate(raw)) || transliterate(raw);
    return FUNCTION_WORDS.has(raw) || FUNCTION_WORDS.has(token) || GENERIC_WORDS.has(token) || FUNCTION_STEMS.has(token);
}

export function normalizeVenueNameToken(value) {
    const raw = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    if (!raw || FUNCTION_WORDS.has(raw)) return '';
    const transliterated = transliterate(raw);
    const token = TOKEN_ALIASES.get(transliterated) || transliterated;
    if ([...token].length < 3 || FUNCTION_WORDS.has(token) || GENERIC_WORDS.has(token) || /^\d+$/u.test(token)) return '';
    return token;
}

export function venueComparisonTokens(value) {
    const source = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    return [...new Set((source.match(/[\p{L}\p{N}]+/gu) || []).map(raw => {
        if (isNameComparisonStopWord(raw)) return '';
        const transliterated = transliterate(raw);
        const token = TOKEN_ALIASES.get(transliterated) || transliterated;
        return [...token].length >= 3 && !FUNCTION_WORDS.has(token) && !FUNCTION_STEMS.has(token) && !/^\d+$/u.test(token) ? token : '';
    }).filter(Boolean))];
}

export function venueNameTokens(value) {
    return venueComparisonTokens(value).filter(token => !GENERIC_WORDS.has(token));
}
