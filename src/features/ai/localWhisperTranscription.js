import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const WORKER=fileURLToPath(new URL('./localWhisperTranscription.py',import.meta.url));
const MAX_AUDIO=24*1024*1024;
export function transcribeWithLocalWhisper({buffer,timeoutMs=90000,signal}={}){
 if(!Buffer.isBuffer(buffer)||buffer.length<32||buffer.length>MAX_AUDIO)
  return Promise.reject(new Error('Invalid input audio bytes for local speech recognition'));
 return new Promise((resolve,reject)=>{
  const executable=process.env.GIGORAVE_LOCAL_STT_PYTHON||'python';
  const proc=spawn(executable,['-u',WORKER],{windowsHide:true,stdio:['pipe','pipe','pipe'],
   env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1'}});
  let stdout='',stderr='',settled=false;
  const finish=(err,result)=>{
   if(settled)return;settled=true;
   clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);
   if(err)reject(err);else resolve(result);
  };
  const onAbort=()=>{proc.kill();finish(new Error('Local speech recognition aborted'))};
  const timer=setTimeout(()=>{proc.kill();finish(new Error('Local speech recognition timeout'))},Math.min(120000,Math.max(5000,timeoutMs)));
  timer.unref?.();
  signal?.addEventListener?.('abort',onAbort,{once:true});
  if(signal?.aborted){onAbort();return}
  proc.stdout.on('data',buf=>{
   stdout+=buf.toString('utf8');
   if(stdout.length>128000){proc.kill();finish(new Error('Local speech output too large'))}
  });
  proc.stderr.on('data',buf=>{stderr=(stderr+buf.toString('utf8')).slice(-1500)});
  proc.on('error',err=>finish(new Error('Local speech worker unavailable: '+String(err?.message||err).slice(0,180))));
  proc.stdin.on('error',()=>{});
  proc.on('close',code=>{
   let data;try{data=JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)||'{}')}catch{}
   if(code!==0||data?.ok!==true||!/[\p{L}\p{N}]/u.test(String(data?.text||''))){
    finish(new Error('Local Whisper failed: '+String(data?.error||stderr||('exit '+code)).slice(0,250)));return;
   }
   finish(null,{text:String(data.text).trim(),provider:'local-whisper',model:String(data.model||'faster-whisper-small'),
    transport:'local-whisper-cpu',durationMs:Number(data.seconds||0)*1000,usage:null});
  });
  proc.stdin.end(buffer);
 });
}
