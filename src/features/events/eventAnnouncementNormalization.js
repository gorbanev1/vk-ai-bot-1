/**
 * Очистка и контракт AI-нормализации анонсов. Модель получает сырой текст
 * только как источник фактов, а пользователю возвращается структурированная
 * афиша без служебного мусора интерфейсов VK/Telegram и дублей шапки.
 */

const SERVICE_ONLY_LINE = /^(?:анонс|встреча|билеты|действия|источник|view in telegram|please open telegram to view this post|показать полностью|ещ[её]\s+\d+\s+автор(?:а|ов)?|и\s+ещ[её]\s+\d+\s+автор(?:а|ов)?)\s*:?[\s.]*$/iu;
const DUPLICATE_METADATA_LINE = /^(?:когда|что|кто|где|поч[её]м|дата|время|начало|старт|двери|название|мероприятие|событие|место|адрес|площадка|стоимость|цена|вход|билеты?|участники|лайн-?ап|line[ -]?up)\s*(?::|;|：|[—–-])/iu;
const HASHTAG_ONLY_LINE = /^(?:\s*#[\p{L}\p{N}_-]+\s*)+$/iu;
const LINK_ONLY_LINE = /^https?:\/\/\S+$/iu;
const REACTION_ONLY_LINE = /^(?:(?:[\p{Extended_Pictographic}\uFE0F\u200D]+)\s*\d*\s*){1,20}$/u;
const GIVEAWAY_NOISE = /(?:розыгрыш|конкурс|репост|вступить\s+во\s+встречу|точно\s+пойду|хочу\s+на\s+концерт|итоги\s+конкурса|призов|призовое\s+место|победител|разыгра)/iu;
const VISION_AUDIT_BLOCK_RE = /(?:^|\n)\s*\[Факты\s+с\s+афиши\]\s*[\s\S]*$/iu;
const VISION_INDEX_BLOCK_RE = /(?:^|\n)\s*\[IMAGE\s+\d+\]\s*(?=\n\s*(?:Тип\s+изображения|Это\s+афиша\s+события|Уверенность\s+афиши|Читаемость\s+текста))[\s\S]*$/iu;
const INLINE_HTTP_URL_RE = /https?:\/\/[^\s<>{}\[\]()]+/giu;
const INLINE_BARE_DOMAIN_RE = /(?<![\p{L}\p{N}_@])(?:www\.)?[a-z0-9](?:[a-z0-9.-]{0,120})\.(?:ru|com|org|net|io|events|club|online)(?:\/[^\s<>{}\[\]()]*)?/giu;

function stripInternalVisionAudit(value) {
    return String(value ?? '')
        .replace(VISION_AUDIT_BLOCK_RE, '')
        .replace(VISION_INDEX_BLOCK_RE, '')
        .trim();
}

function stripInlineLinks(value) {
    return String(value ?? '')
        .replace(INLINE_HTTP_URL_RE, ' ')
        .replace(INLINE_BARE_DOMAIN_RE, ' ')
        .replace(/[ \t]{2,}/gu, ' ')
        .replace(/\s+([,.;:!?])/gu, '$1')
        .trim();
}

function normalizeWhitespace(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/[\t\f\v]+/gu, ' ')
        .replace(/[ \u00a0]{2,}/gu, ' ')
        .trim();
}


function stripGiveawaySentences(value) {
    const source = normalizeWhitespace(value);
    if (!source) return '';
    return source
        .split(/(?<=[.!?])\s+|\n+/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !GIVEAWAY_NOISE.test(part))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function hasExplicitTimeEvidence(original, candidate) {
    const time = String(candidate ?? '').trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/u.test(time)) return true;
    const [hour, minute] = time.split(':');
    const hh = hour.padStart(2, '0');
    const source = String(original?.description ?? original?.rawSource ?? '');
    if (!source) return false;

    const colonPattern = new RegExp(`(?:^|[^\\d])${hh}:${minute}(?!\\d)`, 'u');
    if (colonPattern.test(source)) return true;

    // A hyphenated clock is admitted only with an explicit time cue.
    const dashPattern = new RegExp(
        `(?:начало|сбор|двери|doors?|start|время|\\bв)\\s*(?:в\\s*)?${hh}-${minute}(?!\\d)`,
        'iu',
    );
    return dashPattern.test(source);
}

export function stripEventPlatformArtifacts(value) {
    const source = normalizeWhitespace(stripInternalVisionAudit(value))
        .replace(/Please open Telegram to view this post/giu, '\n')
        .replace(/VIEW IN TELEGRAM/giu, '\n')
        .replace(/\n\s*и\s*\n\s*ещ[её]\s+\d+\s+автор(?:а|ов)?/giu, '\n');
    const output = [];

    for (const rawLine of source.split('\n')) {
        const line = rawLine.trim();

        if (!line) {
            if (output.length && output.at(-1) !== '') output.push('');
            continue;
        }

        if (
            SERVICE_ONLY_LINE.test(line) ||
            HASHTAG_ONLY_LINE.test(line) ||
            LINK_ONLY_LINE.test(line) ||
            REACTION_ONLY_LINE.test(line)
        ) {
            continue;
        }

        output.push(line);
    }

    return output
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

export function stripEventServiceArtifacts(value) {
    const source = normalizeWhitespace(stripInternalVisionAudit(value))
        .replace(/Please open Telegram to view this post/giu, '\n')
        .replace(/VIEW IN TELEGRAM/giu, '\n')
        .replace(/\n\s*и\s*\n\s*ещ[её]\s+\d+\s+автор(?:а|ов)?/giu, '\n');
    const output = [];

    for (const rawLine of source.split('\n')) {
        let line = rawLine.trim();

        if (!line) {
            if (output.length && output.at(-1) !== '') output.push('');
            continue;
        }

        line = stripInlineLinks(line
            .replace(/^(?:действия|анонс)\s+(?=\S)/iu, '')
            .replace(/^(?:описание|анонс)\s*(?::|;|：|[—–-])\s*/iu, '')
            .trim());

        if (
            SERVICE_ONLY_LINE.test(line) ||
            DUPLICATE_METADATA_LINE.test(line) ||
            HASHTAG_ONLY_LINE.test(line) ||
            LINK_ONLY_LINE.test(line) ||
            REACTION_ONLY_LINE.test(line)
        ) {
            continue;
        }

        output.push(line);
    }

    return stripGiveawaySentences(
        output
            .join('\n')
            .replace(/\n{3,}/gu, '\n\n')
            .trim(),
    );
}

export function buildEventNormalizationSystemPrompt() {
    return [
        'Ты редактор городской афиши. Получаешь уже найденные события и приводишь их к аккуратному единому формату.',
        'Используй ТОЛЬКО факты из входного JSON. Ничего не додумывай и не улучшай фактами из памяти.',
        'Верни только JSON без Markdown: {"events":[...]}. Для каждого входного key верни ровно один объект с тем же key.',
        'Поля результата: key, title, displayDate, timeLabel, eventType, venue, participants, price, announcement.',
        'title — короткое человеческое название самого события. Не используй случайную рекламную фразу вроде «это будет незабываемо» как название, если в rawSource есть явное имя мероприятия.',
        'displayDate — понятная дата. Сначала проверь rawSource: если там явно указан диапазон дат (например 07.08.26–09.08.26), сохрани именно диапазон; иначе используй suppliedDateLabel.',
        'timeLabel — только реально указанное ВРЕМЯ или расписание. Не превращай фрагмент даты вроде 07.08 в время 07:08. Если несколько этапов в разных местах/временах, кратко сохрани их здесь. Если времени нет — пустая строка.',
        'eventType — концерт/вечеринка/фестиваль/маркет/лекция и т.п., только если это понятно из фактов; иначе пусто.',
        'venue — место/адрес. Если несколько последовательных площадок, кратко перечисли. Если место не дано — пусто. Если прямо сказано «место сообщим позже» или аналогично, сохрани эту формулировку.',
        'participants — только реальные артисты/участники/ведущие; без слов интерфейса, шуток автора и приписок вроде «+ налоги + на пиво».',
        'price — только фактическая стоимость ВХОДА/БИЛЕТА и условия посещения. Не путай сумму сертификата, приза, скидки, розыгрыша, коктейля или мерча со стоимостью события. Если цена входа не указана — пустая строка. Удали шутки и эмоциональные приписки вроде «скока-скока», но сохрани реальные тарифы и условия.',
        'announcement — чистый понятный анонс примерно 2–7 коротких абзацев: что будет происходить, программа, важные особенности и условия. Пиши редакторски нейтрально и понятно, не копируй бессмысленные шутки/подколы источника, если они не несут факта о событии.',
        'Из announcement обязательно убери повтор уже вынесенных полей (дата, время, место, цена, список участников), если они просто дублируются.',
        'Полностью исключи из announcement розыгрыши и конкурсы: просьбы вступить во встречу, нажать "Точно пойду", сделать репост, написать "Хочу на концерт", условия участия, итоги конкурса, призы и победителей. Это не описание мероприятия.',
        'Удали служебный мусор платформ: «Встреча», «Билеты» как одиночные кнопки, «Действия», «Please open Telegram...», «VIEW IN TELEGRAM», реакции и их счётчики, хэштеги, число авторов, навигационные подписи, кнопки, UI-текст.',
        'Не тащи в announcement источник/URL — источник выводится приложением отдельно.',
        'Сохраняй полезные детали исходного анонса, но перепиши их связно и без повторов. Удали фразы вроде «кому бан», «скока-скока», комментарии про достаток админов и другой редакционный шум, если это не условие участия. Не добавляй оценок от себя.',
    ].join(' ');
}

export function buildEventNormalizationPayload(events) {
    return (Array.isArray(events) ? events : []).map((event, index) => ({
        key: String(event?.key ?? index),
        title: String(event?.title ?? ''),
        suppliedDate: String(event?.eventDate ?? ''),
        suppliedDateLabel: String(event?.suppliedDateLabel ?? ''),
        eventTime: String(event?.eventTime ?? ''),
        eventType: String(event?.eventType ?? ''),
        venue: String(event?.venue ?? ''),
        participants: String(event?.participants ?? ''),
        price: String(event?.price ?? ''),
        rawSource: stripEventPlatformArtifacts(event?.description ?? '').slice(0, 12000),
        announcement: stripEventServiceArtifacts(event?.description ?? ''),
    }));
}

export function mergeNormalizedEvent(original, normalized) {
    const clean = (value, limit) => String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, limit);
    const has = (key) => Object.prototype.hasOwnProperty.call(normalized || {}, key);
    const choose = (key, originalKey, limit) => (
        has(key)
            ? clean(normalized?.[key], limit)
            : clean(original?.[originalKey], limit)
    );
    const chooseFact = (key, originalKey, limit) => {
        const candidate = has(key) ? clean(normalized?.[key], limit) : '';
        return candidate || clean(original?.[originalKey], limit);
    };
    const originalAnnouncement = stripEventServiceArtifacts(
        original?.description || '',
    ).slice(0, 12000);
    const normalizedAnnouncement = has('announcement')
        ? stripEventServiceArtifacts(normalized?.announcement || '').slice(0, 12000)
        : '';
    const normalizedLooksTooThin = Boolean(
        originalAnnouncement.length >= 100 && (
            normalizedAnnouncement.length < 60 ||
            /^(?:двери|начало|старт|время)\s*[:—–-]\s*(?:[01]?\d|2[0-3]):\d{2}[.!]?$/iu.test(normalizedAnnouncement)
        )
    );
    const announcement = normalizedAnnouncement && !normalizedLooksTooThin
        ? normalizedAnnouncement
        : originalAnnouncement;

    const newTitle = clean(normalized?.title, 300);
    const changedEvent = Boolean(newTitle && newTitle !== clean(original?.title, 300));
    const candidateTime = has('timeLabel') && !clean(normalized?.timeLabel, 300) && changedEvent
        ? '' : chooseFact('timeLabel', 'eventTime', 300);
    const safeTime = hasExplicitTimeEvidence(original, candidateTime)
        ? candidateTime
        : '';

    return {
        ...original,
        title: choose('title', 'title', 300) || clean(original?.title, 300),
        displayDate: (has('displayDate') && clean(normalized?.displayDate, 120)) || clean(original?.displayDate, 120),
        timeLabel: safeTime,
        eventType: choose('eventType', 'eventType', 100),
        venue: chooseFact('venue', 'venue', 700),
        participants: chooseFact('participants', 'participants', 1200),
        price: chooseFact('price', 'price', 700),
        description: announcement,
    };
}
