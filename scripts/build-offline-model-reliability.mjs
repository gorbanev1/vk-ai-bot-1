import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {buildOfflineModelReport} from '../src/features/ai/offlineModelReliability.js';
const dirs='AI_FULL_AUDIT_RESULTS',reports=[];
for(const item of fs.readdirSync(dirs,{withFileTypes:true})){
 const file=dirs+'/'+item.name+'/report.json';
 if(item.isDirectory()&&fs.existsSync(file)){
  const report=JSON.parse(fs.readFileSync(file,'utf8'));
  if(Array.isArray(report.textResults)||Array.isArray(report.imageResults))reports.push(report);
 }
}
const db=new DatabaseSync('data/bot.sqlite',{readOnly:true});
const discovery=db.prepare('SELECT provider,env_name,model,qualification_status,qualification_json,qualified_at FROM ai_model_discovery').all();
const voices=db.prepare("SELECT model,status,transcript,updated_at FROM voice_transcripts WHERE model<>'' AND status='ok' AND length(trim(transcript))>=2").all();
const lua=db.prepare("SELECT details_json FROM maintenance_state WHERE task_key='gpt-6-luna-health-v1'").get();
const samples=lua?JSON.parse(lua.details_json||'{}').samples||[]:[];
db.close();
const report=buildOfflineModelReport(reports,discovery,voices,samples);
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/model-reliability-offline.json',JSON.stringify(report,null,2));
console.log('OFFLINE_REPORT',JSON.stringify({audits:reports.length,transcripts:voices.length,totals:report.totals}));
for(const cap of ['text','image','vision','audio-transcription'])console.log('TOP_'+cap,report.groups[cap].filter(x=>x.enabled).slice(0,7).map(x=>({model:x.model,provider:x.provider,env:x.envName,successful:x.successes,attempts:x.attempts,rank:x.reliability})));
