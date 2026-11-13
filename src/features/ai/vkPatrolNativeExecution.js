// The same native handlers execute the action; this bridge awaits their own
// per-chat queue instead of treating synchronous acceptance as completion.
export async function executePatrolNativeCapability({selected,context,services}) {
 if (!selected?.ok) return {ok:false,status:'rejected',reason:selected?.reason||'invalid-capability'};
 const family=selected.capabilityId.split('.')[0],service=services[family];
 if (!service?.handle || !service?.inspect) return {ok:false,status:'unavailable'};
 let completion;
 try {
  const accepted=service.handle({...context,text:selected.command}, promise=>{completion=promise;});
  if (!accepted) return {ok:false,status:'not-handled',capabilityId:selected.capabilityId};
  if (!completion) return {ok:false,status:'accepted-unverified',retrySafe:false,capabilityId:selected.capabilityId};
  await completion;
  const snapshot=service.inspect(context.platform,context.peerId);
  const enabled=Boolean(snapshot?.subscription?.enabled);
  const expected=selected.expectedResult;
  const verified=expected==='on'?enabled:expected==='off'?!enabled:
   expected==='lesson'?Number(snapshot?.run?.lesson_id)===Number(selected.command.match(/\d+$/u)?.[0]):
   selected.readOnly?true:null;
  return {ok:verified!==false,status:verified===true?'verified':verified===false?'goal-not-reached':'handler-completed',
   capabilityId:selected.capabilityId,verified,retrySafe:false,state:snapshot,
   note:'Handler completion is not completion of the whole user goal. Inspect state; the next lesson may still be running.'};
 } catch(error) {
  return {ok:false,status:'failed',retrySafe:false,capabilityId:selected.capabilityId,
   error:String(error?.message||error).slice(0,500),note:'State may have changed before failure; do not repeat a state-changing action automatically.'};
 }
}
function canonical(value) {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort()
  .filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
 return value;
}
export function patrolToolCallKey(plan) {
 const {reason,confidence,answer,...parameters}=plan;
 return JSON.stringify(canonical(parameters));
}
// Keep complete JSON and make any omitted evidence explicit, never cut a JSON
// document in the middle of a record. Earlier observations remain in the trace.
export function patrolPlannerObservations(notes,maxChars=28000) {
 const out=[];let used=2;
 for (const note of [...notes].reverse()) {
  let row=note,encoded=JSON.stringify(row);
  if (encoded.length>Math.max(1500,maxChars/2)) {
   row={action:note.action,truncated:true,preview:encoded.slice(0,Math.floor(maxChars/3)),
    note:'Result preview only; narrow the query for complete records.'};encoded=JSON.stringify(row);
  }
  if (used+encoded.length+1>maxChars) break;
  out.unshift(row);used+=encoded.length+1;
 }
 return JSON.stringify({omittedObservations:notes.length-out.length,observations:out});
}

export function patrolProgressHint(notes=[]){
 const recent=notes.slice(-3);
 if(recent.length<3||new Set(recent.map(n=>n.action)).size!==1)return '';
 const stalled=recent.every(n=>n.result&&(n.result.error||n.result.ok===false||n.result.status==='already-attempted'||n.result.matches===0));
 return stalled?'Последние три действия не дали результата. Пересмотри подход или используй уже найденные данные; не меняй параметры лишь ради повторения той же попытки. Это подсказка, не ограничение необходимых проверок.':'';
}
