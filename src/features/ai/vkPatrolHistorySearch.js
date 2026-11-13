import {Worker} from 'node:worker_threads';
import {resolveMainDatabasePath} from '../../infrastructure/database/runtimePaths.js';
export function searchPatrolHistory(args,{databasePath=resolveMainDatabasePath()}={}){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./vkPatrolHistoryWorker.mjs',import.meta.url),{workerData:{args,databasePath}});
  let settled=false;
  const done=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
  worker.once('message',r=>done(r.ok?null:Error(r.error),r.result));worker.once('error',done);
  worker.once('exit',code=>{if(!settled)done(Error('History worker exited without result: '+code));});
 });
}
