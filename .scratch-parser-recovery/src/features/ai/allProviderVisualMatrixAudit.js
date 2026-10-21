import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectConfiguredAiCredentials, runConfiguredAiKeyAudit } from './providerKeyAudit.js';
import { NVIDIA_VISUAL_AUDIT_CATALOG } from './nvidiaVisualAudit.js';
import { generateNvidiaVisualImage, getNvidiaVisualConfig } from './nvidiaVisualGeneration.js';

const DEFAULT_PROMPT = 'A cinematic cyberpunk night in Voronezh, neon reflections on wet asphalt, dramatic architecture, highly detailed, no text';
const DEFAULT_TIMEOUT_MS = 360000;
const clean = (v) => String(v ?? '').trim();
const safe = (v) => clean(v).replace(/[^a-z0-9._-]+/giu, '_').slice(0, 140) || 'item';

const boundedInt = (value, fallback, max=32) => {
  const parsed=Number.parseInt(String(value ?? ''),10);
  return Number.isFinite(parsed) && parsed>0 ? Math.min(max,parsed) : fallback;
};

async function runConcurrentByKey(items, worker, {globalLimit=1,perKeyLimit=1,keyFn=(item)=>String(item?.key??'')}={}) {
  const results=new Array(items.length), pending=items.map((_,i)=>i), activeByKey=new Map();
  let active=0,completed=0;
  return await new Promise((resolveRun,rejectRun)=>{
    let failed=false;
    const schedule=()=>{
      if(failed)return;
      if(completed>=items.length){resolveRun(results);return;}
      while(active<globalLimit&&pending.length){
        let pos=-1;
        for(let i=0;i<pending.length;i++){
          const idx=pending[i], key=keyFn(items[idx],idx);
          if((activeByKey.get(key)||0)<perKeyLimit){pos=i;break;}
        }
        if(pos<0)break;
        const idx=pending.splice(pos,1)[0], item=items[idx], key=keyFn(item,idx);
        active+=1;activeByKey.set(key,(activeByKey.get(key)||0)+1);
        Promise.resolve().then(()=>worker(item,idx)).then((result)=>{results[idx]=result;}).catch((error)=>{failed=true;rejectRun(error);}).finally(()=>{
          active-=1;activeByKey.set(key,Math.max(0,(activeByKey.get(key)||1)-1));completed+=1;schedule();
        });
      }
    };
    if(!items.length)resolveRun([]);else schedule();
  });
}

function parseImagePayload(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  const b64 = item?.b64_json || item?.base64 || payload?.image || payload?.base64;
  if (b64) return { buffer: Buffer.from(String(b64).replace(/^data:image\/[^;]+;base64,/u, ''), 'base64'), mimeType: 'image/png' };
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const part = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  if (part) return { buffer: Buffer.from(part.inlineData?.data || part.inline_data?.data, 'base64'), mimeType: part.inlineData?.mimeType || part.inline_data?.mime_type || 'image/png' };
  return null;
}

async function fetchBinaryOrJson(url, options, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    const ct = clean(res.headers.get('content-type')).toLowerCase();
    if (res.ok && ct.startsWith('image/')) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { ok: true, status: res.status, elapsedMs: Date.now()-startedAt, image: { buffer, mimeType: ct.split(';')[0] }, payload: null, error: '' };
    }
    const raw = await res.text(); let payload = null; try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0,3000) }; }
    let image = res.ok ? parseImagePayload(payload) : null;
    if (res.ok && !image) {
      const remoteUrl = clean(payload?.data?.[0]?.url || payload?.url);
      if (remoteUrl) {
        try {
          const imageRes = await fetchImpl(remoteUrl, { signal: AbortSignal.timeout(timeoutMs) });
          if (imageRes.ok) {
            const imageCt = clean(imageRes.headers.get('content-type')).toLowerCase();
            const buffer = Buffer.from(await imageRes.arrayBuffer());
            if (buffer.length) image = { buffer, mimeType: imageCt.startsWith('image/') ? imageCt.split(';')[0] : 'image/png' };
          }
        } catch { /* keep provider response as a failed image probe */ }
      }
    }
    return { ok: Boolean(res.ok && image), status: res.status, elapsedMs: Date.now()-startedAt, image, payload, error: res.ok && !image ? 'response contained no downloadable image' : clean(payload?.error?.message || payload?.message || payload?.detail || payload?.raw).slice(0,1000) };
  } catch (e) { return { ok:false,status:0,elapsedMs:Date.now()-startedAt,image:null,payload:null,error:clean(e?.message||e).slice(0,1000) }; }
}

async function discoverHfTextToImageModels(secret, fetchImpl = globalThis.fetch) {
  const url = 'https://huggingface.co/api/models?pipeline_tag=text-to-image&inference=warm&limit=200&sort=trendingScore&direction=-1';
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((m) => clean(m?.id || m?.modelId)).filter(Boolean);
  } catch { return []; }
}

export async function probeProviderVisualModel({ credential, model, prompt, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (credential.provider === 'nvidia') {
    try {
      const cfg = { ...getNvidiaVisualConfig(process.env), apiKey: credential.secret };
      const generated = await generateNvidiaVisualImage(cfg, prompt, { model });
      return { ok:true,status:generated.status||200,elapsedMs:generated.elapsedMs||0,image:{buffer:generated.buffer,mimeType:generated.mimeType},error:'' };
    } catch (e) { return { ok:false,status:Number(e?.status||0),elapsedMs:0,image:null,error:clean(e?.message||e).slice(0,1000) }; }
  }
  if (credential.provider === 'openai' || credential.provider === 'openai-compatible') {
    return fetchBinaryOrJson(`${credential.baseUrl.replace(/\/$/u,'')}/images/generations`, { method:'POST', headers:{Authorization:`Bearer ${credential.secret}`,'Content-Type':'application/json'}, body:JSON.stringify({model,prompt,size:'1024x1024',n:1}) }, timeoutMs, fetchImpl);
  }
  if (credential.provider === 'xai') {
    return fetchBinaryOrJson(`${credential.baseUrl.replace(/\/$/u,'')}/images/generations`, { method:'POST', headers:{Authorization:`Bearer ${credential.secret}`,'Content-Type':'application/json'}, body:JSON.stringify({model,prompt,n:1}) }, timeoutMs, fetchImpl);
  }
  if (credential.provider === 'gemini') {
    return fetchBinaryOrJson(`${credential.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credential.secret)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['IMAGE']}}) }, timeoutMs, fetchImpl);
  }
  if (credential.provider === 'huggingface') {
    return fetchBinaryOrJson(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, { method:'POST', headers:{Authorization:`Bearer ${credential.secret}`,'Content-Type':'application/json','Accept':'image/png'}, body:JSON.stringify({inputs:prompt,parameters:{width:1024,height:1024,seed:1}}) }, timeoutMs, fetchImpl);
  }
  return { ok:false,status:0,elapsedMs:0,image:null,error:'provider has no supported image-generation adapter' };
}

function imageModelsFromAudit(result) {
  if (result.provider === 'nvidia') return NVIDIA_VISUAL_AUDIT_CATALOG.filter((m)=>m.generation).map((m)=>m.id);
  return (result.models || []).filter((m)=>Array.isArray(m.capabilities) && (m.capabilities.includes('image') || m.capabilities.includes('generation'))).map((m)=>m.id);
}

export async function runAllProviderVisualMatrixAudit({
  env=process.env,
  prompt=DEFAULT_PROMPT,
  directory=process.cwd(),
  onProgress=null,
  retainBuffers=true,
  keyAudit=null,
  credentials=null,
  concurrency=null,
  perKeyConcurrency=null,
  fetchImpl=globalThis.fetch,
}={}) {
  const requestedPrompt=clean(prompt)||DEFAULT_PROMPT;
  const resolvedKeyAudit=keyAudit || await runConfiguredAiKeyAudit({env,concurrency:boundedInt(env.AI_AUDIT_KEY_CONCURRENCY,8,32)});
  const resolvedCredentials=credentials || collectConfiguredAiCredentials(env);
  const byName=new Map(resolvedCredentials.map((c)=>[`${c.provider}:${c.name}`,c]));
  const working=resolvedKeyAudit.results.filter((r)=>r.ok);
  const stamp=new Date().toISOString().replace(/[:.]/gu,'-');
  const outDir=resolve(directory,'GRAPHICS_MATRIX_RESULTS',stamp);
  await mkdir(outDir,{recursive:true});
  const jsonlPath=resolve(outDir,'results.jsonl');
  const summaryPath=resolve(outDir,'summary.txt');
  const promptPath=resolve(outDir,'prompt.txt');
  const deliveryPath=resolve(outDir,'delivery.jsonl');
  await writeFile(promptPath,requestedPrompt+'\n','utf8');
  await writeFile(jsonlPath,'','utf8');
  await writeFile(deliveryPath,'','utf8');

  const plan=[];
  const hfDiscoveries=await Promise.all(working.map(async (r)=>{
    const credential=byName.get(`${r.provider}:${r.envName}`);
    if(!credential)return {r,credential:null,models:[]};
    let models=imageModelsFromAudit(r);
    if(r.provider==='huggingface')models=await discoverHfTextToImageModels(credential.secret, fetchImpl);
    return {r,credential,models:[...new Set(models)].filter(Boolean)};
  }));
  for(const item of hfDiscoveries){
    if(!item.credential)continue;
    for(const model of item.models)plan.push({credential:item.credential,model});
  }

  const globalLimit=boundedInt(concurrency ?? env.AI_AUDIT_IMAGE_CONCURRENCY,4,12);
  const keyLimit=boundedInt(perKeyConcurrency ?? env.AI_AUDIT_PER_KEY_IMAGE_CONCURRENCY,1,3);
  let jsonlChain=Promise.resolve(), deliveryChain=Promise.resolve(), completed=0;
  const appendJsonl=(path,line)=>{
    if(path===jsonlPath){jsonlChain=jsonlChain.then(()=>appendFile(path,line,'utf8'));return jsonlChain;}
    deliveryChain=deliveryChain.then(()=>appendFile(path,line,'utf8'));return deliveryChain;
  };

  const results=await runConcurrentByKey(plan,async ({credential,model},i)=>{
    await onProgress?.({stage:'start',index:i+1,total:plan.length,completed,activeLimit:globalLimit,perKeyLimit:keyLimit,provider:credential.provider,envName:credential.name,masked:credential.masked,model});
    const raw=await probeProviderVisualModel({credential,model,prompt:requestedPrompt,fetchImpl});
    let imagePath='';
    if(raw.ok&&raw.image?.buffer?.length){
      const ext=/jpeg|jpg/u.test(raw.image.mimeType)?'jpg':/webp/u.test(raw.image.mimeType)?'webp':'png';
      imagePath=resolve(outDir,`${String(i+1).padStart(4,'0')}__${safe(credential.provider)}__${safe(credential.name)}__${safe(model)}.${ext}`);
      await writeFile(imagePath,raw.image.buffer);
    }
    const result={index:i+1,total:plan.length,provider:credential.provider,envName:credential.name,masked:credential.masked,model,ok:raw.ok,status:raw.status||0,elapsedMs:raw.elapsedMs||0,error:raw.error||'',imagePath,imageBytes:raw.image?.buffer?.length||0,mimeType:raw.image?.mimeType||''};
    await appendJsonl(jsonlPath,JSON.stringify(result)+'\n');
    let delivery={deliveryOk:null,deliveryError:''};
    try{
      const returned=await onProgress?.({stage:'complete',...result,completed:completed+1,activeLimit:globalLimit,perKeyLimit:keyLimit,buffer:raw.image?.buffer||null});
      if(returned&&typeof returned==='object')delivery={deliveryOk:returned.deliveryOk===undefined?null:Boolean(returned.deliveryOk),deliveryError:clean(returned.deliveryError).slice(0,1000)};
    }catch(e){delivery={deliveryOk:false,deliveryError:clean(e?.message||e).slice(0,1000)};}
    completed+=1;
    const storedResult={...result,...delivery,buffer:retainBuffers?(raw.image?.buffer||null):null};
    await appendJsonl(deliveryPath,JSON.stringify({index:result.index,total:result.total,provider:result.provider,envName:result.envName,masked:result.masked,model:result.model,imagePath:result.imagePath,generatedOk:result.ok,...delivery})+'\n');
    return storedResult;
  },{globalLimit,perKeyLimit:keyLimit,keyFn:({credential})=>`${credential.provider}:${credential.name}`});
  await jsonlChain; await deliveryChain;

  const lines=['ALL PROVIDER GRAPHICS MATRIX',`checked_at=${new Date().toISOString()}`,`prompt=${requestedPrompt}`,`working_keys=${working.length}`,`attempts=${plan.length}`,`concurrency=${globalLimit}`,`per_key_concurrency=${keyLimit}`,`success=${results.filter(r=>r.ok).length}`,`failed=${results.filter(r=>!r.ok).length}`,`delivery_failed=${results.filter(r=>r.deliveryOk===false).length}`,'',...results.map(r=>`${r.index}/${r.total} ${r.ok?'OK':'FAIL'} ${r.provider} ${r.envName} ${r.masked} model=${r.model} status=${r.status} elapsedMs=${r.elapsedMs}${r.imagePath?` file=${r.imagePath}`:''}${r.deliveryOk===false?` delivery=FAIL:${r.deliveryError}`:r.deliveryOk===true?' delivery=OK':''}${r.error?` error=${r.error}`:''}`)];
  await writeFile(summaryPath,lines.join('\n')+'\n','utf8');
  return {prompt:requestedPrompt,outDir,jsonlPath,deliveryPath,summaryPath,keyAudit:resolvedKeyAudit,attempts:plan.length,results,concurrency:globalLimit,perKeyConcurrency:keyLimit};
}

