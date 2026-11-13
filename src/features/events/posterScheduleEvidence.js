// Vision describes the picture's layout. Final event cardinality is still
// decided from the original text AND the picture, with these facts as evidence.
import { POSTER_CONTEXT_VISION_INSTRUCTION } from './eventPosterRole.js';
export const POSTER_SCHEDULE_VISION_INSTRUCTION = [
    POSTER_CONTEXT_VISION_INSTRUCTION,
    'Одна картинка может содержать несколько самостоятельных анонсов. Число картинок НЕ равно числу событий.',
    'Сохрани графическую структуру: для каждой строки, колонки или отдельного блока свяжи дату именно с его названием, участниками и программой. Не объединяй артистов разных дат в один общий состав.',
    'Перед полем Распознанный текст добавь поля: Структура расписания: single_event / shared_program / distinct_events / uncertain; Основание расписания: точная цитата с изображения; Связи дат и программ: JSON-массив объектов {"dateText":"точно напечатанная дата или диапазон","title":"название","participants":"артисты","program":"программа","evidence":"точная цитата этого блока"}. Не указывай выдуманный год.',
    'distinct_events: к разным датам привязаны разные названия, артисты, программы, условия или самостоятельные анонсы, даже на ОДНОЙ общей афише. shared_program: один общий текст и одна неизменная программа действительно относятся ко ВСЕМ перечисленным датам/диапазону; сохрани один общий блок, не размножай его по дням. Общий фон, логотип, адрес, жанр или слово «корпоратив» не доказывают одинаковую программу.',
    'Если связь даты и программы не читается, структура mixed или блоки конфликтуют, укажи uncertain. Не распределяй общий список артистов по датам наугад.',
    'Распознанный текст: перепиши весь читаемый текст, сохраняя строки и принадлежность текста блокам; не сокращай вторую и последующие даты. Поле Причина должно идти после полного OCR.',
].join(' ');

const KIND = new Set(['single_event', 'shared_program', 'distinct_events', 'uncertain']);
export function normalizePosterScheduleKind(value) {
    const kind = String(value || '').trim().toLowerCase();
    return KIND.has(kind) ? kind : kind ? 'uncertain' : '';
}
export function normalizeDateProgramBindings(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0,64).filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(x =>
        Object.fromEntries(['dateText','title','participants','program','evidence'].map(k => [k, typeof x[k] === 'string' ? x[k].trim().slice(0,8000) : '']))
    ).filter(x => x.dateText && (x.title || x.participants || x.program));
}
export function normalizeScheduleQuote(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/ё/gu,'е').replace(/[«»"“”]/gu,'').replace(/\s+/gu,' ').trim();
}
export function quoteIsInPoster(quote, fact) {
    const needle = normalizeScheduleQuote(quote);
    return needle.length >= 8 && normalizeScheduleQuote(fact?.recognizedText).includes(needle);
}
export function posterHasProvenSharedProgram(fact) {
    if (fact?.scheduleKind !== 'shared_program' || !quoteIsInPoster(fact?.scheduleEvidence, fact)) return false;
    const rows = normalizeDateProgramBindings(fact?.dateProgramBindings);
    return rows.length > 0 && rows.every(row => quoteIsInPoster(row.evidence,fact)) &&
        new Set(rows.map(row => normalizeScheduleQuote([row.title,row.participants,row.program].join(' ')))).size === 1;
}
