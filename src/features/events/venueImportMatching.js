import { venueNameTokens } from './venueNameTokens.js';

const TRANSLIT = new Map(Object.entries({
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
}));
const GENERIC = new Set(['bar','pub','club','hall','studio','loft','rock','restaurant','cafe','space','art','place','venue','the','a','an','бар','клуб','холл','студия','лофт','рок','паб','ресторан','кафе','пространство','арт','площадка','зал','центр','культурное','артель','воронеж','г']);
const TRANSLATIONS = [
    ['diesel', 'дизель'], ['berserk', 'берсерк'], ['liverpool', 'ливерпуль'],
    ['overlock', 'оверлок'], ['mama', 'мама'], ['anarchia', 'анархия'], ['anarchy', 'анархия'],
    ['the last of vavilone', 'последний вавилон'], ['last of vavilone', 'последний вавилон'],
    ['tower', 'башня'], ['seagull', 'чайка'],
];

function words(value) {
    return venueNameTokens(value);
}

function translatedForms(value) {
    const raw = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const forms = new Set([raw]);
    for (const group of TRANSLATIONS) {
        if (group.some(variant => variant.toLowerCase().replace(/ё/gu, 'е') === raw)) {
            for (const variant of group) forms.add(variant);
        }
    }
    const tokens = raw.split(/\s+/u).filter(Boolean);
    if (tokens.length) {
        let combinations = [''];
        for (const token of tokens) {
            const group = TRANSLATIONS.find(items => items.some(variant => variant.toLowerCase().replace(/ё/gu, 'е') === token));
            const options = group || [token];
            combinations = combinations.flatMap(prefix => options.map(option => `${prefix} ${option}`.trim())).slice(0, 32);
        }
        for (const combination of combinations) forms.add(combination);
    }
    return [...forms];
}

function similarity(left, right) {
    let best = 0;
    for (const leftForm of translatedForms(left)) for (const rightForm of translatedForms(right)) {
        const a = words(leftForm); const b = words(rightForm);
        if (!a.length || !b.length) continue;
        const overlap = a.filter(word => b.some(other => word === other || (Math.min([...word].length, [...other].length) >= 3 && (word.startsWith(other) || other.startsWith(word)))));
        best = Math.max(best, overlap.length / Math.min(a.length, b.length));
    }
    return best;
}

export function findVenueImportMatches(importedName, existingVenues = []) {
    const scored = [];
    for (const venue of Array.isArray(existingVenues) ? existingVenues : []) {
        const variants = [venue?.name, ...(Array.isArray(venue?.aliases) ? venue.aliases : [])].filter(Boolean);
        const score = Math.max(0, ...variants.map(value => similarity(importedName, value)));
        if (score >= 0.5) scored.push({ venue, score });
    }
    return scored.sort((left, right) => right.score - left.score || String(left.venue.name).localeCompare(String(right.venue.name), 'ru'));
}

export function normalizedVenueTokens(value) {
    return words(value);
}
