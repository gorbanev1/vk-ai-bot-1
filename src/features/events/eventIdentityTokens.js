import { isNameComparisonStopWord } from './venueNameTokens.js';

const FUNCTION_WORDS = new Set([
    'без','близ','в','во','вместо','вне','для','до','за','из','изо','из-за','из-под','к','ко','кроме','между','на','над','о','об','обо','около','от','ото','перед','по','под','при','про','ради','с','со','сквозь','среди','у','через',
    'и','а','но','или','либо','да','же','бы','быть','чтобы','что','как','когда','где','кто','это','этот','эта','эти','тот','та','те','его','ее','её','их','мы','вы','они','он','она','оно','мой','моя','мое','мои','твой','твоя','твое','твои','наш','наша','наше','наши','ваш','ваша','ваше','ваши','все','всё','только','еще','ещё','уже','так','там','тут','где','который','которая','которые','которое','если','то','же','ли',
    'the','and','or','nor','for','from','with','without','into','onto','over','under','at','in','on','to','of','a','an','is','are','am','this','that','these','those','by','as','be','been','being','was','were','it','its','their','they','we','you','your','our','but','not','if','then','than','only','just','after','before','when','where','who','whom','whose','which','what','while','although','though','because','unless','until','whether','do','does','did','doing','have','has','had','having','can','could','may','might','must','shall','should','will','would','ought','need','dare','about','across','against','along','among','around','behind','below','beneath','beside','beyond','despite','down','during','except','inside','near','off','out','outside','past','since','through','throughout','till','toward','towards','upon','via','within',
]);

export const GENERIC_EVENT_WORDS = new Set([
    'туса','тус','тусовка','вечеринка','пати','рейв','концерт','мероприятие','событие','афиша','фестиваль','фест','гиг','шоу','лайв','выступление','перформанс','презентация','дискотека','party','rave','concert','event','festival','fest','gig','show','live','performance','disco','voronezh','воронеж','vrn',
]);

const GENERIC_TITLE_QUALIFIERS = new Set([
    'год', 'года', 'лет', 'альбом', 'альбома', 'альбому', 'группы', 'группа',
    'концерт', 'выступление', 'презентация', 'тур', 'юбилейный', 'юбилейная',
    'anniversary', 'years', 'year', 'album', 'tour',
]);

// Shared contract used by every AI contour that writes an event title. Keeping
// this in one module prevents extraction, normalization, poster Vision and
// duplicate arbitration from slowly acquiring different title semantics.
export function buildEventTitleContractPrompt() {
    return [
        'КОНТРАК TITLE: поле title — только явное имя мероприятия (название события), то есть только собственное имя события, без пересказа и рекламного описания. Не добавляй в title дату, время, место, цену, жанр/формат, участников или конструкцию о том, кто где выступает.',
        'Примеры того, что нельзя помещать в title: «выступление группы X на гиге Y», «DJ-сет X на рейве», «концерт группы X в клубе», «X играет на пати». Имена артистов, групп, диджеев и ведущих указывай в participants; сам факт концерта, гиг, рейв, вечеринка и подобный формат — в eventType, tags или announcement, если такая часть предусмотрена формой ответа.',
        'Гиг/gig, рейв/rave, пати/party, туса/тусовка, вечеринка, концерт, выступление, лайв/live, шоу, фестиваль/фест, дискотека и подобные слова обычно обозначают род/формат события, а не его собственное имя. Не добавляй такое слово к уже ясному имени только ради пояснения формата: «ВОРОН-ЁЖ гиг» → title «ВОРОН-ЁЖ», если источник не подтверждает «Гиг» как часть официального названия.',
        'Но не удаляй такое слово автоматически: оно может быть частью бренда или полного имени. Оставь его, когда источник оформляет всю фразу как название — например на афише/в заголовке, в кавычках, с номером выпуска или как узнаваемое название серии: «WhattaGig?!», «What a Gig», «DANSE MACABRE PARTY VOL. 1», «ASCENSION OF THE INEFFABLE GIG», «Гигорейв», «Rave Against…». Это примеры контекста, а не безусловный список исключений.',
        'Определяй роль слова по смыслу и оформлению всей фразы: отдельное родовое слово после уже законченного имени часто является форматом; слово внутри цельного заголовка/брендовой фразы может быть частью имени. Одно лишь положение слова в начале или конце, регистр букв, близость к имени артиста или наличие слов «гиг/рейв/пати» решения не определяют. Не отрезай значимую часть официального названия и не присоединяй к нему описание формата.',
        'Сохраняй полное подтверждённое название совместного проекта, включая обе стороны X/×/х/&. Географическое слово или аббревиатура внутри имени команды не являются отдельной геометкой: например VRN PROD — цельное имя, его нельзя сокращать до PROD. Стоп-слова поиска не являются инструкцией удалять слова из отображаемого названия.',
        'Ищи явное имя мероприятия в исходном тексте и на афише: заголовок, кавычки, повторяющийся бренд серии, номер выпуска и визуально выделенное название — полезные признаки. Не принимай имя артиста, название площадки, город, лозунг или случайную строку за имя события. Не выдумывай название: если собственного имени нет, оставь title пустым.',
    ].join(' ');
}

const CYRILLIC_TO_LATIN = new Map(Object.entries({
    а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ж:'zh', з:'z', и:'i', й:'i', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
}));

function transliterate(value) {
    let output = '';
    for (const char of String(value || '')) output += CYRILLIC_TO_LATIN.get(char) ?? char;
    return output;
}

const FUNCTION_WORDS_TRANSLITERATED = new Set(
    [...FUNCTION_WORDS].map((word) => transliterate(word)),
);

function simpleStem(word) {
    let value = String(word || '').toLowerCase().replace(/ё/gu, 'е');
    const suffixes = [
        'иями','ами','ями','ого','ему','ому','ыми','ими','ая','яя','ое','ее','ые','ие','ов','ев','ам','ям','ах','ях','ом','ем','ою','ею','ую','юю','ы','и','а','я','о','е','у','ю','ь','й',
        'ing','ed','es','s',
    ];
    for (const suffix of suffixes) {
        if (value.length - suffix.length >= 3 && value.endsWith(suffix)) {
            value = value.slice(0, -suffix.length);
            break;
        }
    }
    return value;
}

export function normalizeIdentityWord(value, { dropGeneric = false, includeNumbers = false } = {}) {
    const raw = String(value || '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    if (includeNumbers && (/^\d+$/u.test(raw) || (/\p{L}/u.test(raw) && /\d/u.test(raw)))) return raw;
    if (!raw || isNameComparisonStopWord(raw) || FUNCTION_WORDS.has(raw) || FUNCTION_WORDS_TRANSLITERATED.has(raw)) return '';
    const stemmed = simpleStem(raw).replace(/[^\p{L}\p{N}]/gu, '');
    if (stemmed.length < 3 || FUNCTION_WORDS.has(stemmed) || FUNCTION_WORDS_TRANSLITERATED.has(stemmed) || /^\d+$/u.test(stemmed)) return '';
    if (dropGeneric && (GENERIC_EVENT_WORDS.has(raw) || GENERIC_EVENT_WORDS.has(stemmed))) return '';
    return stemmed;
}

export function identityTokens(value, { dropGeneric = true, includeNumbers = false } = {}) {
    const seen = new Set();
    const output = [];
    const raw = String(value || '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    for (const token of raw.split(/[^\p{L}\p{N}]+/gu)) {
        const normalized = normalizeIdentityWord(token, { dropGeneric, includeNumbers });
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
    }
    return output;
}

export function titleIdentityTokens(value) {
    return identityTokens(value, { includeNumbers: true }).filter((token) => !GENERIC_TITLE_QUALIFIERS.has(token));
}

export function transliteratedIdentityTokens(value, options = {}) {
    return identityTokens(value, options).map(transliterate);
}

export function sharedIdentityWords(left, right) {
    const b = new Set(identityTokens(right));
    return identityTokens(left).filter(token => b.has(token));
}
