import { createHash } from 'node:crypto';
export const EVENT_CARD_LIMITS = Object.freeze({ vk: 4096, telegram: 1024 });
export const EVENT_CARD_RESERVE = Object.freeze({ vk: 100, telegram: 24 });
const VERSION = 7;
const MARKER = '{{ANNOUNCEMENT}}';
let services = {};
const pending = new Map();
export function configureEventAnnouncementCopies(options) { services = options || {}; }
// Remove capture UI only. Do not rewrite the announcement, strip its facts,
// collapse paragraphs, or use an AI-generated description instead of the post.
export function cleanOriginalEventAnnouncement(value) {
    let source = String(value ?? '').replace(/\r\n?/gu, '\n');
    // Old multi-event segments can contain the Vision protocol instead of the
    // announcement. Require both an OCR marker and several schema labels:
    // ordinary announcements with "Время:" or "Место:" remain untouched.
    const labels = [...source.matchAll(/^(?:Время|Начало|Окончание|Место|Город|Населенный пункт|Адрес|Участники|Цена|Возраст|Программа|Теги):[^\n]*/gimu)];
    const ocr = /(?:^|\n)Распознанный текст:\s*([\s\S]*)/iu.exec(source);
    if (ocr && new Set(labels.map(match => match[0].split(':')[0].toLowerCase())).size >= 4) {
        source = [source.slice(0, labels[0].index).trim(), ocr[1].trim()].filter(Boolean).join('\n');
    }
    return source
        .replace(/^\s*https?:\/\/(?:vk\.(?:ru|com)|t\.me)\/\S+[^\S\n]*\n+/iu, '')
        .trim()
        .replace(/^[^\n]{0,160}?\s+и\s+ещ[её]\s+\d+\s+автор(?:а|ов)?\s+Действия\s+/iu, '')
        .replace(/\s+Оценили\s+\d+\s+(?:человек|человека|людей)\s+Лайк[\s\S]*$/iu, '')
        .replace(/(?:^|\n)\s*\[(?:Факты с афиши|Текст\/факты с изображений|IMAGE\s+\d+)[\s\S]*$/iu, '')
        .replace(/^(?:VIEW IN TELEGRAM|Please open Telegram to view this post|Действия)\s*$/gimu, '')
        .replace(/\n{3,}/gu, '\n\n').trim();
}

export function getOriginalEventAnnouncement(event, sourceText = '') {
    const multi = Boolean(event?.isMultiAnnouncement || event?.structureDecision === 'multiple_events');
    return cleanOriginalEventAnnouncement(multi
        ? (event.sourceType === 'manual' || event.source_type === 'manual')
            ? sourceText || event.originalAnnouncement || event.sourceText || event.source_text || event.description || event.announcement
            : event.sourceSegment || event.source_segment || event.description || event.announcement
        : sourceText || event?.originalAnnouncement || event?.sourceText || event?.rawSource || event?.description || event?.announcement);
}


const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const channelOf = p => /^(tg|telegram)$/i.test(p) ? 'telegram' : 'vk';
const limitOf = p => EVENT_CARD_LIMITS[p] - EVENT_CARD_RESERVE[p];
export function eventCardModelLengthContract(hardBudget,attempt=1){
 const hardMaxChars=Math.max(0,Math.floor(Number(hardBudget)||0));
 // A nearly full announcement is the TARGET, the remaining space is the MAX.
 // A retry must not waste ~28% of the space by artificially shrinking the cap.
 const targetMinChars=Math.floor(hardMaxChars*0.90);
 const targetMaxChars=Math.floor(hardMaxChars*0.98);
 return {hardMaxChars,modelMaxChars:hardMaxChars,targetMinChars,targetMaxChars};
}
function lastWordWithin(text,max){
 const source=String(text||'').trim(),limit=Math.max(0,Math.floor(max));
 if(source.length<=limit)return source;
 if(limit<=1)return '';
 const part=source.slice(0,limit-1);
 const last=part.lastIndexOf(' ');
 return (last>Math.floor(limit*0.46)?part.slice(0,last):part).trimEnd()+'…';
}
// Source-extractive safety net. No AI-invented facts; original stays in DB.
export function extractSourceBoundedAnnouncement(original,maxLength){
 const max=Math.max(0,Math.floor(Number(maxLength)||0));
 const source=cleanOriginalEventAnnouncement(original);
 if(!source||max===0)return '';
 if(source.length<=max)return source;
 const candidates=[];
 for(const paragraph of source.split(/\n+/u).map(x=>x.trim()).filter(Boolean)){
  if(/^(?:название|дата|время|место|город|адрес)\s*:/iu.test(paragraph))continue;
  const sentences=paragraph.split(/(?<=[.!?…])\s+(?=[А-ЯЁA-Z0-9«"\[])/u);
  for(const s of sentences){
   const item=s.trim().replace(/^Описание\s*:\s*/iu,'');
   if(item)candidates.push(item);
  }
 }
 const chosen=[];let used=0;
 for(const line of candidates){
  if(chosen.some(x=>x===line))continue;
  const delim=chosen.length?'\n':'';
  if(used+delim.length+line.length<=max){chosen.push(line);used+=delim.length+line.length;continue}
  const remains=max-used-delim.length;
  if(remains>=75){chosen.push(lastWordWithin(line,remains));break}
 }
 const result=chosen.join('\n').trim();
 return result||lastWordWithin(candidates[0]||source,max);
}
function pendingError(reason) {
    return Object.assign(new Error('Карточка ещё не подготовлена: ' + reason), {code:'EVENT_CARD_PREPARATION_PENDING'});
}
function layoutInfo(event, platform) {
    const raw = services.render(event, platform, MARKER);
    const key = 'event-card-layout:v5:' + hash([platform, raw]);
    const saved = services.load?.(key);
    const template = saved?.template || raw;
    return { key, raw, template, overhead: template.length - MARKER.length };
}
function specification(event, original) {
    const layouts = Object.fromEntries(['vk','telegram'].map(p => [p,layoutInfo(event,p)]));
    const budgets = {};
    for (const p of ['vk','telegram']) {
        // The entire card is rendered with the ANNOUNCEMENT marker first.
        // It includes headers, date/time, price, venue, links and separators.
        // Telegram counts visible text AFTER HTML parsing; HTML tag bytes are not
        // caption characters. Only actual visible additions may be deducted.
        const expansion = p === 'vk'
            ? Number(services.markupExpansion?.(event,p)||0)
            : Number(services.telegramCaptionExpansion?.(event,layouts[p].template)||0);
        budgets[p] = Math.max(0, limitOf(p) - layouts[p].overhead - Math.max(0,expansion));
    }
    const shared = Math.min(budgets.vk,budgets.telegram);
    budgets.vk = budgets.telegram = shared;
    const key = 'event-announcement-copies:' + hash([VERSION,original,budgets,layouts.vk.template,layouts.telegram.template]);
    return {key,budgets,layouts};
}
function validateFinishedCard(event,spec,shared){
 for(const p of ['vk','telegram']){
  const template=spec.layouts[p].template;
  const card=template.replace(MARKER,()=>shared);
  const extra=p==='vk'
   ?Number(services.markupExpansion?.(event,p)||0)
   :Number(services.telegramCaptionExpansion?.(event,card)||0);
  const occupied=card.length+Math.max(0,extra);
  if(occupied>limitOf(p))return {ok:false,platform:p,occupied,maximum:limitOf(p),excess:occupied-limitOf(p)};
 }
 return {ok:true};
}
export function readEventAnnouncementCopies(event) {
    if (!services.render) return null;
    return services.load?.(specification(event,getOriginalEventAnnouncement(event)).key)||null;
}
export function selectEventAnnouncement(event, platform) {
    const original = getOriginalEventAnnouncement(event);
    if (!services.render) return original;
    const spec = specification(event,original), p=channelOf(platform);
    if (original.length <= spec.budgets[p]) return original;
    const copy = services.load?.(spec.key)?.[p];
    if (typeof copy === 'string' && copy.trim() && copy.length <= spec.budgets[p]) return copy;
    throw pendingError('требуется сокращение анонса моделью');
}
export function renderBudgetedEventCard(event, platform, announcement, raw) {
    const p=channelOf(platform);
    const layout=layoutInfo(event,p);
    const text=layout.template === layout.raw ? raw : layout.template.replace(MARKER,()=>announcement);
    const expansion=p==='vk'?Number(services.markupExpansion?.(event,p)||0):Number(services.telegramCaptionExpansion?.(event,text)||0);
    if(text.length+Math.max(0,expansion)>limitOf(p)) throw pendingError('превышен лимит полной карточки: '+(text.length+Math.max(0,expansion))+' > '+limitOf(p));
    return text;
}
async function ensureLayout(event, original, platform) {
    const info=layoutInfo(event,platform), reserveBody=Math.min(original.length,80);
    if(info.overhead+reserveBody<=limitOf(platform)) return;
    const budget=Math.min(600,limitOf(platform)-reserveBody);
    const urls=info.raw.match(/https?:\/\/[^\s<>]+/gu)||[];
    const primary=[event.canonicalPostUrl,event.sourceUrl,event.sourceOriginalUrl].find(x=>x&&info.raw.includes(x))||urls.at(-1)||'';
    let previousError='';
    for(let attempt=1;attempt<=2;attempt++) {
        try {
            const response=await services.editMetadata?.({event,template:info.raw,marker:MARKER,budget,platform,requiredUrl:primary,attempt,previousError});
            const template=String(response?.template||'').trim();
            if(template.split(MARKER).length!==2||template.length-MARKER.length>budget||
                (primary&&!template.includes(primary))||
                (template.match(/https?:\/\/[^\s<>]+/gu)||[]).some(url=>!urls.includes(url))) {
                throw Error('Невалидный шаблон: длина, маркер или ссылка источника');
            }
            services.save?.(info.key,{template});
            if(!services.load?.(info.key)) throw Error('Шаблон не сохранён');
            return;
        } catch(error) {previousError=String(error?.message||error);}
    }
    throw pendingError('не удалось сократить служебные поля: '+previousError);
}
export async function prepareEventAnnouncementCopies(events,{sourceText='',ensureSummaries=true,cacheOnly=false}={}) {
    const result=[];
    for(const event of events||[]) {
        const multi=Boolean(event?.isMultiAnnouncement||event?.structureDecision==='multiple_events'||(sourceText&&events.length>1));
        const original=getOriginalEventAnnouncement({...event,isMultiAnnouncement:multi},sourceText);
        const prepared={...event,isMultiAnnouncement:multi,description:original,originalAnnouncement:original,...(multi?{sourceSegment:original}:{})};
        if(!services.render){result.push(prepared);continue;}
        try {
            if(!cacheOnly) for(const p of ['vk','telegram']) await ensureLayout(prepared,original,p);
            const spec=specification(prepared,original);
            let copies=services.load?.(spec.key);
            const fallbackExpired=Boolean(copies?.sourceFallback)&&Date.now()-Number(copies?.createdAt||0)>30*60_000;
            const needsBody=original.length>spec.budgets.telegram&&(!copies?.telegram||copies.telegram.length>spec.budgets.telegram||fallbackExpired);
            if(!cacheOnly&&(needsBody||(ensureSummaries&&(!copies?.shortSummary||!copies?.ultraShortSummary)))) {
                if(!pending.has(spec.key)) pending.set(spec.key,(async()=>{
                    let previousError='', best=null;
                    for(let attempt=1;attempt<=2;attempt++){
                        try{
                            const edited=await services.edit?.({event:prepared,original,budgets:spec.budgets,attempt,previousError});
                            if(!edited) throw Error('Модель не вернула текст');
                            const shared=original.length<=spec.budgets.telegram?original:String(edited.shared||edited.telegram||edited.vk||'').trim();
                            const next={version:VERSION,original,vk:shared,telegram:shared,shortSummary:String(edited.shortSummary||'').trim(),ultraShortSummary:String(edited.ultraShortSummary||'').trim()};
                            if(original&&!shared)throw Error('Пустой анонс недопустим.');
                            if(shared.length>spec.budgets.telegram)
                                throw Error('Ответ модели '+shared.length+' символов при жёстком максимуме '+spec.budgets.telegram+'; превышение '+(shared.length-spec.budgets.telegram)+'.');
                            const finished=validateFinishedCard(prepared,spec,shared);
                            if(!finished.ok)throw Error('Полная '+finished.platform+' карточка: '+finished.occupied+' из '+finished.maximum+', превышение '+finished.excess+'.');
                            if(!next.shortSummary)next.shortSummary=extractSourceBoundedAnnouncement(shared,280);
                            if(!next.ultraShortSummary)next.ultraShortSummary=extractSourceBoundedAnnouncement(shared,160);
                            if (!best || shared.length > best.telegram.length) best = next;
                            // A valid short answer is a safety copy; once try to
                            // use the remaining budget more fully without invention.
                            const targetMin=Math.floor(spec.budgets.telegram*0.90);
                            if(attempt===1&&original.length>spec.budgets.telegram&&shared.length<targetMin){
                                previousError='Ответ слишком короткий: '+shared.length+' символов при целевом минимуме '+targetMin+
                                    ' и абсолютном максимуме '+spec.budgets.telegram+'. Сохрани больше исходных фактов.';
                                continue;
                            }
                            services.save?.(spec.key,best);
                            return best;
                        }catch(error){previousError=String(error?.message||error);}
                    }
                    if (best) { services.save?.(spec.key,best); return best; }
                    const budget=spec.budgets.telegram;
                    const fallback=extractSourceBoundedAnnouncement(original,budget);
                    const finished=fallback?validateFinishedCard(prepared,spec,fallback):{ok:false};
                    if(fallback&&finished.ok){
                        const safe={version:VERSION,original,vk:fallback,telegram:fallback,sourceFallback:true,createdAt:Date.now(),
                            shortSummary:extractSourceBoundedAnnouncement(fallback,280),
                            ultraShortSummary:extractSourceBoundedAnnouncement(fallback,160)};
                        services.save?.(spec.key,safe);
                        services.warn?.('source-extractive-fallback',{sourceUrl:prepared.sourceUrl,
                            originalChars:original.length,descriptionChars:fallback.length,hardMax:budget,previousError});
                        return safe;
                    }
                    throw pendingError('невозможно уместить обязательные поля полной карточки: '+previousError);
                })().finally(()=>pending.delete(spec.key)));
                copies=await pending.get(spec.key);
            }
            if(copies) Object.assign(prepared,{shortSummary:copies.shortSummary,ultraShortSummary:copies.ultraShortSummary});
            if(needsBody&&!copies) prepared.announcementPreparationError='Требуется сокращение моделью';
        }catch(error){
            prepared.announcementPreparationError=String(error?.message||error);
            services.warn?.('preparation-pending',{sourceUrl:prepared.sourceUrl,error:prepared.announcementPreparationError});
        }
        result.push(prepared);
    }
    return result;
}
