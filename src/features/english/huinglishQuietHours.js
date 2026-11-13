// Nightly pause for all HuInglish lesson and quiz DROPS.
// The pause is local to the configured HuInglish time zone and does NOT count
// toward lesson / quiz intervals. Ordinary chat replies are not paused.
export const HUINGLISH_QUIET_START_MINUTE = 1*60+30; // group
export const HUINGLISH_QUIET_END_MINUTE = 6*60+30; // group
export const HUINGLISH_PRIVATE_QUIET_START_MINUTE = 21*60+30;
export const HUINGLISH_PRIVATE_QUIET_END_MINUTE = 10*60;
export const HUINGLISH_DEFAULT_TIME_ZONE = 'Europe/Moscow';

const formatterCache = new Map();
function localParts(epoch, timeZone) {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
        formatterCache.set(timeZone, formatter);
    }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch))
        .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const day = [parts.year, String(parts.month).padStart(2,'0'), String(parts.day).padStart(2,'0')].join('-');
    return {...parts,date:day,minuteOfDay:parts.hour*60+parts.minute};
}
function localToEpoch(day, minute, timeZone) {
    const [year,month,date] = day.split('-').map(Number);
    const naive=Date.UTC(year,month-1,date,Math.floor(minute/60),minute%60);
    // Iterate UTC/local offset instead of assuming server or browser time zone.
    let guess=naive;
    for(let attempt=0;attempt<4;attempt++){
        const p=localParts(guess,timeZone);
        const observed=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
        const adjusted=guess+(naive-observed);
        if(Math.abs(adjusted-guess)<1000) return adjusted;
        guess=adjusted;
    }
    return guess;
}
function yesterday(day) {
    const [y,m,d]=day.split('-').map(Number);
    return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10);
}
function tomorrow(day) {
    const [y,m,d]=day.split('-').map(Number);
    return new Date(Date.UTC(y,m-1,d+1)).toISOString().slice(0,10);
}
// Quiet hours depend on audience: private 21:30..10:00; groups 01:30..06:30.
// Start inclusive and end exclusive (Moscow by default).
export function huinglishQuietWindow(at,timeZone=HUINGLISH_DEFAULT_TIME_ZONE,audience='group') {
    const loc=localParts(at,timeZone),day=loc.date,m=loc.minuteOfDay;
    const privateChat=audience==='private';
    const startMinute=privateChat?HUINGLISH_PRIVATE_QUIET_START_MINUTE:HUINGLISH_QUIET_START_MINUTE;
    const endMinute=privateChat?HUINGLISH_PRIVATE_QUIET_END_MINUTE:HUINGLISH_QUIET_END_MINUTE;
    // Group pause is within the SAME day; private pause crosses midnight.
    if(!privateChat){
        const quiet=m>=startMinute&&m<endMinute;
        const nextDay=m>=endMinute?tomorrow(day):day;
        return {quiet,
            start:localToEpoch(nextDay,startMinute,timeZone),
            end:localToEpoch(nextDay,endMinute,timeZone)};
    }
    const late=m>=startMinute;
    const early=m<endMinute;
    if(late){
        return {quiet:true,
            start:localToEpoch(day,startMinute,timeZone),
            end:localToEpoch(tomorrow(day),endMinute,timeZone)};
    }
    if(early){
        return {quiet:true,
            start:localToEpoch(yesterday(day),startMinute,timeZone),
            end:localToEpoch(day,endMinute,timeZone)};
    }
    return {quiet:false,
        start:localToEpoch(day,startMinute,timeZone),
        end:localToEpoch(tomorrow(day),endMinute,timeZone)};
}
export function isHuinglishQuietTime(at,timeZone=HUINGLISH_DEFAULT_TIME_ZONE,audience='group') {
    return huinglishQuietWindow(at,timeZone,audience).quiet;
}
export function nextHuinglishActiveTime(at,timeZone=HUINGLISH_DEFAULT_TIME_ZONE,audience='group') {
    const window=huinglishQuietWindow(at,timeZone,audience);
    return window.quiet?window.end:at;
}
// Active-time intervals exclude the quiet window of the recipient.
// interval crosses the pause, the unfinished portion resumes at 10:00.
export function addHuinglishActiveMilliseconds(start,duration,timeZone=HUINGLISH_DEFAULT_TIME_ZONE,audience='group') {
    if(!Number.isFinite(start)||!Number.isFinite(duration)||duration<0)
        throw new RangeError('Invalid HuInglish active-time interval');
    let time=nextHuinglishActiveTime(start,timeZone,audience),remaining=duration;
    for(let iteration=0;iteration<1000;iteration++) {
        const window=huinglishQuietWindow(time,timeZone,audience);
        if(window.quiet){time=window.end;continue}
        const activeAvailable=Math.max(0,window.start-time);
        if(remaining<activeAvailable) return time+remaining;
        remaining-=activeAvailable;
        // Zero duration exactly at a 21:30 boundary has to wait until 10:00.
        time=window.end;
        if(remaining===0) return time;
    }
    throw new Error('HuInglish quiet-hours calendar exceeded maximum iterations');
}
export function huinglishActiveElapsedMilliseconds(start,end,timeZone=HUINGLISH_DEFAULT_TIME_ZONE,audience='group') {
    if(end<=start)return 0;
    let cursor=start,total=0;
    for(let iterations=0;cursor<end&&iterations<1000;iterations++){
        const window=huinglishQuietWindow(cursor,timeZone,audience);
        if(window.quiet){cursor=Math.min(end,window.end);continue}
        const next=Math.min(end,window.start);
        total+=next-cursor;
        cursor=next;
    }
    return total;
}
