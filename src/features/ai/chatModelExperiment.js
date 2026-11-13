import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomInt} from 'node:crypto';
import {resolveRuntimeDataDirectory} from '../../infrastructure/database/runtimePaths.js';
export function parseChatModelExperiment(text) {
 const m=String(text||'').trim().match(/^ответы\s+бота?\s+(?:сол|sol)\s+(?:астра|astra)\s+(\d+|выкл)\s*[.!]?$/iu);
 if(!m)return null;
 const frequency=m[1].toLowerCase()==='выкл'?0:Number(m[1]);
 return {frequency,valid:Number.isSafeInteger(frequency)&&frequency>=0&&(m[1].toLowerCase()==='выкл'||frequency>0)};
}
export function chatExperimentKey(context) {
 return (String(context.platform||'vk').toLowerCase()==='telegram'?'telegram':'vk')+'_'+String(context.peerId).replace(/[^0-9-]/g,'');
}
export function createChatModelExperiment({directory=join(resolveRuntimeDataDirectory(),'chat-model-experiment'),random=randomInt}={}) {
 const queues=new Map();
 async function serial(key,task){const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(task);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
 async function read(key){try{return JSON.parse(await readFile(join(directory,key+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {frequency:0,count:0};throw e;}}
 async function save(key,value){await mkdir(directory,{recursive:true});const path=join(directory,key+'.json');await writeFile(path+'.tmp',JSON.stringify(value));await rename(path+'.tmp',path);}
 return {
  async configure(context,frequency){if(!Number.isSafeInteger(frequency)||frequency<0)throw Error('Invalid reply frequency');const key=chatExperimentKey(context);return serial(key,async()=>{const s={frequency,count:0,updatedAt:Date.now()};await save(key,s);return s;});},
  async run(context,task) {
   const key=chatExperimentKey(context);
   return serial(key,async()=>{
    const state=await read(key);let committed=false;
    const selected=state.frequency>0&&(state.count+1)%state.frequency===0;
    const plan=selected?{model:random(2)?'gpt-6-astra':'gpt-6.1-sol',reasoningEffort:random(2)?'high':'medium'}:null;
    const startedAt=Date.now();
    return task(plan,async(result={})=>{
     if(committed||!state.frequency)return;committed=true;
     state.count++;await save(key,state);
     await appendFile(join(directory,'outcomes.jsonl'),JSON.stringify({at:new Date().toISOString(),chat:key,sequence:state.count,frequency:state.frequency,selected:Boolean(plan),requestedModel:plan?.model||null,reasoningEffort:plan?.reasoningEffort||null,elapsedMs:Date.now()-startedAt,incomingId:context.conversationMessageId||context.id||null,...result})+'\n');
    });
   });
  },
  inspect:context=>read(chatExperimentKey(context)),
 };
}
export const chatModelExperiment=createChatModelExperiment();
