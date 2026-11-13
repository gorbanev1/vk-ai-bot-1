import { buildStrictEventExtractionPrompt } from './eventValidation.js';
import { DATE_FREE_EXTRACTION_INSTRUCTION } from './dateFreeEventEvidence.js';
import { SHARED_SCHEDULE_INSTRUCTION } from './sharedEventSchedule.js';
import { formatEventTagPromptInstruction } from './eventSearchTaxonomy.js';
import { getLocalDateString } from '../../shared/date.js';

export function buildPublicEventTextExtractionPrompts({
    post, sourceText, confirmedPoster = false, multiplicity = {}, repair = false,
    botTimeZone = 'Europe/Moscow',
}) {
    // Trim only formatting noise, not facts. Both router and local models
    // receive the same normalized source and production extraction contract.
    sourceText=String(sourceText??'')
        .replace(/\r\n?/gu,'\n')
        .replace(/[ \t]{3,}/gu,'  ')
        .replace(/\n{4,}/gu,'\n\n')
        .trim();
    return {
            systemPrompt: [
                buildStrictEventExtractionPrompt({
                    sourceKind: 'публичной публикации Telegram или VK',
                    sourceText, publishedAt: post?.publishedAt, timeZone: botTimeZone,
                    referenceDate: post?.publishedAt
                        ? getLocalDateString(new Date(post.publishedAt * 1000), botTimeZone)
                        : getLocalDateString(new Date(), botTimeZone),
                    confirmedPoster,
                }),
                confirmedPoster ? '' : 'Один пост может содержать одно событие, программу одного события, театральный репертуар или несколько самостоятельных мероприятий. Сначала сам реши структуру по смыслу исходника и верни structure=single_event, single_event_program, shared_schedule_event, theater_repertoire, multiple_events, not_event или uncertain. Даты и последовательные блоки — только подсказки для проверки числа событий.',
                confirmedPoster ? '' : 'Для multiple_events выделяй только самостоятельно анонсированные события. Не принимай ошибку/исправление даты, повтор одного анонса, дату публикации или несколько времён программы за новое событие. Для single_event и single_event_program верни ровно один объект events; для uncertain и not_event верни пустой events.',
                confirmedPoster ? 'В фазе 2 каждая дата подтверждённой афиши имеет приоритет, даже если дата или тема не совпадает с текстом. Для разных самостоятельных программ афиши создай отдельные карточки по связи дата—название—участники; для одной театральной репертуарной афиши одной организации используй theater_repertoire и одну карточку с program_items по датам; для одного общего анонса на диапазон используй shared_schedule_event.' : '',
                'Если structure=not_event, в structure_reason укажи короткую смысловую метку на 2–6 слов, что именно сообщает пост (например: «объявление конкурса», «реклама меню», «итоги розыгрыша», «фотоотчёт с концерта»). Не пиши общую фразу «не является событием». Для остальных структур structure_reason кратко объясняет решение о структуре.',
                confirmedPoster ? DATE_FREE_EXTRACTION_INSTRUCTION : 'Vision/OCR metadata изображения НЕ МОЖЕТ создавать, удалять, объединять или делить текстовые карточки и НЕ МОЖЕТ переносить текст между датами. Метаданные картинки сохраняются отдельно и проверяют уже полученные карточки позже.',
                repair
                    ? `Это повторная проверка ответа. В тексте обнаружено несколько дат или времён (дат: ${multiplicity.distinctDateSignals}, времён: ${multiplicity.distinctTimeSignals}), но это само по себе не означает несколько событий. Проверь смысл исходника, учти возможную ошибку/исправление в посте и верни только подтверждённую структуру либо uncertain.`
                    : '',
                formatEventTagPromptInstruction(),
                SHARED_SCHEDULE_INSTRUCTION,
                'Допустимый формат результата: {"structure":"single_event|single_event_program|shared_schedule_event|theater_repertoire|multiple_events|not_event|uncertain","structure_reason":"краткое основание","events":[{"date":"YYYY-MM-DD","time":"HH:MM или null","title":"...","venue":"...","participants":"...","price":"...","announcement":"только этот анонс","source_segment":"точный фрагмент только этого анонса","schedule":{"dateMode":"specific","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","dates":[]},"program_items":[{"date":"YYYY-MM-DD","title":"спектакль","time":"HH:MM или null","text":"описание","evidence":"точный фрагмент"}],"evidence":"точный фрагмент","tags":["theater"],"image_indexes":[1]}]}. Для single_event/single_event_program/shared_schedule_event/theater_repertoire верни ровно одну карточку; для theater_repertoire обязательны все даты и program_items с датой, названием, evidence; для multiple_events — все самостоятельные карточки; для not_event/uncertain — пустой events. Верни только JSON.',
            ].filter(Boolean).join(' '),
            userPrompt: [
                `Дата публикации: ${post?.publishedAt ? new Date(post.publishedAt * 1000).toISOString() : 'неизвестна'}`,
                `Ссылка: ${post?.sourceUrl ?? ''}`,
                '',
                '',
                sourceText,
            ].join('\n'),
    };
}
