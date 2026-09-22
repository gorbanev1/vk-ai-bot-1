/**
 * Removes VK interface artefacts that may leak into captured post body text.
 * The sanitizer is intentionally conservative: it removes only standalone UI
 * labels/counters and leaves normal prose untouched.
 */
const VK_SLIDE_LABEL_RE = /^(?:следующий|предыдущий)\s+слайд(?:\s+\d+\s+из\s+\d+)?[.!…]?$/iu;
const VK_GALLERY_COUNTER_RE = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/u;
const VK_UI_LINE_RE = /^(?:воспроизвести|пауза|следующий\s+трек|предыдущий\s+трек|громкость|поделиться|нравится|комментировать|показать\s+ещ[её]|открыть\s+фотографию)[.!…]?$/iu;

export function isVkGalleryCounterLine(value) {
    const match = String(value ?? '').trim().match(VK_GALLERY_COUNTER_RE);
    if (!match) return false;
    const current = Number(match[1]);
    const total = Number(match[2]);
    return Number.isInteger(current) && Number.isInteger(total) && current >= 1 && total >= 2 && current <= total && total <= 100;
}

export function sanitizeEventBodyText(value) {
    const lines = String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\u00a0/gu, ' ')
        .split('\n');
    const result = [];

    for (let index = 0; index < lines.length; index += 1) {
        let line = String(lines[index] ?? '').replace(/[ \t]{2,}/gu, ' ').trim();
        if (!line) continue;
        if (VK_SLIDE_LABEL_RE.test(line) || VK_UI_LINE_RE.test(line)) continue;

        // VK sometimes serializes "1/10 Следующий слайд" into one text node.
        line = line
            .replace(/^\s*\d{1,3}\s*\/\s*\d{1,3}\s+(?=(?:следующий|предыдущий)\s+слайд(?:\s|$))/iu, '')
            .replace(/(?:следующий|предыдущий)\s+слайд(?:\s+\d+\s+из\s+\d+)?[.!…]?/giu, '')
            .trim();
        if (!line) continue;

        // A standalone N/M immediately adjacent to VK slide UI is a carousel
        // counter, not a day/month date. A slash date embedded in prose such as
        // "концерт 1/10" is intentionally preserved.
        if (isVkGalleryCounterLine(line)) {
            // VK can place the visual slide control one structural text node
            // away from the N/M counter, with the post caption between them.
            // Inspect a tiny ±2-line window so `1/10` never becomes 1 October,
            // while slash dates embedded in normal prose remain untouched.
            const nearby = [
                lines[index - 2], lines[index - 1],
                lines[index + 1], lines[index + 2],
            ].map((value) => String(value ?? '').trim());
            if (nearby.some((value) => VK_SLIDE_LABEL_RE.test(value))) continue;
        }
        result.push(line);
    }

    return result.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}


const OPERATIONAL_STATUS_RE = /(?:по\s+техническим\s+причинам|техническ(?:ий|ого)\s+перерыв|санитарн(?:ый|ого)\s+день|изменени[ея]\s+в\s+режиме\s+работы|режим\s+работы|(?:бар|клуб|паб|заведение|площадка)?\s*(?:сегодня|сейчас)?\s*(?:не\s+работает|не\s+работаем|закрыт(?:о|ы|а)?)(?:\s|[!.,]|$)|(?:сегодня|сейчас)\s+(?:бар|клуб|паб|заведение|площадка)\s+(?:не\s+работает|закрыт(?:о|ы|а)?))/iu;

/**
 * Detects operational/status posts whose primary purpose is venue service info
 * (closure, technical break, schedule change). They may mention a nearby event
 * ("tomorrow we wait for you at the concert") but must not enter the event AI
 * queue on body text alone. A real attached poster can still rescue the post in
 * the dedicated poster-vision gate.
 */
export function explainOperationalStatusPost(value) {
    const text = sanitizeEventBodyText(value);
    const operationalStatus = OPERATIONAL_STATUS_RE.test(text);
    return {
        operationalStatus,
        rejectAsAnnouncement: operationalStatus,
    };
}

const RETROSPECTIVE_RE = /(?:как\s+мы\s+(?:провожали|отмечали|зажигали)|как\s+это\s+было|фотоотч[её]т|спасибо\s+(?:всем|каждому)|вчера\s+(?:отыграли|прош[её]л|было)|прош[её]л\s+(?:концерт|фестиваль|вечер|ивент|мероприятие)|было\s+(?:круто|жарко|незабываемо)|вспоминаем\s+(?:вечер|концерт|фестиваль))/iu;
const FUTURE_INTENT_RE = /(?:состоится|пройд[её]т|жд[её]м\s+вас|приходите|увидимся|встречаемся|будет\s+(?:концерт|вечеринка|фестиваль|мероприятие)|билеты?\s+(?:уже\s+)?(?:в\s+продаже|по\s+ссылке)|двери\s+(?:в|откроются)|начало\s+(?:в|:)|регистрация\s+(?:открыта|по\s+ссылке))/iu;

export function explainRetrospectivePost(value) {
    const text = sanitizeEventBodyText(value);
    const retrospective = RETROSPECTIVE_RE.test(text);
    const futureIntent = FUTURE_INTENT_RE.test(text);
    return {
        retrospective,
        futureIntent,
        reject: Boolean(retrospective && !futureIntent),
    };
}

export function looksLikeRetrospectivePost(value) {
    return explainRetrospectivePost(value).reject;
}
