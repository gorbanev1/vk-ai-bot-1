import {parentPort,workerData} from 'node:worker_threads';
import {createPatrolReadOnlyTools} from './vkPatrolAdaptiveModules.js';
try{const tools=createPatrolReadOnlyTools({databasePath:workerData.databasePath});parentPort.postMessage({ok:true,result:tools.searchMessages(workerData.args)});}
catch(error){parentPort.postMessage({ok:false,error:String(error?.message||error)});}
