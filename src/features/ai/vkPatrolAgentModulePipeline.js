import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {resolveRuntimeDataDirectory} from '../../infrastructure/database/runtimePaths.js';

export const PATROL_CODE_WORKER_SEQUENCE=Object.freeze([
 Object.freeze({model:'gpt-6.1-sol',mode:'pro2',reasoningEffort:'medium'}),
 Object.freeze({model:'gpt-6.1-sol',mode:'pro2',reasoningEffort:'high'}),
 Object.freeze({model:'gpt-6-astra',mode:'astra',reasoningEffort:'medium'}),
 Object.freeze({model:'gpt-6-astra',mode:'astra',reasoningEffort:'high'}),
]);
const digest=value=>createHash('sha256').update(String(value??'')).digest('hex');
const safe=value=>String(value??'').trim().slice(0,600);
const validName=value=>/^[a-z][a-z0-9_-]{0,63}$/iu.test(String(value||''));
const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);

// Registry records describe only code which passed the isolated runner;
// source stays in the existing QuickJS sandbox directory.
export function createPatrolModuleRegistry({
 filename=join(resolveRuntimeDataDirectory(),'vk-patrol-adaptive','verified-module-registry.json'),
}={}){
 const load=()=>{
  if(!existsSync(filename))return {version:1,entries:[]};
  const value=JSON.parse(readFileSync(filename,'utf8'));
  if(value?.version!==1||!Array.isArray(value?.entries))
   throw Error('Verified module registry needs manual repair');
  return value;
 };
 const list=()=>load().entries.map(x=>({...x}));
 const taskKey=(task,request)=>digest(String(request||'').trim().toLocaleLowerCase('ru-RU')+'|'+
  String(task||'').trim().toLocaleLowerCase('ru-RU'));
 const find=(task,request,available)=>{
  const key=taskKey(task,request);
  const names=new Set((available||[]).map(x=>x.name));
  return list().find(x=>x.taskHash===key&&names.has(x.name)&&x.status==='sandbox-executed')||null;
 };
 const register=({name,request,task,model,reasoningEffort,source,input,result})=>{
  if(!validName(name))throw Error('Invalid verified module registry name');
  const record={
   name,status:'sandbox-executed',taskHash:taskKey(task,request),
   purpose:safe(task),originalGoal:safe(request),model:String(model||''),
   reasoningEffort:String(reasoningEffort||''),sourceSha256:digest(source),
   exampleInputKeys:Object.keys(isObject(input)?input:{}).slice(0,25),
   resultPreview:JSON.stringify(result??null).slice(0,800),
   verifiedAt:new Date().toISOString(),
  };
  const db=load();
  db.entries=db.entries.filter(x=>x.name!==name);
  db.entries.push(record);
  mkdirSync(dirname(filename),{recursive:true});
  const tmp=filename+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify(db,null,2)+'\n','utf8');
  renameSync(tmp,filename);
  return {...record};
 };
 return Object.freeze({list,find,register,filename});
}

export function parsePatrolCoderSource(response){
 const text=typeof response==='string'?response:
  (typeof response?.text==='string'?response.text:String(response??''));
 let source='';
 const trimmed=text.trim();
 if(trimmed.startsWith('{')){
  try{
   const parsed=JSON.parse(trimmed);
   if(typeof parsed?.source==='string')source=parsed.source;
   else if(typeof parsed?.code==='string')source=parsed.code;
  }catch{}
 }
 if(!source){
  const fenced=trimmed.match(/\x60\x60\x60(?:js|javascript|mjs)?\s*\r?\n([\s\S]*?)\r?\n\x60\x60\x60/iu);
  source=fenced?.[1]||trimmed;
 }
 source=source.trim();
 if(!/^export\s+(?:(?:async\s+)?function\s+run\b|default\s+(?:async\s+)?(?:function|\())/u.test(source))
  throw Error('Coder must output an ESM export async function run(api) or default function');
 if(Buffer.byteLength(source,'utf8')>64000)throw Error('Coder output too large');
 return source;
}

function pickVersionedModuleName(proposed,existing){
 const base=String(proposed||'').trim().replace(/\.mjs$/iu,'');
 if(!validName(base))throw Error('Module name must be 1..64 ASCII letters/digits/_/-');
 const used=new Set((existing||[]).map(x=>x.name));
 if(!used.has(base))return base;
 for(let v=2;v<=999;v++){
  const suffix='_v'+v,name=base.slice(0,64-suffix.length)+suffix;
  if(!used.has(name))return name;
 }
 throw Error('Too many existing module versions');
}
const goodOutput=value=>value!==null&&value!==undefined&&
 !(isObject(value)&&(value.ok===false||value.success===false||typeof value.error==='string'));

export async function buildPatrolModuleViaWorkers({
 name,task,request,context='',input={},observations=[],
 registry,listModules,writeModule,runModule,callCoder,canCallModel=()=>true,
 evaluateCandidate=null,trace=()=>{},stopAfter=PATROL_CODE_WORKER_SEQUENCE.length,
}={}){
 if(typeof callCoder!=='function'||typeof listModules!=='function'||
    typeof writeModule!=='function'||typeof runModule!=='function'||
    !registry||typeof registry.register!=='function')
  throw Error('Isolated module coder pipeline is not configured');
 const original=String(request||'').trim();
 const goal=String(task||'').trim();
 if(!original||!goal||goal.length>3000)return {status:'rejected',error:'Missing bounded user goal'};
 if(!isObject(input))return {status:'rejected',error:'Module input must be an object'};
 const available=listModules();
 const reused=registry.find(goal,original,available);
 if(reused){
  try{
   const result=await runModule(reused.name,input);
   if(goodOutput(result)){
    trace({stage:'existing',status:'sandbox-executed',name:reused.name,model:reused.model});
    return {status:'sandbox-executed',reused:true,name:reused.name,model:reused.model,
     output:result,requiresLunaEvaluation:true};
   }
  }catch(error){trace({stage:'existing',status:'failed',error:String(error?.message||error).slice(0,250)})}
 }
 const moduleName=pickVersionedModuleName(name,available);
 const errors=[];
 let previousSource='';
 for(let attempt=0;attempt<Math.min(stopAfter,PATROL_CODE_WORKER_SEQUENCE.length);attempt++){
  const worker=PATROL_CODE_WORKER_SEQUENCE[attempt];
  if(!canCallModel()){
   trace({stage:attempt+1,status:'token-budget-exhausted',name:moduleName});
   return {status:'token-budget-exhausted',name:moduleName,attempts:errors,
    requiresLunaEvaluation:false};
  }
  let source='';
  try{
   trace({stage:attempt+1,status:'coder-started',name:moduleName,
    model:worker.model,reasoningEffort:worker.reasoningEffort});
   const response=await callCoder(worker,{
    name:moduleName,task:goal,request:original,
    context:String(context||'').slice(0,14000),
    input,observations:Array.isArray(observations)?observations.slice(-7):[],
    previousSource:previousSource.slice(0,24000),
    previousErrors:errors.slice(-3),
    existingModules:registry.list().slice(-40).map(x=>({
     name:x.name,purpose:x.purpose,exampleInputKeys:x.exampleInputKeys,
    })),
   });
   source=parsePatrolCoderSource(response);
   previousSource=source;
   writeModule({name:moduleName,source});
   const output=await runModule(moduleName,input);
   if(!goodOutput(output))throw Error('Sandbox output is empty or declares an error: '+
    JSON.stringify(output).slice(0,1000));
   let lunaVerdict=null;
   if(typeof evaluateCandidate==='function'){
    if(!canCallModel())throw Error('Token budget prevents Luna semantic evaluation');
    lunaVerdict=await evaluateCandidate({
     request:original,task:goal,name:moduleName,
     source,input,output,worker,stage:attempt+1,
     observations:Array.isArray(observations)?observations.slice(-7):[],
    });
    if(!isObject(lunaVerdict)||
       !['satisfied','partial','failed'].includes(lunaVerdict.verdict)||
       !String(lunaVerdict.reason||'').trim())
      throw Error('Luna did not return a valid semantic evaluation');
    trace({stage:attempt+1,status:'luna-semantic-evaluation',
     verdict:lunaVerdict.verdict,
     reason:String(lunaVerdict.reason).slice(0,450)});
    if(lunaVerdict.verdict!=='satisfied')
     throw Error('Luna evaluated the sandbox result as '+lunaVerdict.verdict+': '+
      String(lunaVerdict.reason).slice(0,550));
   }
   const registration=registry.register({
    name:moduleName,request:original,task:goal,
    model:worker.model,reasoningEffort:worker.reasoningEffort,
    source,input,result:output,
   });
   trace({stage:attempt+1,status:'sandbox-executed',name:moduleName,
    model:worker.model,sourceSha256:registration.sourceSha256,
    outputPreview:JSON.stringify(output).slice(0,350)});
   return {status:'sandbox-executed',name:moduleName,
    model:worker.model,reasoningEffort:worker.reasoningEffort,
    version:registration.sourceSha256.slice(0,12),reused:false,
    output,lunaVerdict,requiresLunaEvaluation:true,attempts:attempt+1};
  }catch(error){
   const record={stage:attempt+1,model:worker.model,
    reasoningEffort:worker.reasoningEffort,
    error:String(error?.message||error).slice(0,900)};
   errors.push(record);
   trace({...record,status:'coder-or-sandbox-failed',name:moduleName});
  }
 }
 return {status:'all-code-workers-failed',name:moduleName,
  attempts:errors,requiresLunaEvaluation:false};
}
