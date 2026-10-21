
import { validatePublicAiEvents } from './src/features/events/publicPostLocalParser.js';
import { explainStrictEventRecord } from './src/features/events/eventValidation.js';
const post = {
  __dateFreeVisionPhase: true,
  text: 'КОПТИЛЬНЯ еда и музыка[Факты с афиши]\n[IMAGE 1]\nЭто афиша события: да\nДата: 18–30 декабря\nМесто: «Коптильня» (еда и музыка)\nНазвание: Коптильня: новогодние корпоративы\nРаспознанный текст: КОПТИЛЬНЯ. ЕДА И МУЗЫКА. Открываем бронирование на новогодние корпоративы. 18–30 декабря | от 4000 ₽ | праздничная программа.',
  publishedAt: 1792434000,
};
const baseEvent = {
  date: '2026-12-18',
  title: 'Коптильня: новогодние корпоративы',
  participants: '',
  venue: 'Коптильня (еда и музыка)',
  price: 'от 4000 ₽',
  announcement: 'Открываем бронирование на новогодние корпоративы. 18–30 декабря. Праздничная программа.',
  source_segment: '18–30 декабря | от 4000 ₽ | праздничная программа.',
  evidence: '18–30 декабря; от 4000 ₽; праздничная программа',
  tags: ['party'],
  image_indexes: [1],
  _structure: 'multiple_events',
  _structureReason: 'несколько дат корпоративных мероприятий',
};
const events = Array.from({ length: 13 }, (_, i) => ({ ...baseEvent, date: '2026-12-' + String(18 + i).padStart(2, '0') }));
const result = validatePublicAiEvents(events, post);
console.log('result:', result.length, result.aiResponseValid, result.aiResponseError);
for (const ev of events.slice(0, 3)) {
  const candidate = {
    title: String(ev.title || ev.participants || '').slice(0, 500),
    eventDate: String(ev.date).trim(),
    eventTime: null,
    venue: String(ev.venue).slice(0, 500),
    participants: String(ev.participants || '').slice(0, 2000),
    price: String(ev.price).slice(0, 500),
    description: String(ev.announcement).slice(0, 5000),
    evidence: String(ev.evidence).slice(0, 500),
    announcement: String(ev.announcement).slice(0, 5000),
    sourceSegment: String(ev.source_segment || '').slice(0, 5000),
    structureDecision: 'multiple_events',
    structureReason: 'несколько дат корпоративных мероприятий',
    programItems: [],
    isMultiAnnouncement: 1,
    imageIndexes: [1],
    eventTags: ['party'],
    parseMethod: 'gigachat_validated_phase2_poster_v2',
    status: 'pending',
  };
  const strict = explainStrictEventRecord(candidate, { sourceText: String(post.text), requireEvidence: false, trustedPosterEvent: true });
  console.log(ev.date, JSON.stringify(strict));
}

