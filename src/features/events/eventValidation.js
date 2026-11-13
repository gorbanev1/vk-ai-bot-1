import { isBroadcastEvent, BROADCAST_EXCLUSION_INSTRUCTION } from './eventBroadcastPolicy.js';
import { SHARED_SCHEDULE_INSTRUCTION, THEATER_REPERTOIRE_INSTRUCTION, getSharedEventSchedule, nextSharedEventDate } from './sharedEventSchedule.js';
import { isCalendarIsoDate, extractRawDateMentions, extractExplicitDates } from './publicPostDateEvidence.js';
import { buildEventTitleContractPrompt } from './eventIdentityTokens.js';

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
        .normalize('NFKC')
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
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function normalizeEventEvidence(value) {
    if (Array.isArray(value)) {
        if (!value.length || value.some(part => typeof part !== 'string' || !part.trim())) return '';
        return value.join(' || ');
    }
    return typeof value === 'string' ? value.trim() : '';
}

function sourceContainsEvidence(evidence, sourceText) {
    const raw = normalizeEvidenceText(sourceText);
    const snippets = normalizeEventEvidence(evidence)
        .split(/\s*\|\|\s*|\n+|\s*;\s*/u)
        .map((value) => String(value || '').trim()
            .replace(/^[\s"'«„“]+/u, '')
            .replace(/[\s"'»”]+$/u, '')
            .trim())
        .filter(Boolean);

    const matches = (snippet) => {
        if (!normalizeEvidenceText(snippet)) return false;
        // Compact AI evidence may use an ellipsis between exact fragments.
        // Match fragments in order after normalization while retaining the
        // verbatim-evidence requirement for every non-ellipsis quote.
        const fragments = snippet.split(/\s*(?:(?:\.{3}|…)+)\s*/u).map((part) => normalizeEvidenceText(part)).filter(Boolean);
        if (fragments.length <= 1) return raw.includes(normalizeEvidenceText(snippet));
        let cursor = 0;
        for (const fragment of fragments) {
            const at = raw.indexOf(fragment, cursor);
            if (at >= 0) {
                cursor = at + fragment.length;
                continue;
            }
            return false;
        }
        return true;
    };
    return Boolean(
        raw &&
        snippets.length &&
        snippets.every(matches)
    );
}

function explainStrictEventRecord(event, {
    sourceText = '',
    requireEvidence = false,
    requireVenue = true,
    trustedPosterEvent = false,
} = {}) {
    if (isBroadcastEvent(event, {sourceText})) return {ok:false,reason:'broadcast-not-event'};
    const title = cleanEventField(event?.title ?? event?.name, 500);
    const eventDate = cleanEventField(event?.eventDate ?? event?.date, 20);
    const venue = cleanEventField(event?.venue ?? event?.place, 500);
    const description = cleanEventField(
        event?.description ?? event?.announcement,
        5000,
    );
    const evidence = normalizeEventEvidence(event?.evidence);
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

    if (!trustedPosterEvent && !EVENT_ESSENCE_PATTERN.test(combined) && !hasStructuredEventEvidence) {
        return { ok: false, reason: 'event-essence-not-confirmed' };
    }

    if (venue && !PLACE_HINT_PATTERN.test(venue) && venue.length < 4) {
        return { ok: false, reason: 'venue-too-weak' };
    }

    if (sourceText && !trustedPosterEvent) {
        if (!SOURCE_DATE_HINT_PATTERN.test(String(sourceText)) && !extractRawDateMentions(sourceText).length) {
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
            (getSharedEventSchedule(event) ? Boolean(nextSharedEventDate(event, boundary)) : String(event?.eventDate ?? event?.date ?? '').trim() >= boundary)
        )),
        pastEvents: source.filter((event) => (
            (getSharedEventSchedule(event) ? !nextSharedEventDate(event, boundary) : String(event?.eventDate ?? event?.date ?? '').trim() < boundary)
        )),
    };
}

function buildStrictEventExtractionPrompt({
    sourceKind = 'сообщения',
    referenceDate = '',
    allowPast = false,
    requireVenue = true,
    confirmedPoster = false,
    sourceText = '',
    publishedAt = 0,
    timeZone = 'Europe/Moscow',
} = {}) {
    const yearInstruction = 'ГОД ДАТЫ: отсутствие напечатанного года само по себе не означает uncertain. Опора — дата публикации, а если она неизвестна — указанная опорная дата. Явный год сохраняй; без года используй год опоры, и только если день и месяц отстают от опоры более чем на 183 дня — следующий год. Не переноси недавнее прошедшее событие в будущее. Это нормализация календаря, а не решение о числе событий. Реальные противоречия дат по-прежнему требуют проверки.';
    const normalizedDates = referenceDate && sourceText ? extractExplicitDates(sourceText, publishedAt, {
        referenceNow: new Date(referenceDate + 'T12:00:00Z'), timeZone,
    }) : [];
    const calendarInstruction = [yearInstruction, normalizedDates.length
        ? 'Календарные кандидаты по тому же правилу валидатора: ' + JSON.stringify(normalizedDates) + '. Выбирай только относящиеся к самому событию; список не задаёт число карточек. Не заменяй цитату из исходника нормализованной датой.'
        : ''].filter(Boolean).join(' ');
    if (confirmedPoster) return [
        `Извлеки метаданные мероприятий из ${sourceKind}: сохранённых фактов подтверждённых афиш и дополнительного текста.`,
        referenceDate ? `Дата для относительных дат и определения года: ${referenceDate}.` : '',
        calendarInstruction,
        BROADCAST_EXCLUSION_INSTRUCTION,
        'Событие должно иметь календарную дату, название или участников и место. Не выдумывай неизвестные поля.',
        'Определи число самостоятельных мероприятий на афишах: single_event, single_event_program, shared_schedule_event, theater_repertoire или multiple_events. Двери, начало и этапы программы одного события сохраняй в program_items.',
        'Месячное расписание разных вечеров на одной площадке — multiple_events. Исключение: единый театральный репертуар одной организации/театра с разными постановками по датам — theater_repertoire, строго одна карточка во второстепенной выдаче и program_items с датой, названием, временем и точной цитатой для каждой постановки. Узнавай репертуар по заголовкам «репертуар», «афиша театра», «ноябрь в театре», названию театра/театральной площадки и общей афише. Сохрани связь каждой даты с её названием, участниками и временем; не присваивай всем датам общий список исполнителей или название последнего вечера. single_event_program допустим для этапов одного события, но не для разных вечеров месяца.',
        'Не требуй повторного подтверждения афиши текстом или точных цитат из текста. Метаданные афиши являются самостоятельным источником.',
        'Дату публикации, интерфейс, дедлайн продажи или регистрации не принимай за дату события. Если календарной даты нет ни на афише, ни в тексте, верни uncertain с причиной.',
        SHARED_SCHEDULE_INSTRUCTION,
        THEATER_REPERTOIRE_INSTRUCTION,
        buildEventTitleContractPrompt(),
        'Верни только JSON со structure, structure_reason и events. Для каждого события извлеки date, time, title, venue, participants, price, announcement, source_segment, evidence, image_indexes.',
    ].filter(Boolean).join(' ');
    return [
        allowPast
            ? `Ты строгий извлекатель реальных мероприятий из ${sourceKind}. Распознавай также уже прошедшие события: вызывающий код отдельно решит, сохранять ли их.`
            : `Ты строгий извлекатель реальных будущих мероприятий из ${sourceKind}.`,
        referenceDate ? `Текущая дата для относительных дат: ${referenceDate}.` : '',
        calendarInstruction,
        BROADCAST_EXCLUSION_INSTRUCTION,
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
        'КОНТРАК КОЛИЧЕСТВА СОБЫТИЙ: сначала определи структуру всего исходного материала, затем извлеки карточки. Это обязательный AI-этап; его нельзя заменять регулярным выражением, локальным парсером, дедупликацией или Vision.',
        'ДАТЫ И КОЛИЧЕСТВО СОБЫТИЙ: несколько дат — важный признак возможного мультианонса, но сами по себе они НЕ доказывают наличие нескольких событий. Сначала по смыслу и структуре текста реши, описана одна туса или несколько самостоятельных тус. Исправленная/ошибочная дата, повтор даты, дата в цитате, дата публикации, дата другого неанонсного действия или явно относящаяся к одному и тому же событию не создаёт новую карточку. Если текст подтверждает одно событие с одной корректной датой — верни одну карточку и эту дату; если нельзя уверенно выбрать дату или число событий — верни uncertain, не угадывай.',
        'Создавай отдельные карточки только для самостоятельных событий, каждое из которых отдельно подтверждено текстом: укажи свой точный source_segment и evidence. Не размножай карточки по каждому найденному числу или дате. Одинаковое название/площадка при повторе одного анонса также не создают новое событие.',
        'ФОРМАТЫ: календарную дату извлекай из текста/афиши, нормализуй в YYYY-MM-DD, но не принимай время или идентификатор за дату. Числовая дата подтверждается точками (например 12.09 или 12.09.2026); дефис между часами и минутами может обозначать время (18-30), двоеточие также обозначает время (18:30). Время публикации/сообщения не является временем мероприятия.',
        'ОПРЕДЕЛЕНИЕ ЧИСЛА СОБЫТИЙ: если дата одна, реши по смыслу, описывает ли текст одно событие, программу одного события или несколько самостоятельных событий. Количество дат, времён и строк само по себе не задаёт количество карточек.',
        'Выбери single_event_program, когда часы описывают двери/начало, выступления участников, DJ-сеты, этапы или последовательную программу одного общего мероприятия: общая площадка, общий билет/цена, один организатор, один призыв прийти, единый заголовок. В этом случае верни ровно одну карточку, а все часы и этапы положи в program_items; event.time — только время начала, если оно явно указано.',
        'Выбери multiple_events, когда в исходнике действительно анонсированы несколько самостоятельных событий: отдельные названия/смыслы, разные цены или условия входа, разные площадки или организаторы, разные аудитории/призывы прийти либо явно независимые части (например концерт и отдельная ночная дискотека/afterparty). Это возможно и при одной дате. Верни отдельный объект events для каждого события, с его собственной датой, временем, названием, местом, участниками, ценой, announcement, точным source_segment и evidence. Не принимай опечатку, исправление даты или ошибку в исходном посте за второй анонс.',
        'Выбери not_event и пустой events, если после чтения исходника это не анонс будущего события. Выбери uncertain только когда после проверки всех факторов невозможно безопасно решить, сколько самостоятельных событий описано, или какую из противоречивых дат считать верной. Не маскируй uncertain под single_event, single_event_program или multiple_events и не добавляй выдуманные поля; сохрани structure_reason с конкретной причиной.',
        'Время между разными постами/сообщениями не участвует в решении дубля: при объединении источников сравнивай календарную дату, название и смысл, а разное время не делай причиной создания второй карточки. Это правило относится к дедупликации источников, а не к разбору нескольких времён внутри одного материала.',
        'При структуре single_event_program верни одну карточку и program_items с временными этапами. При multiple_events верни отдельный объект для каждого события с его announcement/source_segment и image_indexes. Полный исходный текст не подменяет source_segment.',
        'Поле participants: выпиши именно выступающих/артистов/DJ/группы/ведущих, в том числе из формулировок «DJs», «для вас играют», «line-up», «выступают». Не путай их с организаторами, площадкой и гостями.',
        SHARED_SCHEDULE_INSTRUCTION,
        THEATER_REPERTOIRE_INSTRUCTION,
        buildEventTitleContractPrompt(),
        'Поле price: сохрани явно указанную стоимость/цену билета/входа; если цены нет — оставь пустым. Поле announcement — готовое краткое описание события в 2–4 максимально коротких предложениях: что будет происходить, формат/программа и важные особенности. Не повторяй отдельные поля даты, времени, места, цены и участников. Сохраняй важные конкретные детали из источника, ничего не додумывай. Не возвращай пустое описание, если в исходнике есть содержательные детали.',
        'Поле evidence должно содержать до трёх точных цитат из исходного текста, подтверждающих суть, дату и место. Если факты расположены в разных абзацах, раздели цитаты символами ||. Не перефразируй цитаты. Если подтверждений нет — верни пустой список.',
        'Верни только JSON без Markdown: {"structure":"single_event|single_event_program|shared_schedule_event|theater_repertoire|multiple_events|not_event|uncertain","structure_reason":"краткое основание","events":[]} либо тот же объект с массивом events. Для single_event, single_event_program и theater_repertoire верни ровно один объект; для theater_repertoire укажи schedule:{dateMode:"specific",startDate:"YYYY-MM-DD",endDate:"YYYY-MM-DD",dates:[...]}, date=первая будущая дата и program_items:[{date,title,time,text,evidence}] для каждой даты; evidence — точная цитата, одновременно подтверждающая дату и название постановки. Для multiple_events — по одному объекту на каждое самостоятельно подтверждённое событие; для not_event и uncertain массив events пустой. Если хотя бы один объект мультианонса не прошёл проверку даты, сути, места или точной цитаты, не возвращай неполный список — верни uncertain с причиной.',
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
