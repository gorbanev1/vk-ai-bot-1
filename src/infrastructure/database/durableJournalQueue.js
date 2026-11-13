import {appendFile} from 'node:fs/promises';
const tails=new Map();
let pending=0;

/** Ordered async journal: each write is acknowledged before its SQLite insert.
 * Old synchronous APIs are left untouched for replay/backfill compatibility.
 */
export function appendDurableJournalAsync(filePath,entry,{label='MESSAGE'}={}){
 const path=String(filePath);
 const text=JSON.stringify(entry)+'\n';
 const previous=tails.get(path)||Promise.resolve();
 pending++;
 const current=previous.then(()=>appendFile(path,text,'utf8'));
 const safeTail=current.catch(()=>{});
 tails.set(path,safeTail);
 return current.then(()=>true,error=>{
  console.error('['+label+' JOURNAL WRITE ERROR]',String(error?.message||error));
  return false;
 }).finally(()=>{pending--;if(tails.get(path)===safeTail)tails.delete(path);});
}
export async function flushDurableJournalWrites(){
 do {
  await Promise.all([...tails.values()]);
 } while (pending > 0 || tails.size > 0);
}
export function getPendingDurableJournalWrites(){return pending;}
