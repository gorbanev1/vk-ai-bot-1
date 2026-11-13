// A screening is an on-site event. A relay/broadcast of another event is not.
export const BROADCAST_EXCLUSION_INSTRUCTION = 'Трансляции спортивных матчей, концертов, эфиров и иных событий не являются мероприятиями для этой афиши: верни not_event, events=[] (для Vision: Это афиша события: нет). Матч Лиги Европы/РПЛ в пабе — трансляция, а не матч на стадионе. Кинопоказ/показ фильма является событием. В смешанном анонсе исключи только трансляции, сохрани самостоятельные концерты, вечеринки и кинопоказы; упоминание дополнительного онлайн-эфира не отменяет очный концерт.';
const CINEMA=/кинопоказ|показ\s+(?:кино|фильм)|киносеанс|смотрим\s+(?:кино|фильм)/iu;
const LIVE=/концерт|кавер[- ]?(?:групп|б[еэ]нд)|вечерин|дискотек|выступлен|живая\s+музыка|стендап|квиз|рейв|перформанс|спектакл|инсталляци/iu;
const BROADCAST=/трансляци[яиюйе]|трансляций|прям(?:ой|ом|ого)\s+эфир|live\s*stream|broadcast|смотрим\s+(?:вместе\s+)?(?:матч|футбол|хоккей)|показ\s+(?:матч|футбол|хоккей)/iu;
const SPORT=/лига\s+(?:европы|чемпионов)|чемпионат\s+(?:россии|мира|европы)|(?:^|\W)рпл(?:\W|$)|уефа|uefa|футбол|хоккей/iu;
const PUB=/(?:^|[^\p{L}])(?:паб|pub|бар|ресторан|рестобар|o.?hara|о.?хара)(?:$|[^\p{L}])/iu;
const clean=value=>String(value||'').replace(/(?:без|не\s+будет|никакой)\s+(?:(?:прямой|онлайн)\s+)?трансляци[ийюя]/giu,'');
export function isBroadcastOnlyAnnouncement(value) {
 const text=clean(value);
 return BROADCAST.test(text)&&!CINEMA.test(text)&&!LIVE.test(text.replace(/трансляци\p{L}*\s+(?:концерт\p{L}*|выступлен\p{L}*|рейв\p{L}*)/giu,''));
}
export function isBroadcastEvent(event,{sourceText=''}={}) {
 const title=clean(event?.title||event?.name),own=clean([event?.description,event?.announcement,event?.evidence,event?.sourceSegment].filter(Boolean).join('\n'));
 if(CINEMA.test(title))return false;
 if(BROADCAST.test(title)){
  // A monthly mixed calendar must be split, not erased as a broadcast.
  if(/афиша|программа/iu.test(title)&&LIVE.test(own))return false;
  return true;
 }
 // Competition schedules advertised inside a pub cannot be on-site matches.
 if(SPORT.test(title+' '+own)&&PUB.test(String(event?.venue||''))&&!LIVE.test(title)&&!CINEMA.test(own))return true;
 if(LIVE.test(title))return false;
 if(isBroadcastOnlyAnnouncement(own))return true;
 return isBroadcastOnlyAnnouncement(sourceText);
}
