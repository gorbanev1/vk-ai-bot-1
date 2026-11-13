import {parseRecurringChatWriteCommand} from '../routing/recurringChatWrite.js';

// The model chooses this typed tool, but only the user's ORIGINAL message
// determines the action, text and interval. No free-form side effects.
export function runPatrolRecurringTool({originalQuestion='',candidates=[],scope,service,ownerAuthorized=false}={}){
 if(!ownerAuthorized)return {ok:false,error:'Recurring chat write is available only to the bot owner'};
 if(!service||!scope)throw Error('Recurring tool is not initialized');
 const original=[originalQuestion,...(Array.isArray(candidates)?candidates.slice(0,10):[])]
  .filter(x=>typeof x==='string');
 const command=original.map(parseRecurringChatWriteCommand).find(Boolean);
 if(!command)return {ok:false,error:'No explicit recurring-chat command in the original human message'};
 const view=x=>({id:Number(x.id),message:String(x.message_text||'').slice(0,220),
  intervalMs:Number(x.interval_ms),nextAt:Number(x.next_at),active:Boolean(x.active)});
 try{
  if(command.action==='invalid')return {ok:false,error:'Invalid recurring command',reason:command.reason,
   acceptedIntervalMs:{min:1000,max:7*86400000}};
  if(command.action==='help')return {ok:true,status:'help',help:'Specify a message and an interval from one second to seven days.'};
  if(command.action==='list')return {ok:true,status:'listed',jobs:service.list(scope).map(view)};
  if(command.action==='create'){
   const created=service.create(scope,command);
   if(created?.error)return {ok:false,error:'Schedule creation rejected: '+String(created.error)};
   const matching=service.list(scope).find(x=>x.id===created.item.id&&
    x.interval_ms===command.intervalMs&&x.message_text===command.message&&Number(x.active)===1);
   return {ok:Boolean(matching),status:matching?'created':'not-verified',
    created:Boolean(created.created),existing:Boolean(created.existing),
    index:created.index,verified:Boolean(matching),job:view(created.item)};
  }
  if(command.action==='cancel-one'){
   const removed=service.cancelOne(scope,command.index);
   return {ok:true,status:removed?'cancelled':'not-found',removed:removed?view(removed):null,
    remaining:service.list(scope).length};
  }
  if(command.action==='cancel-all'){
   const count=service.cancelAll(scope);
   return {ok:true,status:'cancelled',count,remaining:service.list(scope).length};
  }
  return {ok:false,error:'Unsupported recurring action'};
 }catch(error){
  return {ok:false,error:String(error?.message||error).slice(0,420)};
 }
}
