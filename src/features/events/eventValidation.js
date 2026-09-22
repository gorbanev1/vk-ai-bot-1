import { isCalendarIsoDate } from './publicPostDateEvidence.js';

/**
 * Строгая граница качества событий: одновременно требуются понятная суть, дата и конкретное место.
 */
const UNCERTAIN_EVENT_PATTERN = /(?:уточняется|неизвестно|не\s+указан|не\s+указано|не\s+удалось|нельзя\s+однозначно|не\s+может\s+быть\s+надежно|не\s+содержит\s+явного\s+анонса|обычная\s+ссылка|не\s+является\s+мероприятием)/iu;
const EVENT_ESSENCE_PATTERN = /(?:концерт|вечерин|тус(?:а|овк)|гиг|фест|фестиваль|дегустац|выступ|спектакл|лекци|мастер[- ]?класс|встреч|шоу|показ|кинопоказ|презентаци|турнир|джем|квиз|маркет|ярмарк|событи|мероприяти|открыти|воркшоп|семинар|дискотек|рейв|сейшн|вечер|трибьют|tribute|\blive\b|\bтур\b)/iu;
const PLACE_HINT_PATTERN = /(?:клуб|бар|ресторан|кафе|зал|театр|площадк|пространств|адрес|ул\.|улиц|проспект|наб\.|набережн|дом\s+\d|воронеж|москва|санкт[- ]?петербург|онлайн|zoom|telegram|vk\s+live)/iu;
// Source evidence must contain a semantic calendar date. Dot-delimited
// numeric form is the only compact numeric form accepted here; slash/hyphen
// fragments such as 19-00 or 20-09 are clock/identifier syntax and must not
// satisfy the date gate. ISO dates are internal normalized values, not raw
// VK/OCR evidence, so they are intentionally excluded as well.
const SOURCE_DATE_HINT_PATTERN = /(?:\d{1,2}\.\d{1,2}(?:\.\d{2,4})?|\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)|сегодня|завтра|послезавтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея])/iu;
const GENERIC_VENUE_WORDS = new Set(['клуб', 'бар', 'ресторан', 'кафе', 'зал', 'театр', 'площадка', 'пространство', 'адрес', 'улица', 'проспект', 'набережная', 'дом', 'город', 'онлайн', 'воронеж', 'москва']);
const STRUCTURED_EVENT_DATE_LABEL_PATTERN = /^(?:когда|дата)\s*(?::|;|：|[—–-])\s*.+$/imu;
const STRUCTURED_EVENT_VENUE_LABEL_PATTERN = /^(?:где|место|адрес|площадка)\s*(?::|;|：|[—–-])\s*.+$/imu;
const STRUCTURED_EVENT_DETAIL_LABEL_PATTERN = /^(?:кто|участники|лайн-?ап|line[ -]?up|что|название|мероприятие|событие|поч[её]м|цена|стоимость|вход|билеты?|время|начало|старт|двери)\s*(?::|;|：|[—–-])\s*.+$/imu;

function cleanEventField(value, limit = 1000) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, limit);
}

function isIsoDate(value) {
    return isCalendarIsoDate(value);
}

function normalizeComparableText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function sourceSupportsVenue(venue, sourceText) {
    const normalizedVenue = normalizeComparableText(venue);
    const normalizedSource = normalizeComparableText(sourceText);

    if (!normalizedVenue || !normalizedSource) {
        return false;
    }

    if (normalizedSource.includes(normalizedVenue)) {
        return true;
    }

    const distinctiveTokens = normalizedVenue
        .split(' ')
        .filter((token) => (
            token.length >= 4 &&
            !GENERIC_VENUE_WORDS.has(token)
        ));

    if (distinctiveTokens.length) {
        return distinctiveTokens.some((token) => {
            const stem = token.slice(0, Math.max(4, token.length - 2));
            return normalizedSource.includes(token) || normalizedSource.includes(stem);
        });
    }

    const numericTokens = normalizedVenue.match(/\d+[a-zа-я]?/giu) ?? [];
    if (numericTokens.some((token) => normalizedSource.includes(token))) return true;

    // Short proper names are common in Russian venue names: «Клуб X», «Бар Z».
    // Exact phrase matching fails after declension («в клубе X»), while the old
    // distinctive-token rule discarded one-character names. Require both the
    // same generic venue type in an inflected form and the same short token.
    const venueTokens = normalizedVenue.split(' ').filter(Boolean);
    if (venueTokens.length >= 2 && /^(?:клуб|бар|паб|зал|кафе)$/u.test(venueTokens[0])) {
        const shortProper = venueTokens.slice(1).find((token) => /^[a-zа-я0-9]{1,3}$/iu.test(token));
        const genericStem = venueTokens[0].slice(0, Math.max(3, venueTokens[0].length - 1));
        if (shortProper && normalizedSource.includes(genericStem)) {
            const sourceTokens = new Set(normalizedSource.split(' ').filter(Boolean));
            if (sourceTokens.has(shortProper)) return true;
        }
    }

    return false;
}

function normalizeEvidenceText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/ /gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function sourceContainsEvidence(evidence, sourceText) {
    const raw = normalizeEvidenceText(sourceText);
    const snippets = String(evidence ?? '')
        .split(/\s*\|\|\s*|\n+/u)
        .map((value) => String(value || '').trim()
            .replace(/^[\s"'«„“]+/u, '')
            .replace(/[\s"'»”]+$/u, '')
            .trim())
        .map(normalizeEvidenceText)
        .filter(Boolean)
        .slice(0, 5);

    return Boolean(
        raw &&
        snippets.length &&
        snippets.every((snippet) => raw.includes(snippet))
    );
}

function explainStrictEventRecord(event, {
    sourceText = '',
    requireEvidence = false,
    requireVenue = true,
} = {}) {
    const title = cleanEventField(event?.title ?? event?.name, 500);
    const eventDate = cleanEventField(event?.eventDate ?? event?.date, 20);
    const venue = cleanEventField(event?.venue ?? event?.place, 500);
    const description = cleanEventField(
        event?.description ?? event?.announcement,
        5000,
    );
    const evidence = cleanEventField(event?.evidence, 1000);
    const combined = [title, description, evidence, sourceText]
        .filter(Boolean)
        .join(' ');

    if (!title || title.length < 3) {
        return { ok: false, reason: 'missing-or-short-title' };
    }
    if (!isIsoDate(eventDate)) {
        return { ok: false, reason: 'invalid-or-missing-event-date' };
    }
    if (requireVenue && !venue) {
        return { ok: false, reason: 'missing-venue' };
    }

    if (UNCERTAIN_EVENT_PATTERN.test([title, venue, description].join(' '))) {
        return { ok: false, reason: 'uncertain-placeholder-language' };
    }

    const source = String(sourceText ?? '');
    const hasStructuredEventEvidence = Boolean(
        source &&
        STRUCTURED_EVENT_DATE_LABEL_PATTERN.test(source) &&
        STRUCTURED_EVENT_VENUE_LABEL_PATTERN.test(source) &&
        STRUCTURED_EVENT_DETAIL_LABEL_PATTERN.test(source)
    );

    if (!EVENT_ESSENCE_PATTERN.test(combined) && !hasStructuredEventEvidence) {
        return { ok: false, reason: 'event-essence-not-confirmed' };
    }

    if (venue && !PLACE_HINT_PATTERN.test(venue) && venue.length < 4) {
        return { ok: false, reason: 'venue-too-weak' };
    }

    if (sourceText) {
        if (!SOURCE_DATE_HINT_PATTERN.test(String(sourceText))) {
            return { ok: false, reason: 'source-has-no-date-hint' };
        }

        if (venue && !sourceSupportsVenue(venue, sourceText)) {
            return { ok: false, reason: 'venue-not-supported-by-source' };
        }
    }

    if (requireEvidence && !sourceContainsEvidence(evidence, sourceText)) {
        return { ok: false, reason: 'evidence-not-verbatim-in-source' };
    }

    return { ok: true, reason: 'accepted' };
}

function isStrictEventRecord(event, options = {}) {
    return explainStrictEventRecord(event, options).ok;
}

function filterStrictEvents(events, options = {}) {
    return (Array.isArray(events) ? events : [])
        .filter((event) => isStrictEventRecord(event, options));
}

function partitionEventsByReferenceDate(events, referenceDate) {
    const boundary = String(referenceDate ?? '').trim();
    const source = Array.isArray(events) ? events : [];

    if (!isIsoDate(boundary)) {
        return {
            futureEvents: [...source],
            pastEvents: [],
        };
    }

    return {
        futureEvents: source.filter((event) => (
            String(event?.eventDate ?? event?.date ?? '').trim() >= boundary
        )),
        pastEvents: source.filter((event) => (
            String(event?.eventDate ?? event?.date ?? '').trim() < boundary
        )),
    };
}

function buildStrictEventExtractionPrompt({
    sourceKind = 'сообщения',
    referenceDate = '',
    allowPast = false,
    requireVenue = true,
} = {}) {
    return [
        allowPast
            ? `Ты строгий извлекатель реальных мероприятий из ${sourceKind}. Распознавай также уже прошедшие события: вызывающий код отдельно решит, сохранять ли их.`
            : `Ты строгий извлекатель реальных будущих мероприятий из ${sourceKind}.`,
        referenceDate ? `Текущая дата для относительных дат: ${referenceDate}.` : '',
        requireVenue
            ? 'Верни событие только когда одновременно подтверждены три обязательных элемента:'
            : 'Верни событие, когда подтверждены суть и календарная дата; место для доверенного ручного ввода может отсутствовать.',
        '1) ясная суть события — что именно произойдёт и как оно называется;',
        '2) календарная дата самого события, а не дата публикации, дедлайна, продажи, регистрации или итогов;',
        requireVenue
            ? '3) конкретное место проведения: название площадки, адрес, город с площадкой либо явно указанная онлайн-площадка.'
            : '3) место, если оно указано; если прямо сказано, что локацию сообщат позже, сохрани эту формулировку; если сведений нет — оставь venue пустым.',
        'Одного времени сообщения, имени участника, картинки, ссылки, слова «туса» или даты публикации недостаточно.',
        'Не превращай обычную переписку, имя человека, время сообщения, рекламу товара, дедлайн предпродажи и неясный фрагмент в мероприятие.',
        requireVenue
            ? 'Если хоть один из трёх обязательных элементов отсутствует или вызывает сомнение — верни пустой список.'
            : 'Если отсутствует ясная суть или дата самого события — верни пустой список. Отсутствие времени, места, цены или участников само по себе не является причиной отклонения.',
        'Не заполняй поля словами «уточняется», «неизвестно» и не додумывай сведения.',
        'КОНТРАК КОЛИЧЕСТВА СОБЫТИЙ: сначала определи структуру всего исходного материала. Каждая различающаяся календарная дата всегда является отдельной карточкой, даже если название, площадка, участники, фестиваль или серия одинаковы. Разные даты нельзя объединять в одну календарную карточку.',
        'Если дата одна и время одно — верни одно событие. Если дата одна и указано несколько времён, решение принимает только AI: выбери structure single_event_program (одно событие с программой), multiple_events (самостоятельные события) или uncertain (недостаточно данных для безопасного решения). Не решай этот случай регулярным выражением, локальной нарезкой или Vision.',
        'Считай несколько времён программой одного события, когда это двери/начало, выступления участников, DJ-сеты или последовательные этапы общей программы с общей площадкой, ценой или единым призывом прийти. Считай времена разными событиями при отдельных названиях, ценах/условиях входа, площадках, организаторах, аудиториях, призывах прийти или явно самостоятельных частях вроде концерта и afterparty.',
        'При структуре single_event_program верни одну карточку и program_items с временными этапами. При multiple_events верни отдельный объект для каждого события с его announcement/source_segment и image_indexes. Полный исходный текст не подменяет source_segment.',
        'Поле participants: выпиши именно выступающих/артистов/DJ/группы/ведущих, в том числе из формулировок «DJs», «для вас играют», «line-up», «выступают». Не путай их с организаторами, площадкой и гостями.',
        'Поле price: сохрани явно указанную стоимость/цену билета/входа; если цены нет — оставь пустым. Поле announcement сделай коротким и пригодным для публикации, без потери подтвержденных фактов.',
        'Поле evidence должно содержать до трёх точных цитат из исходного текста, подтверждающих суть, дату и место. Если факты расположены в разных абзацах, раздели цитаты символами ||. Не перефразируй цитаты. Если подтверждений нет — верни пустой список.',
        'Верни только JSON без Markdown: {"structure":"single_event|single_event_program|multiple_events|uncertain","structure_reason":"краткое основание","events":[]} либо {"structure":"...","structure_reason":"...","events":[{"date":"YYYY-MM-DD","time":"HH:MM или null","title":"название и суть","venue":"конкретное место","participants":"участники","price":"цена","program_items":[{"time":"HH:MM","text":"этап программы"}],"announcement":"краткое описание только этого события","source_segment":"точный фрагмент только этого события","evidence":"точная цитата","image_indexes":[1]}]}.',
    ].filter(Boolean).join(' ');
}

export {
    buildStrictEventExtractionPrompt,
    cleanEventField,
    explainStrictEventRecord,
    filterStrictEvents,
    isIsoDate,
    isStrictEventRecord,
    partitionEventsByReferenceDate,
    sourceContainsEvidence,
    sourceSupportsVenue,
};
