import {PATROL_ALLOWED_ACTIONS} from './vkPatrolCapabilityPolicy.js';
const validActions=new Set(PATROL_ALLOWED_ACTIONS);
const sourceTools=[
 ['resume_task','read',{taskId:'previous task ID'},'Resume this user’s earlier task before executing other tools.'],
 ['task_history','read',{turnId:'optional turn ID',offset:'integer',limit:'1..30'},'Read prior requests, outputs, evidence and image versions in the selected task.'],
 ['discover_capabilities','read',{},'Return available tools and native-command metadata.'],
 ['recent_photos','read',{},'Read recent photo references and CMIDs.'],
 ['people','read',{},'Read confirmed personal photo profiles.'],
 ['history','read',{},'Read recent chat messages.'],
 ['search_history','read',{terms:'array<string>',limit:'1..100',offset:'integer',senderId:'optional integer',afterDate:'UNIX seconds',beforeDate:'UNIX seconds',match:'any|all'},'Search archived chat messages.'],
 ['db_catalog','read',{},'List approved read-only tables and fields.'],
 ['db_query','read',{table:'string',fields:'array<string>',filters:'array<{column,op,value}>',limit:'1..100',offset:'integer'},'Typed read-only database query. No raw SQL.'],
 ['message_context','read',{cmid:'positive integer',radius:'1..40'},'Retrieve actual archived message and its neighbors.'],
 ['search_photos','read',{senderId:'optional integer',term:'optional string',limit:'1..60',includeContext:'boolean'},'Find real VK photos and their source messages.'],
 ['inspect_image','vision',{cmid:'positive integer',photoIndex:'0..6'},'Inspect real image pixels with Luna Vision.'],
 ['recurring_chat','schedule',{},'Create/list/cancel an existing recurring chat message job, from 1 second to 7 days. Runtime reparses ORIGINAL user request, never an invented command.'],
 ['native_capability','native',{capabilityId:'registered ID',confidence:'0..1',args:'object'},'Validated existing native command.'],
 ['normal_route','native',{},'Delegate explicitly recognized native command.'],
 ['list_modules','read',{},'List existing sandbox modules.'],
 ['run_module','sandbox',{name:'module name',input:'object'},'Execute isolated QuickJS module.'],
 ['write_module','sandbox',{name:'module name',source:'JavaScript source'},'Legacy direct source submission only, still inside existing isolated QuickJS sandbox.'],
 ['build_module','orchestrated-sandbox',{name:'1..64 ASCII module name',task:'bounded implementable goal',input:'object'},'LAST RESORT. Luna High chooses task; Sol medium/high then Astra medium/high write code. Host runs actual QuickJS worker, Luna evaluates output. Verified code is registered for future requests.'],
 ['delete_module','sandbox',{name:'module name'},'Only explicit chat manager request to delete managed sandbox module.'],
 ['show_parties','native',{query:'event date range and filters',partyPool:'primary|secondary|qtickets|all'},'Send existing party cards.'],
 ['create_image','image',{query:'image request'},'Run existing image generation.'],
 ['edit_image','image',{query:'image edit request',artifactId:'optional saved task image ID'},'Run existing image editor.'],
 ['create_image_from_photos','image',{query:'image request',photos:'array<{cmid,photoIndex}>'},'Use verified source photos to generate image.'],
 ['pin_photo','native',{},'Save user-confirmed personal photo reference.'],
 ['help','read',{},'Show tool help.'],
 ['answer','final',{answer:'verified Russian-language response',confidence:'0..1'},'Answer with evidence and report missing information.'],
 ['silent','final',{reason:'why no response is needed',confidence:'0..1'},'Finish without sending a message for a redundant reaction or unrelated exchange. Never discard a direct task.'],
 ['clarify','final',{answer:'short clarification question',confidence:'0..1'},'Ask the user to specify the task when confidence is below 0.60 or the instruction is missing.'],
];
export const PATROL_AGENT_TOOL_CONTRACTS=Object.freeze(sourceTools.map(([name,kind,parameters,description])=>
 Object.freeze({name,kind,parameters:Object.freeze(parameters),description})));
export function patrolAgentToolCatalog(nativeCapabilities=[]){
 return {version:1,protocol:'One JSON object per turn with a registered action and flat typed parameters.',
  tools:PATROL_AGENT_TOOL_CONTRACTS,
  nativeCapabilities:Array.isArray(nativeCapabilities)?nativeCapabilities:[]};
}
function firstJsonObject(value){
 const s=String(value||'');
 let start=-1,depth=0,quoted=false,escaped=false;
 for(let i=0;i<s.length;i++){
  const ch=s[i];
  if(start<0){if(ch==='{'){start=i;depth=1}continue}
  if(quoted){
   if(escaped){escaped=false;continue}
   if(ch==='\\'){escaped=true;continue}
   if(ch==='"')quoted=false;
   continue;
  }
  if(ch==='"'){quoted=true;continue}
  if(ch==='{'){depth++;continue}
  if(ch==='}'&&!--depth)return s.slice(start,i+1);
 }
 return '';
}
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const txt=(v,max)=>typeof v==='string'?v.slice(0,max):'';
export function parsePatrolAgentPlan(response){
 const raw=String(response||'');
 if(!raw.trim())return {ok:false,reason:'empty-response'};
 if(raw.length>96000)return {ok:false,reason:'too-long'};
 let plan;
 try{plan=JSON.parse(firstJsonObject(raw))}
 catch{return {ok:false,reason:'invalid-json'}}
 if(!obj(plan))return {ok:false,reason:'not-an-object'};
 const action=txt(plan.action,100).trim();
 if(!validActions.has(action))return {ok:false,reason:'unknown-action',action};
 if(action==='silent'&&(!['social_reaction','unrelated'].includes(plan.intent)||typeof plan.confidence!=='number'||plan.confidence<0.6))return {ok:false,reason:'invalid-silent-decision'};
 if(plan.intent!==undefined&&!['task','visual_question','social_reaction','correction','unrelated'].includes(plan.intent))return {ok:false,reason:'invalid-intent'};
 if(plan.reason!==undefined&&typeof plan.reason!=='string')return {ok:false,reason:'invalid-reason'};
 if(plan.query!==undefined&&typeof plan.query!=='string')return {ok:false,reason:'invalid-query'};
 if(plan.answer!==undefined&&typeof plan.answer!=='string')return {ok:false,reason:'invalid-answer'};
 if(plan.terms!==undefined&&(!Array.isArray(plan.terms)||plan.terms.length>20||
  plan.terms.some(x=>typeof x!=='string'||x.length>140)))return {ok:false,reason:'invalid-terms'};
 if(plan.args!==undefined&&!obj(plan.args))return {ok:false,reason:'invalid-args'};
 if(plan.input!==undefined&&!obj(plan.input))return {ok:false,reason:'invalid-input'};
 if(plan.photos!==undefined&&(!Array.isArray(plan.photos)||plan.photos.length>4))
  return {ok:false,reason:'invalid-photos'};
 if(plan.photoIndex!==undefined&&(!Number.isInteger(plan.photoIndex)||plan.photoIndex<0||plan.photoIndex>6))return {ok:false,reason:'invalid-photo-index'};
 if(plan.includeContext!==undefined&&typeof plan.includeContext!=='boolean')return {ok:false,reason:'invalid-include-context'};
 if(plan.confidence!==undefined&&(typeof plan.confidence!=='number'||!Number.isFinite(plan.confidence)||plan.confidence<0||plan.confidence>1))return {ok:false,reason:'invalid-confidence'};
 if(plan.fields!==undefined&&(!Array.isArray(plan.fields)||plan.fields.length>30||plan.fields.some(x=>typeof x!=='string')))return {ok:false,reason:'invalid-db-fields'};
 if(plan.filters!==undefined&&(!Array.isArray(plan.filters)||plan.filters.length>12||plan.filters.some(x=>!obj(x)||typeof x.column!=='string'||!['eq','ne','lt','lte','gt','gte','contains'].includes(x.op||'eq')||!['string','number'].includes(typeof x.value))))return {ok:false,reason:'invalid-db-filters'};
 if(plan.photos!==undefined&&plan.photos.some(x=>!obj(x)||!Number.isSafeInteger(x.cmid)||x.cmid<1||(x.photoIndex!==undefined&&(!Number.isInteger(x.photoIndex)||x.photoIndex<0||x.photoIndex>6))))return {ok:false,reason:'invalid-photo-reference'};
 for(const field of ['limit','offset','afterDate','beforeDate'])if(plan[field]!==undefined&&(!Number.isSafeInteger(plan[field])||plan[field]<0))return {ok:false,reason:'invalid-'+field};
 if(plan.senderId!==undefined&&!Number.isSafeInteger(plan.senderId))return {ok:false,reason:'invalid-sender-id'};
 if(plan.match!==undefined&&!['any','all'].includes(plan.match))return {ok:false,reason:'invalid-match'};
 if(plan.turnId!==undefined&&typeof plan.turnId!=='string')return {ok:false,reason:'invalid-turn-id'};
 if(action==='resume_task'&&typeof plan.taskId!=='string')return {ok:false,reason:'task-id-required'};
 if(plan.artifactId!==undefined&&typeof plan.artifactId!=='string')return {ok:false,reason:'invalid-artifact-id'};
 if(plan.memory!==undefined&&!obj(plan.memory))return {ok:false,reason:'invalid-memory'};
 if(plan.partyPool!==undefined&&!['primary','secondary','qtickets','all'].includes(plan.partyPool))return {ok:false,reason:'invalid-party-pool'};
 if(['answer','clarify'].includes(action)&&!txt(plan.answer,3500).trim())return {ok:false,reason:'answer-required'};
 if(action==='native_capability'&&!txt(plan.capabilityId,110).trim())
  return {ok:false,reason:'capability-id-required'};
 if(action==='db_query'&&!txt(plan.table,90).trim())return {ok:false,reason:'db-table-required'};
 if(action==='db_query'&&((plan.fields!==undefined&&!Array.isArray(plan.fields))||
    (plan.filters!==undefined&&!Array.isArray(plan.filters))))
  return {ok:false,reason:'invalid-db-parameters'};
 if(['run_module','write_module','delete_module','build_module'].includes(action)&&
  !txt(plan.name||plan.moduleName,120).trim())return {ok:false,reason:'module-name-required'};
 if(action==='build_module'&&!txt(plan.task,3000).trim())return {ok:false,reason:'module-task-required'};
 if(action==='write_module'&&!txt(plan.source||plan.code,64000).trim())
  return {ok:false,reason:'module-source-required'};
 if(['inspect_image','message_context'].includes(action)&&
  !(Number.isSafeInteger(Number(plan.cmid))&&Number(plan.cmid)>0))
  return {ok:false,reason:'cmid-required'};
 return {ok:true,plan:{...plan,action,reason:txt(plan.reason,1000),
  ...(plan.query!==undefined?{query:txt(plan.query,3000)}:{}),
  ...(plan.answer!==undefined?{answer:txt(plan.answer,3500)}:{})}};
}
