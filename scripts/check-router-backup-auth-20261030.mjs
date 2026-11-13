import 'dotenv/config';
import {collectRuntimeModelCredentials} from '../src/features/ai/modelProviderFailover.js';
const creds=collectRuntimeModelCredentials(process.env).filter(c=>c.provider==='compat');
if(creds.length<2)throw Error('Expected two compatible API keys');
const baseUrls=[...new Set(creds.map(c=>c.baseUrl))];
if(baseUrls.length!==1)throw Error('Compatible keys differ in endpoint');
const results=[];
for(const c of creds){
 try{
  const response=await fetch(c.baseUrl+'/models',{
   method:'GET',
   headers:{Authorization:'Bearer '+c.secret,Accept:'application/json'},
   signal:AbortSignal.timeout(16000),
  });
  // Do not display provider responses or secret-bearing headers.
  results.push({name:c.name,status:response.status,authenticated:response.ok});
  await response.body?.cancel();
 }catch(error){results.push({name:c.name,status:null,authenticated:false,errorCategory:error?.name==='TimeoutError'?'timeout':'network'});}
}
console.log(JSON.stringify({sameEndpoint:baseUrls.length===1,endpointHost:new URL(baseUrls[0]).hostname,
 count:creds.length,results},null,2));
if(results.some(r=>!r.authenticated))process.exitCode=2;
