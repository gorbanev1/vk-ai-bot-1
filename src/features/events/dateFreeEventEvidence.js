import { SHARED_SCHEDULE_INSTRUCTION, getSharedEventSchedule } from './sharedEventSchedule.js';
import { parseIndexedImageFacts, evaluatePosterFactForEvent } from './eventPosterMatching.js';
import { isEventDateConsistentWithSource } from './publicPostDateEvidence.js';

export function acceptedDateFreePoster(item) {
    return item?.__dateFreeVisionPhase === true &&
        parseIndexedImageFacts(item?.__posterGateFacts || '').some((fact) => fact.poster === true);
}

// Phase two has already classified the image. The body is supplementary
// announcement material, never a second vote against the poster.
export const DATE_FREE_EXTRACTION_INSTRUCTION = [
    'ВТОРАЯ ФАЗА: Vision уже подтвердил, что прикреплённая картинка — анонс события.',
    'Извлеки карточки из сохранённых метаданных афиши и дополни их данными текста поста/сообщения.',
    'Афиша может самостоятельно дать название, дату, место и участников, даже если в тексте этого нет.',
    'Не проверяй совпадение текста с афишей и не отклоняй событие из-за другого смысла, отсутствия или несовпадения сведений в тексте. При расхождении используй сведения подтверждённой афиши.',
    'Число карточек определи по самостоятельным событиям на подтверждённых афишах. Укажи image_indexes исходных афиш.',
    'Месячная афиша или расписание клуба с разными программами/анонсами по календарным датам — multiple_events: отдельная карточка на каждый самостоятельный анонс. Исключение: репертуар одной театральной площадки/организации с разными спектаклями по датам — theater_repertoire, одна второстепенная карточка с schedule и program_items по датам. Одинаковый текст и одинаковая афиша на диапазон дат — shared_schedule_event, одна карточка на весь диапазон. Общая площадка, организатор или оформление не превращают обычное расписание в single_event_program. На одной дате могут быть разные самостоятельные события. single_event_program — этапы одного события, а не календарь разных вечеров.',
    SHARED_SCHEDULE_INSTRUCTION,
    'Текст поста используй как текст анонса. Не выдумывай отсутствующую календарную дату или место; дата публикации и интерфейс не являются данными события.',
].join(' ');

export function storedEventDateSupported(event, { sourceText = '', publishedAt = 0, imageVisionFacts = [], timeZone = 'Europe/Moscow' } = {}) {
    if (getSharedEventSchedule(event)?.sourceDateEvidence.length) return true;
    if (isEventDateConsistentWithSource({ eventDate: event?.eventDate, sourceText, publishedAt, timeZone })) return true;
    // Use durable, classified source images on read as well as on ingest. A
    // date existing only on a real poster must not disappear from listings.
    const facts = typeof imageVisionFacts === 'string'
        ? (() => { try { return JSON.parse(imageVisionFacts); } catch { return []; } })()
        : imageVisionFacts;
    return [...(Array.isArray(facts) ? facts : []), ...(event?.posterVisionFacts || [])].some((fact) =>
        evaluatePosterFactForEvent(event, fact).accepted && (
            fact.dateFreeEventBinding?.eventDate === event?.eventDate ||
            isEventDateConsistentWithSource({ eventDate: event?.eventDate,
                sourceText: [fact.dates, fact.recognizedText, fact.text].filter(Boolean).join('\n'), publishedAt, timeZone })
        ));
}
