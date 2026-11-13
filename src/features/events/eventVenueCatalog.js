import { venueNameTokens } from './venueNameTokens.js';

const VENUES = [
    ['Бар «Хлам»', 'ул. Плехановская, 16', ['хлам', 'xlam bar', 'xlambar']],
    ['ОНИ в баре', 'ул. Плехановская, 14', ['они в баре', 'oni bar', 'onibar']],
    ['Винзавод', 'ул. Кольцовская, 24Г', ['винзавод', 'vinzavod']],
    ['Arena Hall', 'проспект Революции, 56', ['arena hall']],
    ['Рестобар Pinta Haus', 'ул. Кольцовская, 9', ['pinta haus', 'pinta house']],
    ['AURA CLUB', 'проспект Революции, 56', ['aura club', 'aura']],
    ['Бар «Понеслось»', 'ул. Пушкинская, 5', ['понеслось', 'poneslos']],
    ['BARak O’Mama', 'проспект Революции, 35', ['barak omama', 'barak mama']],
    ['Цензура Бар', 'проспект Революции, 39', ['цензура', 'cenzura']],
    ['Нарядный', 'проспект Революции, 38', ['нарядный', 'naryadny']],
    ['Коммуна', 'проспект Революции, 39', ['коммуна', 'kommuna']],
    ['Площадка 1900', 'ул. Кольцовская, 24Ж', ['площадка 1900', 'rest1900']],
    ['Balagan City', 'ул. Кольцовская, 35, ТЦ «Галерея Чижова», 4-й этаж', ['balagan city', 'балаган сити']],
    ['Литера BAR', 'проспект Революции, 53', ['литера bar', 'литера бар', 'literabar']],
    ['Коптильня', 'ул. Кольцовская, 24К', ['коптильня', 'koptilnya']],
    ['Лекторий «Живой Контакт»', '', ['живой контакт', 'zhivoikontakt', 'zhivoi kontakt']],
    ['Котельная', 'ул. 20-летия Октября, 75А', ['котельная', 'kotelnaya']],
    ['Diesel Bar', 'ул. Генерала Лизюкова, 4', ['diesel bar', 'дизель бар', 'rock bar diesel', 'rock bar dizel']],
    ['Diesel Hall', 'ул. Генерала Лизюкова, 4', ['diesel hall', 'дизель холл', 'diesel zal', 'дизель зал']],
    ['Бар Overlock', 'ул. Пушкинская, 5', ['overlock', 'оверлок']],
    ['Liverpool Pub', 'ул. Куколкина, 33А/2', ['liverpool pub', 'ливерпуль паб', 'ливерпуль']],
    ['Артель «Чайка»', 'ул. Генерала Лизюкова, 4', ['артель чайка', 'чайка артель']],
    ['Культурное пространство «Башня»', 'ул. Кольцовская, 24К', ['культурное пространство башня', 'башня', 'bashnya']],
    ['Berserk Bar', 'Московский проспект, 93, корп. 2', ['berserk bar', 'berserk']],
    ['Бар «Тупик»', 'проспект Революции, 31А', ['тупик', 'tupik']],
    ['Рок-паб «Мама Анархия»', 'ул. Платонова, 25', ['мама анархия', 'mama anarchy']],
    ['Митбоулинг Клуб', 'ул. Пушкинская, 11Б', ['митбоулинг', 'meet bowling']],
    ['Рок-бар The Last of Vavilone', 'ул. Кирова, 5', ['рок бар the last of vavilone', 'the last of vavilone', 'the last of vavilon', 'ласт оф вавилоне', 'vavilone', 'vavilon']],
    ['Клуб «12»', 'ул. Космонавта Комарова, 1А', ['клуб 12', 'club 12', '12bpg']],
    ['Клуб «Сто Ручьёв»', 'ул. Кирова, 5', ['клуб сто ручьев', 'сто ручьев', '100 ruchev', 'storuvrn']],
];

// Official venue publishers used for the venue-name link in event cards.
// Keep VK and Telegram destinations separate because cards render on both platforms.
const VENUE_PUBLISHERS = {
    'Бар «Хлам»': { vk: 'https://vk.com/xlambar', telegram: 'https://t.me/xlam_bar' },
    'ОНИ в баре': { vk: 'https://vk.com/onibar', telegram: 'https://t.me/onibarvrn' },
    'Винзавод': { vk: 'https://vk.com/vinzavodpro', telegram: 'https://t.me/vinzavodproo' },
    'Arena Hall': { vk: 'https://vk.com/arena_voronez', telegram: 'https://t.me/arena_hall_vrn' },
    'Рестобар Pinta Haus': { vk: 'https://vk.com/pinta_haus', telegram: 'https://t.me/pintahausvrn' },
    'AURA CLUB': { vk: 'https://vk.com/auravrn', telegram: 'https://t.me/auraclubvrn' },
    'Бар «Понеслось»': { vk: 'https://vk.com/poneslosbar_vrn', telegram: 'https://t.me/poneslosbar_vrn' },
    'BARak O’Mama': { vk: 'https://vk.com/barakomama', telegram: 'https://t.me/barak_omama' },
    'Цензура Бар': { vk: 'https://vk.com/cenzura_bar', telegram: 'https://t.me/cenzurabar' },
    'Нарядный': { vk: 'https://vk.com/naryadny.rest', telegram: 'https://t.me/naryadnyrest' },
    'Коммуна': { vk: 'https://vk.com/kommunavrn', telegram: 'https://t.me/kommunavrn' },
    'Площадка 1900': { vk: 'https://vk.com/rest1900', telegram: '' },
    'Balagan City': { vk: 'https://vk.com/balagan.city', telegram: 'https://t.me/+_ITgIS9HEpVlMjIy' },
    'Литера BAR': { vk: 'https://vk.com/literabar', telegram: 'https://t.me/literabar' },
    'Коптильня': { vk: 'https://vk.com/koptilnyarest', telegram: '' },
    'Лекторий «Живой Контакт»': { vk: 'https://vk.com/zhivoikontakt_vrn', telegram: '' },
    'Котельная': { vk: 'https://vk.com/kotelnaya_inc', telegram: 'https://t.me/kotelnaya_inc' },
    'Diesel Bar': { vk: 'https://vk.com/rb_diesel', telegram: 'https://t.me/rb_diesel' },
    'Diesel Hall': { vk: 'https://vk.com/rb_diesel', telegram: 'https://t.me/rb_diesel' },
    'Бар Overlock': { vk: 'https://vk.com/overlockbar', telegram: 'https://t.me/overlock_bar' },
    'Liverpool Pub': { vk: 'https://vk.com/liverpool_pub_vrn', telegram: 'https://t.me/liverpoolgerold' },
    'Артель «Чайка»': { vk: 'https://vk.com/artartelchaika', telegram: 'https://t.me/art_chayka' },
    'Культурное пространство «Башня»': { vk: 'https://vk.com/bashnyakult', telegram: '' },
    'Berserk Bar': { vk: 'https://vk.com/berserk_bar', telegram: 'https://t.me/berserkbar' },
    'Бар «Тупик»': { vk: 'https://vk.com/deadway36', telegram: 'https://t.me/tupikbar' },
    'Рок-паб «Мама Анархия»': { vk: 'https://vk.com/idmamaanarchy', telegram: 'https://t.me/rokpab' },
    'Митбоулинг Клуб': { vk: 'https://vk.com/meetbowling.club', telegram: 'https://t.me/meetbowling_club' },
    'Рок-бар The Last of Vavilone': { vk: 'https://vk.com/vavilone_rb', telegram: '' },
    'Клуб «12»': { vk: 'https://vk.com/12bpg', telegram: '' },
    'Клуб «Сто Ручьёв»': { vk: 'https://vk.com/storuvrn', telegram: '' },
};

const IMPORTED_VENUE_RECORDS = new Map();
const VENUE_TRANSLATIONS = [
    ['Diesel', 'Дизель'], ['Diesel Hall', 'Дизель Холл'], ['Diesel Bar', 'Дизель Бар'],
    ['Berserk', 'Берсерк'], ['Liverpool', 'Ливерпуль'], ['Overlock', 'Оверлок'],
    ['Mama Anarchia', 'Mama Anarchy', 'Мама Анархия'],
    ['The Last of Vavilone', 'Последний Вавилон', 'Ласт оф Вавилоне'],
    ['Tower', 'Башня'], ['Seagull', 'Чайка'],
];

function translatedVenueAliases(name) {
    const key = String(name ?? '').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const padded = ` ${key} `;
    const matchingGroups = VENUE_TRANSLATIONS.map(group => ({ group, length: Math.max(0, ...group.map(value => {
        const normalized = value.toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        return normalized && (normalized === key || padded.includes(` ${normalized} `)) ? normalized.length : 0;
    })) })).filter(item => item.length > 0);
    const bestLength = Math.max(0, ...matchingGroups.map(item => item.length));
    return matchingGroups.filter(item => item.length === bestLength).flatMap(item => item.group);
}

export function mergeImportedEventVenues(records = []) {
    let added = 0;
    let updated = 0;
    for (const record of Array.isArray(records) ? records : []) {
        const id = String(record?.id || '').trim();
        const name = String(record?.name || '').replace(/\s+/gu, ' ').trim();
        if (!id || !name) continue;
        const prior = IMPORTED_VENUE_RECORDS.get(id);
        const previousName = String(record?.previousName || prior?.name || '').trim();
        const oldName = String(prior?.name || previousName || name).trim();
        const oldAddress = String(prior?.address || '').trim();
        const incomingAddress = String(record?.address || '').trim();
        const next = {
            ...prior,
            ...record,
            id, name: record?.replaceExistingName === true ? name : (prior?.name || name),
            address: !prior ? incomingAddress : record?.replaceExistingAddress === true || !oldAddress ? (incomingAddress || oldAddress) : oldAddress,
            aliases: [...new Set([...(prior?.aliases || []), ...(Array.isArray(record?.aliases) ? record.aliases : []), oldName, name].map(value => String(value || '').trim()).filter(Boolean))],
            vkUrl: String(prior?.vkUrl || record?.vkUrl || '').trim(),
            telegramUrl: String(prior?.telegramUrl || record?.telegramUrl || '').trim(),
            websiteUrl: String(prior?.websiteUrl || record?.websiteUrl || '').trim(),
            sourcePool: String(record?.sourcePool || prior?.sourcePool || '').trim(),
        };
        if (!prior) added += 1; else updated += 1;
        IMPORTED_VENUE_RECORDS.set(id, next);
        const nameKey = next.name.toLowerCase();
        let existingIndex = VENUES.findIndex(([venueName]) => venueName.toLowerCase() === oldName.toLowerCase());
        if (existingIndex < 0) existingIndex = VENUES.findIndex(([venueName]) => venueName.toLowerCase() === nameKey);
        if (existingIndex >= 0) VENUES[existingIndex] = [next.name, next.address, next.aliases];
        else VENUES.push([next.name, next.address, next.aliases]);
        const chooseNew = (oldValue, newValue) => oldValue || newValue || '';
        const oldPublisher = VENUE_PUBLISHERS[oldName] || VENUE_PUBLISHERS[next.name] || {};
        const nextPublisher = {
            vk: chooseNew(oldPublisher.vk, next.vkUrl),
            telegram: chooseNew(oldPublisher.telegram, next.telegramUrl),
            website: chooseNew(oldPublisher.website, next.websiteUrl),
        };
        if (oldName !== next.name) delete VENUE_PUBLISHERS[oldName];
        VENUE_PUBLISHERS[next.name] = nextPublisher;
        delete next.replaceExistingName;
        delete next.replaceExistingAddress;
        delete next.previousName;
        IMPORTED_VENUE_RECORDS.set(id, next);
    }
    return { added, updated };
}

export function getImportedEventVenueRecords() {
    return [...IMPORTED_VENUE_RECORDS.values()].map(record => ({ ...record, aliases: [...record.aliases] }));
}

export function getEventVenuePublisherRecords() {
    return VENUES.map(([name, address, aliases = []]) => ({
        id: `venue:${name.toLowerCase()}`, name, address, aliases: [...aliases],
        ...(VENUE_PUBLISHERS[name] || {}),
        vkUrl: VENUE_PUBLISHERS[name]?.vk || '',
        telegramUrl: VENUE_PUBLISHERS[name]?.telegram || '',
        websiteUrl: VENUE_PUBLISHERS[name]?.website || '',
    }));
}

export function getEventVenueImportRecords() {
    return VENUES.map(([name, address, aliases = []]) => {
        const imported = [...IMPORTED_VENUE_RECORDS.values()].find(record => String(record.name).toLowerCase() === name.toLowerCase());
        return ({
        id: `venue:${name.toLowerCase()}`, name, address, aliases: [...aliases],
        vkUrl: VENUE_PUBLISHERS[name]?.vk || '',
        telegramUrl: VENUE_PUBLISHERS[name]?.telegram || '',
        websiteUrl: VENUE_PUBLISHERS[name]?.website || '',
        sourcePool: imported?.sourcePool || '',
    });
    });
}

export function addEventVenueImportAliases(records = []) {
    let addedAliases = 0;
    for (const record of Array.isArray(records) ? records : []) {
        const name = String(record?.name || '').trim();
        let index = VENUES.findIndex(([venueName]) => venueName.toLowerCase() === name.toLowerCase());
        if (index < 0) index = VENUES.findIndex(([venueName, , aliases = []]) =>
            [venueName, ...aliases].some(alias => (record.aliases || []).some(saved =>
                String(alias).toLowerCase() === String(saved).toLowerCase())));
        if (index < 0) {
            VENUES.push([name, String(record.address || '').trim(), [...new Set([name, ...(record.aliases || [])])]]);
            VENUE_PUBLISHERS[name] = { vk: record.vkUrl || '', telegram: record.telegramUrl || '', website: record.websiteUrl || '' };
            continue;
        }
        const [canonicalName, address, aliases = []] = VENUES[index];
        const nextAliases = [...new Set([...aliases, ...(record.aliases || [])].map(value => String(value || '').trim()).filter(Boolean))];
        addedAliases += nextAliases.length - aliases.length;
        VENUES[index] = [name, String(record.address || address || ''), nextAliases];
        const prior = VENUE_PUBLISHERS[canonicalName] || {};
        const publisher = {
            vk: prior.vk || record.vkUrl || '', telegram: prior.telegram || record.telegramUrl || '', website: prior.website || record.websiteUrl || '',
        };
        if (canonicalName !== name) delete VENUE_PUBLISHERS[canonicalName];
        VENUE_PUBLISHERS[name] = publisher;
    }
    return { addedAliases };
}

export function upsertEventVenueImportRecord(record = {}) {
    const name = String(record?.name || '').trim();
    if (!name) return false;
    let index = VENUES.findIndex(([venueName]) => venueName.toLowerCase() === name.toLowerCase());
    if (index < 0) {
        const aliases = [...new Set([name, ...(record.aliases || [])].map(value => String(value || '').trim()).filter(Boolean))];
        VENUES.push([name, String(record.address || '').trim(), aliases]);
    } else {
        const [storedName, storedAddress, storedAliases = []] = VENUES[index];
        VENUES[index] = [storedName, String(record.address || storedAddress || '').trim(), [...new Set([...storedAliases, ...(record.aliases || []), name].map(value => String(value || '').trim()).filter(Boolean))]];
    }
    const prior = VENUE_PUBLISHERS[name] || {};
    VENUE_PUBLISHERS[name] = {
        vk: prior.vk || String(record.vkUrl || '').trim(),
        telegram: prior.telegram || String(record.telegramUrl || '').trim(),
        website: prior.website || String(record.websiteUrl || '').trim(),
    };
    return true;
}

const TRANSLIT = new Map(Object.entries({
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
}));
const GENERIC = new Set(['the','bar','pub','club','rock','hall','zal','place','venue','ploshchadka','kafe','restaurant','prostranstvo','kulturnoe','artel','klub','parking','parkovka','parkovki','gorod','voronezh','бар','паб','клуб','рок','холл','зал','площадка','пространство','культурное','артель','парковка','парковки','город','воронеж']);
const STREET = new Map([['улица','ul'],['ул','ul'],['проспект','prospekt'],['просп','prospekt'],['пр','prospekt'],['переулок','per'],['пер','per'],['набережная','nab'],['наб','nab'],['корпус','korp'],['корп','korp'],['к','korp'],['дом','d'],['д','d']]);
const STREET_PATTERN = /(?:^|[^\p{L}\p{N}])((?:ул(?:ица)?\.?|просп(?:ект)?\.?|пр-?т|переулок|пер\.?|набережная|наб\.?))/iu;

function findStreetStart(value) {
    const match = String(value ?? '').match(STREET_PATTERN);
    return match ? match.index + match[0].length - match[1].length : -1;
}

function tokenize(value, { address = false } = {}) {
    let text = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu,'е');
    text = text.replace(/(?:diesel|дизел)/gu, ' diesel ').replace(/(?:hall|холл|зал)/gu,' hall ');
    const raw = text.match(/[\p{L}\p{N}]+/gu) || [];
    const words = raw.map((word) => {
        if (address && STREET.has(word)) return STREET.get(word);
        return [...word].map((char) => TRANSLIT.get(char) ?? char).join('');
    });
    return address ? words.filter(Boolean) : venueNameTokens(value);
}

function dieselSpace(value) {
    const tokens = tokenize(value, { address: true });
    if (!tokens.includes('diesel')) return '';
    if (tokens.some((token) => ['hall','zal'].includes(token))) return 'hall';
    if (tokens.some((token) => ['bar','pub'].includes(token))) return 'bar';
    return '';
}

function similarity(left, right) {
    if (dieselSpace(left) && dieselSpace(right) && dieselSpace(left) !== dieselSpace(right)) return 0;
    const a = tokenize(left); const b = tokenize(right);
    if (!a.length || !b.length) return 0;
    const overlap = a.filter((token) => b.includes(token)).length;
    const coverage = overlap / Math.min(a.length, b.length);
    const containsSequence = (haystack, needle) => {
        if (needle.length > haystack.length) return false;
        return haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));
    };
    if (containsSequence(a, b) && a[0] === b[0]) return 1;
    if (b.length === 1 && a[0] !== b[0]) return 0;
    return coverage;
}

function extractAddress(value, venueName = '', aliases = []) {
    let text = String(value ?? '');
    for (const phrase of [venueName, ...aliases].sort((left, right) => right.length - left.length)) {
        if (!phrase) continue;
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        text = text.replace(new RegExp(escaped, 'giu'), ' ');
    }
    const streetStart = findStreetStart(text);
    if (streetStart >= 0) {
        const segmentStart = Math.max(text.lastIndexOf(',', streetStart - 1), text.lastIndexOf(';', streetStart - 1), text.lastIndexOf('|', streetStart - 1)) + 1;
        const suffix = text.slice(segmentStart).split(/[;|]/u, 1)[0];
        const houses = [...suffix.matchAll(/\d+[а-яa-z]*(?:\s*\/\s*\d+[а-яa-z]*)?/giu)];
        const house = houses.at(-1);
        if (house) {
            const end = house.index + house[0].length;
            const tail = suffix.slice(end);
            const unit = tail.match(/^\s*,?\s*(?:корп(?:ус)?\.?|к\.)\s*\d+[а-яa-z]*/iu)?.[0] || '';
            return suffix.slice(0, end).trim().replace(/[,\s]+$/u, '') + unit.trim();
        }
    }
    const commaSeparatedAddress = text.match(/(?:^|[,;|])\s*([^,;|]{2,60})\s*,\s*(\d+[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?)(?:\s*(?:[,;|]|$))/iu);
    if (commaSeparatedAddress) return `${commaSeparatedAddress[1].trim()}, ${commaSeparatedAddress[2].replace(/\s+/gu, '')}`;
    const house = text.match(/(?:^|[,\s])((?:[\p{L}.-]+\s+){1,5}\d+[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?)(?=$|[,;])/iu);
    return house?.[1]?.trim() || '';
}

function addressMatches(left, right, { allowNearMatch = false } = {}) {
    if (!left || !right) return true;
    const normalizeFullAddress = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
        .replace(/(?:улица|ул)\.?/gu, ' ul ').replace(/(?:проспект|просп|пр-?т|пр)\.?/gu, ' prospekt ')
        .replace(/(?:переулок|пер)\.?/gu, ' per ').replace(/(?:корпус|корп)\.?/gu, ' korp ')
        .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
        .split(' ').map(word => [...word].map(char => TRANSLIT.get(char) ?? char).join('')).join(' ');
    const normalizedLeft = normalizeFullAddress(left);
    const normalizedRight = normalizeFullAddress(right);
    if (normalizedLeft && normalizedLeft === normalizedRight) return true;
    const mainStreetHouse = (value) => {
        const source = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
        const start = findStreetStart(source);
        const tail = source.slice(Math.max(0, start));
        const match = /,\s*(\d+[а-яa-z]?)(?:\s*\/\s*(\d+[а-яa-z]?))?/iu.exec(tail);
        if (!match) return null;
        const street = tokenize(tail.slice(0, match.index), { address: true })
            .filter(token => !['ul', 'prospekt', 'per', 'nab', 'd', 'korp'].includes(token) && !/^\d+$/u.test(token))
            .map(token => token.replace(/(?:skaya|skaia|skoi|skoy|skogo|skomu|skuyu)$/u, '').replace(/a$/u, ''));
        return street.length ? { street, house: match[1].replace(/\s+/gu, '').toLowerCase(), suffix: String(match[2] || '').replace(/\s+/gu, '').toLowerCase() } : null;
    };
    const editSimilarity = (a, b) => {
        if (!a || !b) return 0;
        let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i += 1) {
            const current = [i];
            for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
        return 1 - previous[b.length] / Math.max(a.length, b.length);
    };
    if (allowNearMatch) {
        const leftMain = mainStreetHouse(left);
        const rightMain = mainStreetHouse(right);
        if (leftMain && rightMain) {
            const overlap = leftMain.street.filter(token => rightMain.street.includes(token)).length;
            const sameStreet = overlap / Math.min(leftMain.street.length, rightMain.street.length) >= 0.75;
            if (!sameStreet || leftMain.house !== rightMain.house) return false;
            return !leftMain.suffix || !rightMain.suffix || leftMain.suffix === rightMain.suffix;
        }
        const houseNumber = value => String(value ?? '').match(/(?:^|[,\s])(\d+[а-яa-z]?)(?:\s*\/\s*(\d+[а-яa-z]?))?(?=$|[,\s])/iu);
        const leftHouse = houseNumber(left); const rightHouse = houseNumber(right);
        if (leftHouse && rightHouse) {
            if (leftHouse[1].toLowerCase() !== rightHouse[1].toLowerCase()) return false;
            if (leftHouse[2] && rightHouse[2] && leftHouse[2].toLowerCase() !== rightHouse[2].toLowerCase()) return false;
            const leftStem = normalizeFullAddress(left).replace(/\d+[а-яa-z]?\d*$/u, '');
            const rightStem = normalizeFullAddress(right).replace(/\d+[а-яa-z]?\d*$/u, '');
            if (leftStem === rightStem && (leftHouse[2] || rightHouse[2])) return true;
            // Distinct house numbers remain distinct even when a long street
            // name would make whole-string edit similarity exceed 90%.
            return false;
        }
        if (editSimilarity(normalizeFullAddress(left), normalizeFullAddress(right)) >= 0.9) return true;
    }
    const parse = (value) => {
        let source = String(value ?? '').toLowerCase().replace(/ё/gu, 'е');
        const corpusMatch = source.match(/(?:,|\s)(?:корп(?:ус)?\.?|к\.)\s*(\d+[а-яa-z]?)/iu);
        source = source.replace(/(?:,|\s)(?:корп(?:ус)?\.?|к\.)\s*\d+[а-яa-z]?/iu, '');
        const houseMatches = [...source.matchAll(/(?:^|[,\s])((?:\d+[а-яa-z]?)(?:\s*\/\s*\d+[а-яa-z]?)?)(?=\s*(?:,|$))/giu)];
        const houseMatch = houseMatches.at(-1);
        if (!houseMatch) return null;
        const rawHouse = houseMatch[1].replace(/\s+/gu, '').toLowerCase();
        const [house, slashSuffix] = rawHouse.split('/', 2);
        const streetStart = findStreetStart(source);
        const segmentStart = streetStart < 0 ? 0 : Math.max(source.lastIndexOf(',', streetStart - 1), source.lastIndexOf(';', streetStart - 1), source.lastIndexOf('|', streetStart - 1)) + 1;
        const houseOffset = houseMatch.index + houseMatch[0].indexOf(houseMatch[1]);
        const streetSource = source.slice(segmentStart, houseOffset);
        const street = tokenize(streetSource, { address: true })
            .filter((token) => !['ul', 'prospekt', 'per', 'nab', 'd', 'korp'].includes(token))
            .map((token) => token.replace(/(?:skaya|skaia|skoi|skoy|skogo|skomu|skuyu)$/u, '').replace(/a$/u, ''));
        return { street, house, suffix: [slashSuffix, corpusMatch?.[1]?.toLowerCase()].filter(Boolean) };
    };
    const a = parse(left); const b = parse(right);
    if (!a || !b || !a.house || !b.house || a.house !== b.house) return false;
    if (a.suffix.join(' ') !== b.suffix.join(' ')) return false;
    if (!a.street.length || !b.street.length) return false;
    const overlap = a.street.filter((token) => b.street.includes(token)).length;
    return overlap / Math.min(a.street.length, b.street.length) >= 0.75;
}

export function canonicalizeEventVenue(value, { allowNearAddressMatch = false } = {}) {
    const raw = String(value ?? '').replace(/\s+/gu, ' ').trim();
    if (!raw) return { venue: '', matched: false };
    const existingMismatchMatch = raw.match(/\s*❓\(([^)]{1,180})\)❓/u);
    const existingMismatch = existingMismatchMatch?.[0] || '';
    const existingMismatchAddress = existingMismatchMatch?.[1]?.trim() || '';
    const source = raw.replace(/\s*❓\(([^)]{1,180})\)❓/u, '').trim();
    const commaParts = source.split(/[,;|]/u).map((part) => part.trim()).filter(Boolean);
    const streetStart = findStreetStart(source);
    let nameInput = streetStart >= 0 ? source.slice(0, streetStart).trim() : source;
    if (streetStart < 0 && commaParts.length > 1) {
        const nameParts = [...commaParts];
        const lastPart = nameParts.at(-1) || '';
        if (/^\d+[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?$/iu.test(lastPart) && nameParts.length >= 3) {
            nameParts.splice(-2, 2);
        }
        const cityIndex = nameParts.findIndex((part) => /^(?:г\.?\s*)?воронеж$/iu.test(part));
        if (cityIndex >= 0) nameParts.splice(cityIndex);
        if (nameParts.length) nameInput = nameParts.join(' ');
    }
    nameInput = nameInput.replace(/^[,;|\s]*(?:г\.?\s*)?воронеж\s*[,;|]+/iu, '').trim();
    nameInput = nameInput.replace(/[,;|\s]+(?:г\.?\s*)?воронеж\s*$/iu, '').trim();
    if (!nameInput) nameInput = source;
    // Long comma-separated lists are not a reliable identification of one
    // place: a matching name may appear only as one of many unrelated items.
    const hasCommaSeparatedHouse = commaParts.length >= 2 && /^\d+[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?$/iu.test(commaParts.at(-1) || '');
    if (commaParts.length > 3 && streetStart < 0 && !hasCommaSeparatedHouse) {
        return { venue: raw, matched: false };
    }
    const nameTokens = tokenize(nameInput);
    const bareNumericAlias = /^\d+$/u.test(nameInput);
    if (bareNumericAlias) return { venue: raw, matched: false };
    const fullNameKey = value => tokenize(value, { address: true }).join(' ');
    const exactNames = VENUES.filter(([name, , aliases]) => [name, ...aliases].some(alias => fullNameKey(alias) === fullNameKey(nameInput)));
    const exactName = exactNames.length === 1 ? exactNames[0][0] : '';
    const candidates = VENUES.map(([name, address, aliases]) => ({
        name, address, aliases,
        score: name === exactName ? 2 : dieselSpace(nameInput) && dieselSpace(name) && dieselSpace(nameInput) !== dieselSpace(name)
            ? 0
            : Math.max(similarity(nameInput, name), ...[...aliases, ...translatedVenueAliases(name)].map((alias) => similarity(nameInput, alias))),
    })).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates[1];
    if (!best || (!nameTokens.length && !exactName) || best.score < 0.78 || (second && best.score - second.score < 0.12)) return { venue: raw, matched: false };
    const suppliedAddress = extractAddress(source, best.name, best.aliases);
    const venue = best.address
        ? `${best.name}, ${best.address}${suppliedAddress && !addressMatches(suppliedAddress, best.address, { allowNearMatch: allowNearAddressMatch }) ? ` ❓(${suppliedAddress})❓` : existingMismatchAddress && !addressMatches(existingMismatchAddress, best.address, { allowNearMatch: allowNearAddressMatch }) ? existingMismatch : ''}`
        : `${best.name}${suppliedAddress ? ` ❓(${suppliedAddress})❓` : existingMismatch}`;
    return { venue, matched: true, canonicalName: best.name, canonicalAddress: best.address, suppliedAddress, addressMatched: !suppliedAddress || addressMatches(suppliedAddress, best.address, { allowNearMatch: allowNearAddressMatch }) };
}

export function getCanonicalVenuePublisherUrl(value, platform = 'vk') {
    const canonicalName = canonicalizeEventVenue(value).canonicalName;
    if (!canonicalName) return '';
    const normalizedPlatform = String(platform ?? '').trim().toLowerCase();
    const channel = normalizedPlatform === 'telegram' || normalizedPlatform === 'tg' ? 'telegram' : 'vk';
    const publisher = VENUE_PUBLISHERS[canonicalName] || {};
    const vk = /^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//iu.test(publisher.vk || '') ? publisher.vk : '';
    if (channel === 'vk') return vk;
    const telegram = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//iu.test(publisher.telegram || '') ? publisher.telegram : '';
    const website = /^https?:\/\//iu.test(publisher.website || '') ? publisher.website : '';
    return telegram || vk || website;
}

export function canonicalEventVenues() {
    return VENUES.map(([name, address]) => ({ name, address }));
}
