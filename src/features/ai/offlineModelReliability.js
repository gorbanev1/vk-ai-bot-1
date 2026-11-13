import fs from 'node:fs';
import path from 'node:path';
const file=path.resolve('data/model-reliability-offline.json');
const caps=['text','vision','image','audio-transcription'];
const id=(p,e,m,c)=>[p,e,m,c].map(x=>String(x||'').toLowerCase()).join('|');
const wilson=(s,n)=>{if(!n)return 0;const p=s/n,z=1.96;return Math.max(0,(p+z*z/(2*n)-z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n));};
export function buildOfflineModelReport(reports=[],discovered=[],voices=[],healthSamples=[]){
 const stats=new Map();
 const add=(p,e,m,c,yes,when='',latency=0,source='audit',count=1)=>{
  if(!p||!m||!caps.includes(c))return;
  const k=id(p,e,m,c);
  if(!stats.has(k))stats.set(k,{provider:p,envName:e,model:m,capability:c,attempts:0,successes:0,lastSuccess:'',lastSeen:'',latencySum:0,latencyCount:0,origin:[]});
  const v=stats.get(k);v.attempts+=count;if(yes){v.successes+=count;v.lastSuccess=String(when)>v.lastSuccess?String(when):v.lastSuccess;if(latency>0){v.latencySum+=latency;v.latencyCount++;}}
  v.lastSeen=String(when)>v.lastSeen?String(when):v.lastSeen;if(!v.origin.includes(source))v.origin.push(source);
 };
 for(const r of reports){
  const at=r.checkedAt||'';
  for(const c of ['text','image']){
   for(const m of r[c+'Results']||[]){
    for(const t of Object.values(m.transports||{})){
     if(!t||typeof t.ok!=='boolean'||!t.transport)continue;
     const ok=c==='text'?Boolean(t.ok&&t.status>=200&&t.status<300&&(t.instructionCompliant===true||String(t.textSample||'').trim()==='GIGORAVE_AUDIT_OK')):
       Boolean(t.ok&&t.status>=200&&t.status<300&&t.imageBytes>0&&(String(t.mimeType||'').startsWith('image/')||t.imagePath));
     add(m.provider,m.envName,m.model,c,ok,at,t.elapsedMs,'audit');
    }
   }
  }
 }
 for(const m of discovered){
  if(m.qualification_status!=='qualified')continue;
  let j={};try{j=JSON.parse(m.qualification_json||'{}')}catch{}
  for(const [cap,result] of Object.entries(j.tests||{})){
   if(!caps.includes(cap)||!Boolean(result?.keep||result?.ok))continue;
   if((stats.get(id(m.provider,m.env_name,m.model,cap))?.successes||0)>0)continue;
   add(m.provider,m.env_name,m.model,cap,true,j.testedAt||new Date(Number(m.qualified_at||0)*1000).toISOString(),result.elapsedMs,'qualified');
  }
 }
 for(const v of voices){
  const full=String(v.model||''),at=full.lastIndexOf(':');
  if(at<0||v.status!=='ok'||String(v.transcript||'').trim().length<2)continue;
  const model=full.slice(at+1),raw=full.slice(0,at);
  if(!/(?:whisper|transcrib|speech)/iu.test(model))continue;
  const env=raw==='groq-audio'?'GROQ_API_KEY_1':raw;
  const provider=env.startsWith('GROQ')?'groq':env.startsWith('OPENAI_COMPAT')?'openai-compatible':'audio';
  add(provider,env,model,'audio-transcription',true,new Date(Number(v.updated_at||0)*1000).toISOString(),0,'real-transcript');
 }
 for(const h of healthSamples){if(!['text','vision'].includes(h.capability))continue;add('openai-compatible','OPENAI_COMPAT_API_KEY','gpt-6-luna',h.capability,Boolean(h.ok),h.at,h.durationMs,'stored-luna-health');}
 const all=[...stats.values()].map(v=>({...v,enabled:v.successes>0,successRate:+(v.successes/v.attempts).toFixed(4),reliability:+wilson(v.successes,v.attempts).toFixed(4),meanSuccessMs:v.latencyCount?Math.round(v.latencySum/v.latencyCount):null}));
 all.sort((a,b)=>Number(b.enabled)-Number(a.enabled)||b.reliability-a.reliability||b.successes-a.successes||a.model.localeCompare(b.model));
 const groups=Object.fromEntries(caps.map(c=>[c,all.filter(x=>x.capability===c)]));
 return {version:1,createdAt:new Date().toISOString(),source:'saved reports and real transcript cache, offline only',scannedAudits:reports.length,groups,
 totals:Object.fromEntries(caps.map(c=>[c,{kept:groups[c].filter(x=>x.enabled).length,excluded:groups[c].filter(x=>!x.enabled).length}]))};
}
let cached;
export function getOfflineModelReport(){
 if(cached)return cached;
 try{cached=JSON.parse(fs.readFileSync(file,'utf8'));return cached;}catch{return null;}
}
export function isOfflineModelAllowed({provider,envName,model,capability}){
 const r=getOfflineModelReport();if(!r)return true;
 return (r.groups?.[capability]||[]).some(x=>x.enabled&&id(x.provider,x.envName,x.model,x.capability)===id(provider,envName,model,capability));
}
export function getOfflineModelReliability({provider,envName,model,capability}){
 const r=getOfflineModelReport();
 return (r?.groups?.[capability]||[]).find(x=>x.enabled&&id(x.provider,x.envName,x.model,x.capability)===id(provider,envName,model,capability))?.reliability||0;
}
export function formatOfflineModelReliability(limit=10){
 const r=getOfflineModelReport();if(!r)return 'Исторический отчёт ещё не сформирован.';
 const labels={text:'Текст',vision:'Анализ изображений',image:'Генерация изображений','audio-transcription':'Распознавание речи'};
 const lines=['📊 Офлайн-рейтинг моделей · без новых запросов','Исторических аудитов: '+r.scannedAudits];
 for(const [cap,name] of Object.entries(labels)){
  const all=r.groups[cap]||[],good=all.filter(x=>x.enabled);
  lines.push('',name+': оставлено '+good.length+', исключено '+(all.length-good.length));
  for(const [i,x] of good.slice(0,limit).entries())
   lines.push((i+1)+'. '+x.model+' ('+x.provider+') — '+x.successes+'/'+x.attempts+' успешных, '+Math.round(x.successRate*100)+'%, рейтинг '+Math.round(x.reliability*100));
 }
 return lines.join('\n');
}
