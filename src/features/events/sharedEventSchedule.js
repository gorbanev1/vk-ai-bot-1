import { inferEventYear, isCalendarIsoDate } from './publicPostDateEvidence.js';
import { parseIndexedImageFacts } from './eventPosterMatching.js';
import { normalizeDateProgramBindings, normalizeScheduleQuote, posterHasProvenSharedProgram, quoteIsInPoster } from './posterScheduleEvidence.js';

const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTH_ALIASES = [
  ['января','январь','янв'],['февраля','февраль','фев'],['марта','март','мар'],
  ['апреля','апрель','апр'],['мая','май'],['июня','июнь','июн'],
  ['июля','июль','июл'],['августа','август','авг'],['сентября','сентябрь','сен','сент'],
  ['октября','октябрь','окт'],['ноября','ноябрь','ноя'],['декабря','декабрь','дек'],
];
const MONTH_MAP = new Map(MONTH_ALIASES.flatMap((keys,i)=>keys.map(k=>[k,i+1])));
const MR = [...MONTH_MAP.keys()].sort((a,b)=>b.length-a.length).join('|');
const ORD_NOM=['','первое','второе','третье','четвертое','пятое','шестое','седьмое','восьмое','девятое','десятое','одиннадцатое','двенадцатое','тринадцатое','четырнадцатое','пятнадцатое','шестнадцатое','семнадцатое','восемнадцатое','девятнадцатое'];
const ORD_GEN=['','первого','второго','третьего','четвертого','пятого','шестого','седьмого','восьмого','девятого','десятого','одиннадцатого','двенадцатого','тринадцатого','четырнадцатого','пятнадцатого','шестнадцатого','семнадцатого','восемнадцатого','девятнадцатого'];
const ordinalMap=new Map();
for(let n=1;n<=31;n++){
  const prefix=n>=30?'тридцать ':n>=20?'двадцать ':'';
  const base=n>=20?n%10:n;
  const keys=base===0 ? (n===20?['двадцатое','двадцатого']:['тридцатое','тридцатого']) : [prefix+ORD_NOM[base],prefix+ORD_GEN[base]];
  for(const k of keys) if(k && !k.endsWith(' ')) ordinalMap.set(k,n);
}
const ordinalRx=new RegExp(`(?<![\\p{L}])(${[...ordinalMap.keys()].sort((a,b)=>b.length-a.length).join('|')})(?![\\p{L}])`,'giu');
function normalized(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[\u00a0\u202f]/g,' ').replace(/[–—−]/g,'-').replace(/\r/g,'').replace(/\bг\.(?=\s|$)/g,'');}
function textWithNumericOrdinals(s){return normalized(s).replace(ordinalRx,m=>String(ordinalMap.get(m))).replace(/(?<!\d)(\d{1,2})-(?:го|е|ое|й|ого)(?![\p{L}])/giu,'$1');}
function valid(y,m,d){const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()+1===m&&t.getUTCDate()===d;}
function iso(y,m,d){if(!valid(y,m,d))return null;return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
function toYear(raw,baseYear){if(!raw)return baseYear;let n=Number(raw);return n<100?(n>=70?1900+n:2000+n):n;}
function month(n){return MONTH_MAP.get(n)||0;}
function timestamp(s){return Date.parse(s+'T00:00:00Z');}
function rangeObject(start,end,raw,source){
  if(!start||!end||timestamp(end)<timestamp(start))return null;
  // Safety bound for noisy OCR: a several-year span is not expanded automatically.
  if((timestamp(end)-timestamp(start))/86400000>366)return null;
  return {dateMode:'continuous',startDate:start,endDate:end,dates:[],raw,source};
}
function listObject(dates,raw,source){const ordered=[...new Set(dates.filter(Boolean))].sort();return ordered.length>=2?{dateMode:'specific',dates:ordered,startDate:ordered[0],endDate:ordered.at(-1),raw,source}:null;}
function resolveRange(d1,m1,y1,d2,m2,y2,baseYear,raw,source){
  const aYear=toYear(y1||y2,baseYear), bYear=toYear(y2||y1,baseYear);
  const a=iso(aYear,m1,d1);
  let b=iso(bYear,m2,d2);
  if(a&&b&&b<a&&!y2 && !y1 && (m2<m1))b=iso(bYear+1,m2,d2);
  return rangeObject(a,b,raw,source);
}
const rx = {
  numericRange: new RegExp('(?<!\\d)([0-3]?\\d)[.\\/]([01]?\\d)(?:[.\\/](\\d{2,4}))?\\s*(?:-|по|до)\\s*([0-3]?\\d)[.\\/]([01]?\\d)(?:[.\\/](\\d{2,4}))?(?!\\d)','giu'),
  namedRangeBoth:new RegExp(`(?<!\\d)(?:с\\s+)?([0-3]?\\d)\\s+(${MR})(?:\\s+(\\d{4}))?\\s*(?:-|по|до)\\s*([0-3]?\\d)\\s+(${MR})(?:\\s+(\\d{4}))?`,'giu'),
  sameMonthRange:new RegExp(`(?<!\\d)(?:с\\s+)?([0-3]?\\d)\\s*(?:-|по)\\s*([0-3]?\\d)\\s+(${MR})(?:\\s+(\\d{4}))?`,'giu'),
  shortNumericRange:new RegExp('(?<![\\d.\\/])([0-3]?\\d)\\s*-\\s*([0-3]?\\d)[.\\/]([01]?\\d)(?:[.\\/](\\d{2,4}))?(?!\\d)','giu'),
  namedList:new RegExp(`(?<!\\d)((?:[0-3]?\\d\\s*(?:,|;|и)\\s*)+[0-3]?\\d)\\s+(${MR})(?:\\s+(\\d{4}))?`,'giu'),
  numericList:new RegExp('(?<!\\d)((?:[0-3]?\\d\\s*(?:,|;|и)\\s*)+[0-3]?\\d)[.\\/]([01]?\\d)(?:[.\\/](\\d{2,4}))?(?!\\d)','giu'),
  namedDate:new RegExp(`(?<!\\d)([0-3]?\\d)\\s+(${MR})(?:\\s+(\\d{4}))?(?!\\d)`,'giu'),
  numericDate:new RegExp('(?<![\\d.\\/])([0-3]?\\d)[.\\/]([01]?\\d)(?:[.\\/](\\d{2,4}))?(?![\\d.\\/])','giu'),
};
function allMatches(re,s){return [...s.matchAll(re)];}
function parseDateExpression(value,{year,source='poster'}={}){
  const text=textWithNumericOrdinals(value);
  const ranges=[];
  const specific=[];
  const add=r=>{if(r)ranges.push(r);};
  for(const m of allMatches(rx.numericRange,text))add(resolveRange(+m[1],+m[2],m[3],+m[4],+m[5],m[6],year,m[0],source));
  for(const m of allMatches(rx.namedRangeBoth,text))add(resolveRange(+m[1],month(m[2]),m[3],+m[4],month(m[5]),m[6],year,m[0],source));
  for(const m of allMatches(rx.sameMonthRange,text))add(resolveRange(+m[1],month(m[3]),m[4],+m[2],month(m[3]),m[4],year,m[0],source));
  for(const m of allMatches(rx.shortNumericRange,text))add(resolveRange(+m[1],+m[3],m[4],+m[2],+m[3],m[4],year,m[0],source));
  for(const m of allMatches(rx.namedList,text)){
    const ds=[...m[1].matchAll(/\d{1,2}/g)].map(v=>iso(toYear(m[3],year),month(m[2]),+v[0]));add(listObject(ds,m[0],source));
  }
  for(const m of allMatches(rx.numericList,text)){
    const ds=[...m[1].matchAll(/\d{1,2}/g)].map(v=>iso(toYear(m[3],year),+m[2],+v[0]));add(listObject(ds,m[0],source));
  }
  for(const m of allMatches(rx.namedDate,text))specific.push(iso(toYear(m[3],year),month(m[2]),+m[1]));
  for(const m of allMatches(rx.numericDate,text))specific.push(iso(toYear(m[3],year),+m[2],+m[1]));
  // Range & explicit separate date in the same text may be a mixed advertisement; avoid automatic union.
  const uniq=[...new Map(ranges.map(r=>[r.dateMode+':'+r.startDate+':'+r.endDate+':'+r.dates.join(','),r])).values()];
  if(uniq.length===1){
    const chosen=uniq[0];
    const outside=(d)=>{
      if(!d || (d>=chosen.startDate&&d<=chosen.endDate))return false;
      // When 30 Dec — 2 Jan has no explicit year, both named-date tokens
      // initially inherit the base year, but January belongs to next year.
      if(chosen.startDate.slice(0,4)!==chosen.endDate.slice(0,4)&&d.slice(0,4)===chosen.startDate.slice(0,4)){
        const rolled=chosen.endDate.slice(0,4)+d.slice(4);
        if(rolled>=chosen.startDate&&rolled<=chosen.endDate)return false;
      }
      return true;
    };
    if(specific.some(outside))return {ambiguous:true,reason:'другая дата находится вне общего диапазона',candidates:uniq};
    return {...chosen,evidenceCount:uniq.length};
  }
  if(uniq.length>1)return {ambiguous:true,reason:'несколько независимых календарных групп',candidates:uniq};
  // Bare 11–30 or 11, 14, 20 is accepted only when the poster has an explicit
  // unambiguous MONTH HEADING, such as 'ДЕКАБРЬ 2026'. No guessing from 'новогодний'.
  if(!uniq.length && !specific.some(Boolean)) {
    const mh=text.match(new RegExp(`(?:^|\\n)\\s*(${MR})(?:\\s+(20\\d{2}))?\\s*(?=\\n|:|$)`,'iu'));
    const m=mh?month(mh[1]):0, y=mh?toYear(mh[2],year):year;
    if(m) {
      const bare=text.match(/(?<![\d.\/])([0-3]?\d)\s*-\s*([0-3]?\d)(?![\d.\/])/u);
      if(bare) {const r=rangeObject(iso(y,m,+bare[1]),iso(y,m,+bare[2]),bare[0],source);if(r)return r;}
      const lst=text.match(/(?<![\d.\/])((?:[0-3]?\d\s*(?:,|;|и)\s*)+[0-3]?\d)(?![\d.\/])/u);
      if(lst) {const d=[...lst[1].matchAll(/\d{1,2}/g)].map(z=>iso(y,m,+z[0]));const r=listObject(d,lst[0],source);if(r)return r;}
    }
  }
  const one=listObject(specific,text.slice(0,160),source);
  return one|| (specific.filter(Boolean).length===1?{dateMode:'specific',dates:[specific.find(Boolean)],startDate:specific.find(Boolean),endDate:specific.find(Boolean),raw:text.slice(0,160),source}:null);
}

// Dates are extracted from original evidence, never from generated child cards.
// Semantic cardinality remains the extractor's explicit decision.
export function readScheduleEvidence(raw, { publishedAt = 0, referenceNow = new Date(), source = 'original_text' } = {}) {
    const base = new Date(publishedAt > 0 ? publishedAt * 1000 : referenceNow);
    if (!Number.isFinite(base.getTime())) return null;
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric' }).format(base));
    let result = parseDateExpression(raw, { year, source });
    if (!result || result.ambiguous) return result;
    if (!/(?<!\d)(?:19|20|21)\d{2}(?!\d)|\d{1,2}[./]\d{1,2}[./]\d{2}(?!\d)/u.test(String(raw))) {
        const [, m, d] = result.startDate.split('-').map(Number);
        const inferred = inferEventYear({ month: m, day: d, publishedAt, referenceNow });
        const delta = inferred - Number(result.startDate.slice(0, 4));
        const shift = date => `${Number(date.slice(0,4)) + delta}${date.slice(4)}`;
        result = { ...result, startDate: shift(result.startDate), endDate: shift(result.endDate), dates: result.dates.map(shift) };
    }
    if (![result.startDate, result.endDate, ...result.dates].every(isCalendarIsoDate)) return { ambiguous: true, reason: 'invalid-calendar-date' };
    return result;
}

export function normalizeEventSchedule(value) {
    if (!value || !['continuous', 'specific'].includes(value.dateMode)) return null;
    const startDate = String(value.startDate || ''), endDate = String(value.endDate || '');
    if (!isCalendarIsoDate(startDate) || !isCalendarIsoDate(endDate) || endDate <= startDate ||
        (timestamp(endDate) - timestamp(startDate)) / 86400000 > 366) return null;
    if (value.dateMode === 'specific' && !Array.isArray(value.dates)) return null;
    const dates = value.dateMode === 'specific' ? [...new Set(value.dates)].sort() : [];
    if (value.dateMode === 'specific' && (dates.length < 2 || !dates.every(isCalendarIsoDate) || dates[0] !== startDate || dates.at(-1) !== endDate)) return null;
    return { dateMode: value.dateMode, startDate, endDate, dates,
        excludedDates: [...new Set((Array.isArray(value.excludedDates) ? value.excludedDates : []).filter(d => isCalendarIsoDate(d) && d >= startDate && d <= endDate))].sort(),
        sourceDateEvidence: Array.isArray(value.sourceDateEvidence) ? value.sourceDateEvidence : [] };
}

export function getSharedEventSchedule(event) {
    return ['shared_schedule_event', 'theater_repertoire'].includes(String(event?.structureDecision || event?._structure || '').trim())
        ? normalizeEventSchedule(event?.eventSchedule) : null;
}

export function isTheaterRepertoireEvent(event) {
    return String(event?.structureDecision || event?._structure || '').trim() === 'theater_repertoire';
}

export function validateTheaterRepertoireSchedule(event, { sourceText = '', facts = [], publishedAt = 0, referenceNow = new Date() } = {}) {
    const claimed = normalizeEventSchedule(event?.eventSchedule || event?.schedule);
    if (!claimed || (event?.date || event?.eventDate) !== claimed.startDate) return { ok: false, reason: 'invalid-theater-repertoire-schedule' };
    if (claimed.dateMode !== 'specific' || claimed.dates.length < 2) return { ok: false, reason: 'theater-repertoire-needs-multiple-dates' };
    const programItems = Array.isArray(event?.program_items || event?.programItems) ? (event.program_items || event.programItems) : [];
    if (programItems.length < 2) return { ok: false, reason: 'theater-repertoire-program-items-missing' };
    const source = normalizeScheduleQuote(sourceText);
    const normalizedFacts = completeScheduleFacts(facts).filter(f => f?.poster === true && !f?.visionError);
    const evidence = [];
    const itemDates = [];
    for (const item of programItems) {
        const title = normalizeScheduleQuote(item?.title || item?.text || '');
        const rawDate = String(item?.date || '').trim();
        const dateEvidence = String(item?.evidence || '').trim();
        const parsedDate = isCalendarIsoDate(rawDate)
            ? { dateMode: 'specific', dates: [rawDate], startDate: rawDate, endDate: rawDate }
            : readScheduleEvidence(rawDate, { publishedAt, referenceNow });
        if (!title || !parsedDate || parsedDate.ambiguous || parsedDate.startDate !== parsedDate.endDate) {
            return { ok: false, reason: 'theater-repertoire-invalid-program-item' };
        }
        const date = parsedDate.startDate;
        const matchingFacts = normalizedFacts.filter(f => quoteIsInPoster(dateEvidence, f));
        const sourceSupports = Boolean(dateEvidence && source && source.includes(normalizeScheduleQuote(dateEvidence)));
        const evidenceSchedule = dateEvidence ? readScheduleEvidence(dateEvidence, { publishedAt, referenceNow }) : null;
        const evidenceSupportsDate = evidenceSchedule && !evidenceSchedule.ambiguous &&
            (evidenceSchedule.dateMode === 'specific' ? evidenceSchedule.dates.includes(date) : date >= evidenceSchedule.startDate && date <= evidenceSchedule.endDate);
        const evidenceSupportsTitle = normalizeScheduleQuote(dateEvidence).includes(title);
        const posterSupports = matchingFacts.some(f => {
            const rows = normalizeDateProgramBindings(f.dateProgramBindings).filter(row => quoteIsInPoster(row.evidence, f));
            return rows.some(row => {
                const rowSchedule = readScheduleEvidence(row.dateText, { publishedAt, referenceNow });
                const rowTitle = normalizeScheduleQuote([row.title, row.participants, row.program].filter(Boolean).join(' '));
                return rowSchedule && !rowSchedule.ambiguous &&
                    (rowSchedule.dateMode === 'specific' ? rowSchedule.dates.includes(date) : date >= rowSchedule.startDate && date <= rowSchedule.endDate) &&
                    rowTitle.includes(title);
            });
        });
        if ((!sourceSupports && !matchingFacts.length) || !evidenceSupportsDate || (!evidenceSupportsTitle && !posterSupports)) {
            return { ok: false, reason: 'theater-repertoire-program-item-not-supported' };
        }
        itemDates.push(date);
        evidence.push({ source: sourceSupports ? 'original_text_program_item' : 'poster_program_item', raw: dateEvidence.slice(0, 1200) });
    }
    if (new Set(itemDates).size !== itemDates.length || claimed.dates.some(date => !itemDates.includes(date)) || itemDates.some(date => !claimed.dates.includes(date))) {
        return { ok: false, reason: 'theater-repertoire-date-program-map-incomplete' };
    }
    const add = (raw, origin, imageIndex = 0) => {
        if (!String(raw || '').trim()) return true;
        const parsed = readScheduleEvidence(raw, { publishedAt, referenceNow, source: origin });
        if (!parsed || parsed.ambiguous || scheduleKey(parsed) !== scheduleKey(claimed)) return false;
        evidence.push({ source: origin, imageIndex, raw: String(raw).slice(0, 8000) });
        return true;
    };
    // Date-specific repertoire blocks are intentionally checked one by one
    // above. Parsing the whole source or its full OCR as one date expression
    // would incorrectly reject the very different dates this structure models.
    const sourceSchedule = readScheduleEvidence(sourceText, { publishedAt, referenceNow });
    if (sourceSchedule && !sourceSchedule.ambiguous && scheduleKey(sourceSchedule) !== scheduleKey(claimed)) {
        return { ok: false, reason: 'theater-repertoire-source-schedule-conflict' };
    }
    const indexes = (event?.image_indexes || event?.imageIndexes || []).map(Number);
    for (const fact of completeScheduleFacts(facts).filter(f => f?.poster === true && !f?.visionError && (!indexes.length || indexes.includes(Number(f.index))))) {
        const posterSchedule = readScheduleEvidence(fact.dates, { publishedAt, referenceNow, source: 'vision_date_field' });
        if (posterSchedule && !posterSchedule.ambiguous && scheduleKey(posterSchedule) !== scheduleKey(claimed)) return { ok: false, reason: 'theater-repertoire-vision-schedule-conflict' };
        if (posterSchedule && !posterSchedule.ambiguous) evidence.push({ source: 'vision_date_field', imageIndex: Number(fact.index), raw: String(fact.dates).slice(0, 8000) });
    }
    if (!evidence.length) return { ok: false, reason: 'theater-repertoire-without-schedule-evidence' };
    return { ok: true, schedule: { ...claimed, excludedDates: [], sourceDateEvidence: evidence } };
}
export function scheduleKey(schedule) {
    return schedule ? [schedule.dateMode, schedule.startDate, schedule.endDate, ...(schedule.dates || [])].join('|') : '';
}
export function eventScheduleMatchesRange(event, fromDate, toDate) {
    const s = getSharedEventSchedule(event);
    if (!s) return false;
    const next = nextSharedEventDate(event, fromDate);
    return Boolean(next && next <= toDate);
}
export function nextSharedEventDate(event, fromDate) {
    const s = getSharedEventSchedule(event);
    if (!s) return '';
    if (s.dateMode === 'specific') return s.dates.find(d => d >= fromDate && !s.excludedDates.includes(d)) || '';
    let date = s.startDate > fromDate ? s.startDate : fromDate;
    while (date <= s.endDate && s.excludedDates.includes(date)) date = new Date(timestamp(date) + 86400000).toISOString().slice(0,10);
    return date <= s.endDate ? date : '';
}
export function sharedEventDateLabel(event) {
    const s = getSharedEventSchedule(event);
    if (!s) return '';
    const label = d => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T12:00:00Z'));
    const range = s.dateMode === 'specific' ? s.dates.map(label).join(', ') : `${label(s.startDate)} — ${label(s.endDate)}`;
    return range + (s.excludedDates.length ? ` (кроме ${s.excludedDates.map(label).join(', ')})` : '');
}

// Split at date expressions, not at newline boundaries. A date range/list is
// ONE anchor; separate date->program clauses remain separate even in prose.
export function inspectDateProgramText(raw) {
    const original = String(raw || '');
    const text = original.replace(/[–—−]/gu, '-');
    const candidates = Object.values(rx).flatMap(pattern => [...text.matchAll(pattern)]
        .map(m => ({ start: m.index, end: m.index + m[0].length, raw: m[0] })));
    candidates.sort((a,b) => a.start - b.start || b.end - a.end);
    const anchors = [];
    for (const candidate of candidates) {
        if (anchors.some(a => candidate.start < a.end && candidate.end > a.start)) continue;
        anchors.push(candidate);
    }
    const body = value => normalizeScheduleQuote(value)
        .replace(/^[\s:;,|.()—–-]+|[\s:;,|.()—–-]+$/gu, '')
        .replace(/(?:^|\s)(?:а|и|затем|также|потом|and|then)$/iu, '').trim();
    const blocks = anchors.map((a,i) => ({ dateText: original.slice(a.start,a.end), sourceSegment: original.slice(a.start,anchors[i+1]?.start ?? original.length).trim(),
        program: body(text.slice(a.end, anchors[i+1]?.start ?? text.length)) }));
    const meaningful = blocks.filter(b => b.program && !/^(?:и|а|по|с|and|to)$/iu.test(b.program));
    const distinctDates = new Set(anchors.map(a => normalizeScheduleQuote(a.raw))).size;
    const prefix = anchors.length ? body(text.slice(0, anchors[0].start)) : '';
    const dateAfterProgram = distinctDates > 1 && meaningful.length === 1 && !blocks.at(-1)?.program && prefix &&
        /[;\n]|,\s*а\s/iu.test(text.slice(anchors[0].end, anchors.at(-1).start)) && prefix !== meaningful[0].program;
    return { blocks, differentPrograms: Boolean(dateAfterProgram || (distinctDates > 1 && meaningful.length > 1 &&
        new Set(meaningful.map(b => b.program)).size > 1)) };
}

function completeScheduleFacts(facts) {
    return (Array.isArray(facts) ? facts : []).map(fact => {
        const recovered = fact?.text ? parseIndexedImageFacts(`[IMAGE ${Number(fact.index || 1)}]\n${fact.text}`)[0] : null;
        if (!recovered) return fact;
        return { ...recovered, ...fact,
            recognizedText: String(recovered.recognizedText || '').length > String(fact.recognizedText || '').length ? recovered.recognizedText : fact.recognizedText,
            scheduleKind: fact.scheduleKind || recovered.scheduleKind,
            scheduleEvidence: fact.scheduleEvidence || recovered.scheduleEvidence,
            dateProgramBindings: fact.dateProgramBindings?.length ? fact.dateProgramBindings : recovered.dateProgramBindings,
        };
    });
}

export function selectDateProgramSegment(event, { sourceText = '', facts = [], publishedAt = 0, referenceNow = new Date() } = {}) {
    const date = event?.date || event?.eventDate;
    const supports = raw => {
        const s = readScheduleEvidence(raw, { publishedAt, referenceNow });
        return s && !s.ambiguous && (s.dateMode === 'specific' ? s.dates.includes(date) : date >= s.startDate && date <= s.endDate);
    };
    const choose = blocks => {
        const matches = blocks.filter(block => supports(block.dateText));
        if (matches.length === 1) return matches[0].sourceSegment || '';
        const title = normalizeScheduleQuote(event?.title || event?.participants);
        const named = matches.filter(block => title && normalizeScheduleQuote(block.sourceSegment).includes(title));
        return named.length === 1 ? named[0].sourceSegment : '';
    };
    const fromText = choose(inspectDateProgramText(sourceText).blocks.filter(b => b.program));
    if (fromText) return fromText;
    const indexes = (event?.image_indexes || event?.imageIndexes || []).map(Number);
    for (const fact of completeScheduleFacts(facts).filter(f => f?.poster && (!indexes.length || indexes.includes(Number(f.index))))) {
        const rows = normalizeDateProgramBindings(fact.dateProgramBindings).filter(r => quoteIsInPoster(r.evidence,fact))
            .map(r => ({ dateText:r.dateText, sourceSegment:r.evidence }));
        const segment = choose(rows) || choose(inspectDateProgramText(fact.recognizedText).blocks.filter(b => b.program));
        if (segment) return segment;
    }
    return '';
}

function factHasDifferentPrograms(fact) {
    const rows = normalizeDateProgramBindings(fact?.dateProgramBindings);
    return inspectDateProgramText(fact?.recognizedText).differentPrograms ||
        (new Set(rows.map(r => normalizeScheduleQuote(r.dateText))).size > 1 &&
         new Set(rows.map(r => normalizeScheduleQuote([r.title,r.participants,r.program].join(' ')))).size > 1);
}

// The reverse guard: a proven shared poster must not be expanded into daily
// duplicates. Conflicts return unresolved, never a silently rewritten result.
export function validateScheduleCardinality(structure, events, { sourceText = '', facts = [], publishedAt = 0, referenceNow = new Date() } = {}) {
    if (structure !== 'multiple_events' || new Set(events.map(e => e.date || e.eventDate)).size < 2) return { ok: true };

    const indexes = new Set(events.flatMap(e => e.image_indexes || e.imageIndexes || []).map(Number));
    const selected = completeScheduleFacts(facts).filter(f => f?.poster === true && !f.visionError && (!indexes.size || indexes.has(Number(f.index))));
    for (const fact of selected) {
        if (fact.scheduleKind !== 'distinct_events') continue;
        const rows = normalizeDateProgramBindings(fact.dateProgramBindings).filter(row => quoteIsInPoster(row.evidence, fact));
        if (rows.length < 2) continue;
        const relevant = events.filter(e => (e.image_indexes || e.imageIndexes || []).map(Number).includes(Number(fact.index)));
        for (const event of relevant) {
            const date = event.date || event.eventDate;
            const matches = rows.filter(row => {
                const s = readScheduleEvidence(row.dateText, { publishedAt, referenceNow });
                return s && !s.ambiguous && (s.dateMode === 'specific' ? s.dates.includes(date) : date >= s.startDate && date <= s.endDate);
            });
            if (!matches.length) return { ok: false, reason: 'event-date-missing-from-poster-blocks' };
            const identity = normalizeScheduleQuote([event.title,event.participants].filter(Boolean).join(' '));
            const names = matches.flatMap(row => [row.title,row.participants]).map(normalizeScheduleQuote).filter(Boolean);
            if (names.length && !names.some(name => identity.includes(name))) return { ok: false, reason: 'event-identity-does-not-match-poster-date' };
        }
    }
    if (inspectDateProgramText(sourceText).differentPrograms) return { ok: true };
    if (!selected.length || selected.some(f => !posterHasProvenSharedProgram(f) || factHasDifferentPrograms(f))) return { ok: true };
    const schedules = selected.map(f => readScheduleEvidence(f.dates, { publishedAt, referenceNow }));
    if (schedules.some(s => !s || s.ambiguous || s.startDate === s.endDate) || new Set(schedules.map(scheduleKey)).size !== 1) return { ok: true };
    const source = readScheduleEvidence(sourceText, { publishedAt, referenceNow });
    if (source && (source.ambiguous || scheduleKey(source) !== scheduleKey(schedules[0]))) return { ok: false, reason: 'source-and-poster-schedule-conflict' };
    const shared = { structureDecision:'shared_schedule_event', eventSchedule:schedules[0] };
    if (!events.every(e => eventScheduleMatchesRange(shared, e.date || e.eventDate, e.date || e.eventDate))) return { ok: true };
    return { ok: false, reason: 'proven-shared-program-split-into-daily-cards' };
}

export function validateSharedEventSchedule(event, { sourceText = '', facts = [], publishedAt = 0, referenceNow = new Date() } = {}) {
    const claimed = normalizeEventSchedule(event?.eventSchedule || event?.schedule);
    if (!claimed || (event?.date || event?.eventDate) !== claimed.startDate) return { ok: false, reason: 'invalid-shared-schedule' };
    const evidence = [];
    if (inspectDateProgramText(sourceText).differentPrograms) return { ok: false, reason: 'different-date-specific-announcements' };
    const add = (raw, origin, imageIndex = 0) => {
        if (!String(raw || '').trim()) return true;
        const parsed = readScheduleEvidence(raw, { publishedAt, referenceNow, source: origin });
        if (!parsed) return true;
        if (parsed.ambiguous || scheduleKey(parsed) !== scheduleKey(claimed)) return false;
        evidence.push({ source: origin, imageIndex, raw: String(raw).slice(0, 8000),
            yearSource: /(?:19|20|21)\d{2}/u.test(raw) ? 'explicit' : publishedAt ? 'published_at' : 'reference_now' });
        return true;
    };
    if (!add(sourceText, 'original_text')) return { ok: false, reason: 'source-schedule-conflict' };
    const indexes = event?.image_indexes || event?.imageIndexes || [];
    const selected = completeScheduleFacts(facts).filter(f => f?.poster === true && !f?.visionError && (!indexes.length || indexes.includes(Number(f.index))));
    if (new Set(selected.map(f => Number(f.index))).size > 1) return { ok: false, reason: 'shared-schedule-needs-one-common-poster' };
    for (const fact of selected) {
        if (['distinct_events', 'uncertain'].includes(fact.scheduleKind)) return { ok: false, reason: 'poster-schedule-not-shared' };
        if (fact.scheduleKind === 'shared_program' && !posterHasProvenSharedProgram(fact)) return { ok: false, reason: 'shared-program-without-grounded-poster-blocks' };
        if (factHasDifferentPrograms(fact)) return { ok: false, reason: 'different-date-specific-poster-programs' };
        if (!add(fact.dates, 'vision_date_field', Number(fact.index)) ||
            !add(fact.recognizedText, 'poster_ocr', Number(fact.index))) {
            return { ok: false, reason: 'vision-schedule-conflict' };
        }
    }
    if (!evidence.length) return { ok: false, reason: 'shared-schedule-without-source-evidence' };
    return { ok: true, schedule: { ...claimed, excludedDates: [], sourceDateEvidence: evidence } };
}

export const SHARED_SCHEDULE_INSTRUCTION = 'Выбери shared_schedule_event и ровно одну карточку, если исходный текст и афиша анонсируют одну общую программу на несколько дат без разных программ, артистов, условий или самостоятельных анонсов по дням. Это правило не зависит от слова «корпоратив». Диапазон может быть только в полях Дата/Распознанный текст Vision: сохрани его как диапазон, не создавай карточку на каждый день. Поле schedule: {dateMode:"continuous",startDate:"YYYY-MM-DD",endDate:"YYYY-MM-DD",dates:[]} для непрерывного диапазона; для выборочных дат dateMode:"specific", dates:[точные YYYY-MM-DD], startDate и endDate — границы списка. Поле date равно startDate. Одна общая афиша НЕ доказывает shared_schedule_event. Если в тексте одного абзаца написано «31 мая — программа А, а 1 июня — программа Б», или это разные графические блоки на одной картинке, выбирай multiple_events. Структура расписания и Связи дат и программ от Vision помогают сохранить соответствие даты и содержания; не смешивай общий список артистов между датами. При общей афише разрешено использовать один image_index для нескольких самостоятельных карточек. Окно бронирования, продажи или приёма заявок не является расписанием событий. При разных программах по датам выбирай multiple_events. При конфликте OCR, поля даты Vision и исходного текста либо неясном назначении диапазона выбирай uncertain. Сохрани полный общий текст в source_segment. Не используй ранее созданные карточки как доказательство дат.';

export const THEATER_REPERTOIRE_INSTRUCTION = 'Для театрального репертуара выбирай theater_repertoire: одна второстепенная карточка с несколькими подтвержденными датами и программами. Сохрани даты и соответствующую программу в eventSchedule и program_items; дата карточки равна ближайшей будущей дате. Не создавай отдельную карточку на каждую дату и не смешивай разные программы без доказательства из исходного текста или афиши.';


// Refresh old multi-date cache entries on the next normal Vision pass. A
// cached boolean "poster" alone cannot prove a shared or distinct schedule.
export function posterScheduleFactNeedsRefresh(fact) {
    if (fact?.poster !== true) return false;
    if (fact.scheduleKind === 'uncertain') return true;
    if (fact.scheduleKind === 'shared_program') return !posterHasProvenSharedProgram(fact);
    if (fact.scheduleKind === 'distinct_events') return normalizeDateProgramBindings(fact.dateProgramBindings).length < 2;
    const dates = readScheduleEvidence([fact.dates, fact.recognizedText].filter(Boolean).join('\n'));
    return Boolean(dates && (dates.ambiguous || dates.startDate !== dates.endDate));
}
