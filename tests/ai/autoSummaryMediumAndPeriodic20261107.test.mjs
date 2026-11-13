import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseAutoSummaryCommand,resolveAutoSummaryRunWindow,getNextAutoSummaryRunAt} from '../../src/features/ai/autoSummaryRouting.js';
import {extractAutoSummaryModifiers,normalizeAutoSummaryPreferences,dueAutoSummaryPeriodicPeriods,MEDIUM_VK_MESSAGE_LIMIT,MEDIUM_SUMMARY_PROMPT,mediumSummaryMessage} from '../../src/features/ai/autoSummaryPreferences.js';

const zone='Europe/Moscow';
test('«средне» и «среднее» равносильны и не меняют 4 HH:MM',()=>{
 for(const word of ['средне','среднее']){
  const parsed=parseAutoSummaryCommand('Гигорейв авторезюме 9:00 17:00 21:00 23:59 '+word+' вкл');
  assert.equal(parsed.matched,true);assert.equal(parsed.action,'enable');assert.equal(parsed.mode,'custom');
  assert.equal(parsed.preferences.medium,true);assert.deepEqual(parsed.schedule,['09:00','17:00','21:00','23:59']);
  const alone=parseAutoSummaryCommand('Гигорейв авторезюме '+word);
  assert.equal(alone.action,'preferences');assert.equal(alone.preferences.medium,true);
 }
});
test('period modifiers do not contaminate intraday schedule',()=>{
 const input='Гигорейв авторезюме 9:00 17:00 21:00 23:59 дневное недельное 20:00 месячное 18:00 среднее вкл';
 const command=parseAutoSummaryCommand(input);
 assert.deepEqual(command.schedule,['09:00','17:00','21:00','23:59']);
 assert.deepEqual(command.preferences,{
  dailyEnabled:true,weeklyEnabled:true,weeklyAt:'20:00',monthlyEnabled:true,monthlyAt:'18:00',medium:true
 });
 const custom=parseAutoSummaryCommand('авторезюме недельное 19:30 месячное 17:15 средне');
 assert.equal(custom.action,'preferences');assert.equal(custom.preferences.weeklyAt,'19:30');
 assert.equal(custom.preferences.monthlyAt,'17:15');
});
test('four nonoverlapping intraday slices begin at midnight, never overlap',()=>{
 const schedule=['09:00','17:00','21:00','23:59'],times=['09:00','17:00','21:00','23:59'];
 const utc=['2026-11-07T06:00:00Z','2026-11-07T14:00:00Z','2026-11-07T18:00:00Z','2026-11-07T20:59:00Z'];
 const starts=['2026-11-06T21:00:00Z',...utc.slice(0,-1)];
 for(let k=0;k<times.length;k++){
  const time=Date.parse(utc[k])/1000;
  const win=resolveAutoSummaryRunWindow({mode:'custom',schedule,scheduledTimestamp:time,timeZone:zone});
  assert.equal(win.startTimestamp,Date.parse(starts[k])/1000,times[k]);
  assert.equal(win.endTimestamp,time,times[k]);
  assert.equal(win.slotLabel,times[k]);
 }
 assert.equal(getNextAutoSummaryRunAt({mode:'custom',schedule,afterTimestamp:Date.parse('2026-11-07T10:00:00Z')/1000,timeZone:zone}),Date.parse(utc[1])/1000);
});
test('daily midnight summarizes previous calendar day, not current',()=>{
 const prefs={dailyEnabled:true};
 const before=dueAutoSummaryPeriodicPeriods(new Date('2026-11-07T20:59:59Z'),prefs,zone);
 assert.equal(before.some(x=>x.kind==='daily'&&x.key==='2026-11-07'),false);
 const due=dueAutoSummaryPeriodicPeriods(new Date('2026-11-07T21:00:00Z'),prefs,zone);
 const day=due.find(x=>x.kind==='daily'&&x.key==='2026-11-07');
 assert.ok(day);assert.equal(day.startAt,Date.parse('2026-11-06T21:00:00Z')/1000);
 assert.equal(day.endAt,Date.parse('2026-11-07T21:00:00Z')/1000);
});
test('weekly Sunday at 20:00 and monthly at 18:00 on the last day',()=>{
 const weekDue=dueAutoSummaryPeriodicPeriods(new Date('2026-11-08T17:00:00Z'),{weeklyEnabled:true},zone);
 const week=weekDue.find(x=>x.key==='2026-11-08'&&x.kind==='weekly');
 assert.ok(week);assert.equal(week.startAt,Date.parse('2026-11-01T21:00:00Z')/1000);
 assert.equal(week.endAt,Date.parse('2026-11-08T17:00:00Z')/1000);
 const monthDue=dueAutoSummaryPeriodicPeriods(new Date('2026-11-30T15:00:00Z'),{monthlyEnabled:true},zone);
 const month=monthDue.find(x=>x.key==='2026-11'&&x.kind==='monthly');
 assert.ok(month);assert.equal(month.startAt,Date.parse('2026-10-31T21:00:00Z')/1000);
 assert.equal(month.endAt,Date.parse('2026-11-30T15:00:00Z')/1000);
});
test('only scheduled future releases after activation; prevent historical flood',()=>{
 const when=Date.parse('2026-11-30T15:01:00Z')/1000;
 const due=dueAutoSummaryPeriodicPeriods(new Date(when*1000),
  {dailyEnabled:true,weeklyEnabled:true,monthlyEnabled:true,updatedAt:when},zone);
 assert.equal(due.length,0);
});
test('medium is a PROMPT instruction and hard cap is 2048 for the complete message',()=>{
 assert.equal(MEDIUM_VK_MESSAGE_LIMIT,2048);
 assert.match(MEDIUM_SUMMARY_PROMPT,/2048/u);
 assert.match(MEDIUM_SUMMARY_PROMPT,/700–1200/u);
 assert.equal(mediumSummaryMessage('Заголовок\n\n'+('Содержание '.repeat(2000))).length<=2048,true);
 assert.equal(mediumSummaryMessage('Короткий отчёт'),'Короткий отчёт');
});
test('production uses custom scheduler and does not double-send fixed calendar slots',()=>{
 const source=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(source,/runAutoSummaryTick\(\{customOnly:true\}\)/u);
 assert.match(source,/runConfiguredAutoSummaryPeriodicTick\(\)/u);
 assert.match(source,/getDueAutoSummarySettings\(now\)\.filter\(row => !customOnly \|\| row.mode === 'custom'\)/u);
 assert.match(source,/if \(!settings \|\| settings.mode === 'custom'\) return false/u);
 assert.match(source,/if\(getAutoSummaryPreferences\(settings.peerId\)\.medium\)text=mediumSummaryMessage\(text\)/u);
 assert.match(source,/saveAutoSummaryRun\(\{/u);
});