const ROUTER_MODEL='gemini-3.8-flash';
const ROUTER_URL='https://router.cheap/v1beta/models/gemini-3.8-flash:generateContent';
const MAX_AUDIO_BYTES=24*1024*1024;

function normalizeMimeType(value){
 const s=String(value||'').split(';')[0].trim().toLowerCase();
 if(s==='audio/mpeg'||s==='audio/mp3')return 'audio/mpeg';
 if(s==='audio/opus'||s==='application/ogg'||s==='audio/oga')return 'audio/ogg';
 if(s==='audio/wav'||s==='audio/x-wav')return 'audio/wav';
 if(s==='audio/mp4'||s==='audio/m4a')return 'audio/mp4';
 return 'audio/ogg';
}

export async function transcribeRouterGeminiAudio({
 buffer,mimeType='audio/ogg',apiKey=process.env.OPENAI_COMPAT_API_KEY,
 timeoutMs=35000,signal,fetchImpl=fetch
}={}){
 if(!Buffer.isBuffer(buffer)||buffer.length<32||buffer.length>MAX_AUDIO_BYTES)
  throw new Error('Invalid audio bytes for router speech transcription');
 if(!String(apiKey||'').trim())throw new Error('First router API key is not configured');
 const controller=new AbortController();
 const abort=()=>controller.abort(signal?.reason||new Error('Audio transcription cancelled'));
 signal?.addEventListener?.('abort',abort,{once:true});
 if(signal?.aborted)abort();
 const timer=setTimeout(()=>controller.abort(new Error('Router audio timeout')),Math.min(90000,Math.max(3000,timeoutMs)));
 timer.unref?.();
 const started=Date.now();
 try{
  const payload={
   contents:[{role:'user',parts:[
    {text:'This Telegram voice message may contain Russian AND English, including English grammar and tense examples. Transcribe each spoken word faithfully in its ORIGINAL spoken language; do not translate English to Russian or Russian to English. Return ONLY the transcript, without analysis, explanations, or invented words. Preserve spoken technical terms when audible.'},
    {inline_data:{mime_type:normalizeMimeType(mimeType),data:buffer.toString('base64')}}
   ]}],
   generationConfig:{temperature:0,maxOutputTokens:2048}
  };
  const response=await fetchImpl(ROUTER_URL,{method:'POST',headers:{
   Authorization:'Bearer '+String(apiKey).trim(),
   'Content-Type':'application/json'
  },body:JSON.stringify(payload),signal:controller.signal});
  let result;
  try{result=await response.json()}catch{throw new Error('Router audio returned invalid JSON')}
  if(!response.ok||result?.error){
   const code=String(result?.error?.code||response.status);
   const msg=String(result?.error?.message||'router model error');
   throw new Error('Router Gemini audio HTTP '+response.status+' ('+code+'): '+msg.slice(0,170));
  }
  const transcript=(Array.isArray(result?.candidates)?result.candidates:[])
   .flatMap(x=>Array.isArray(x?.content?.parts)?x.content.parts:[])
   .map(x=>typeof x?.text==='string'?x.text:'').join(' ').trim();
  if(!/[\p{L}\p{N}]/u.test(transcript))
   throw new Error('Router Gemini audio returned no recognizable transcription');
  const usage=result?.usageMetadata||{};
  return {text:transcript,provider:'OPENAI_COMPAT_API_KEY',model:ROUTER_MODEL,
   transport:'router-gemini-native-audio',durationMs:Date.now()-started,
   usage:{prompt_tokens:Number(usage.promptTokenCount||0),
    completion_tokens:Number(usage.candidatesTokenCount||0),
    total_tokens:Number(usage.totalTokenCount||0)}};
 }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',abort)}
}
