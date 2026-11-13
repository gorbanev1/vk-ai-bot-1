export function classifyParserError(row) {
 const s=typeof row?.error==='string'?row.error:JSON.stringify(row?.error||'');
 if (/\.map is not a function|could not be cloned/i.test(s)) return 'code';
 if (/окно браузера закрыто|stoppedByOwner|cancelled by owner/i.test(s)) return 'interrupted';
 if (row?.stage==='capture'||/BROWSER_IMAGE|download|скач|Poster recognition unavailable|raw-cache|MISSING_USABLE_POSTER/i.test(s)) return 'capture';
 if (/structure-uncertain|validation|missing-venue|evidence-not-verbatim/i.test(s)) return 'validation';
 if (/API 400|HTTP|timeout/i.test(s)) return 'service';
 return 'unresolved';
}
export function recoveryPostUrl(row) {
 for(const raw of [row?.item?.sourceUrl,row?.sourceUrl])try{
  const u=new URL(raw);
  if(u.protocol!=='https:')continue;
  if((/^(www\.)?vk\.(ru|com)$/.test(u.hostname)&&/^\/wall-?\d+_\d+$/.test(u.pathname))||
    (u.hostname==='t.me'&&/^\/(s\/)?[\w]+\/\d+$/.test(u.pathname)))return u.origin+u.pathname;
 }catch{}
 return '';
}
export function needsParserCapture(row, posterlessUrls = new Set()) {
 const url=recoveryPostUrl(row);if(!url)return false;
 const item=row.item||{};
 const media=Array.isArray(item.imageMedia)?item.imageMedia:[];
 return posterlessUrls.has(url)||classifyParserError(row)==='capture'||
  Boolean(item.__skippedImageUrls?.length)||
  (!item.imageUrls?.length && media.some(image=>image.url));
}
export function buildPosterRecoveryCandidates(groups,hasUsableMedia,{requireBrowserUrl=true}={}) {
 return groups.filter(group=>group.events?.some(event=>!hasUsableMedia(event))).flatMap(group=>{
  const sourceId=group.sourceType==='vk'?'vk:'+group.screenName:
   group.sourceType==='telegram'?'tg:'+group.channel:'chat:'+group.peerId;
  const itemId=String(group.postId??group.messageId??group.conversationMessageId??'');
  const sourceUrl=group.events.map(event=>event.sourceUrl).find(url=>recoveryPostUrl({sourceUrl:url})) || (!requireBrowserUrl ? group.events[0]?.sourceUrl || '' : '');
  if((requireBrowserUrl&&!sourceUrl)||!itemId)return [];
  const imageUrls=group.imageUrls?.length?group.imageUrls:[...new Set((group.imageMedia||[]).map(image=>image.url).filter(Boolean))];
  return [{sourceId,itemId,sourceUrl,item:{
   screenName:group.screenName,postId:group.postId,channel:group.channel,messageId:group.messageId,
   peerId:group.peerId,conversationMessageId:group.conversationMessageId,
   sourceUrl,text:group.rawText||'',imageUrls,imageMedia:group.imageMedia||[],
  }}];
 });
}
export async function prepareRecoveryPage(page,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),random=Math.random,expectedImageCount=0,hasAnnouncementDate=false}={}) {
 await sleep(25_000);
 const maximum=expectedImageCount===1&&hasAnnouncementDate?8:5;
 for(let attempt=0;attempt<maximum;attempt++){
  const state=await page.evaluate(()=>{
   window.scrollBy(0,Math.max(500,innerHeight*.8));
   const imgs=[...document.querySelectorAll('img')].filter(i=>i.width>=180||i.height>=180);
   return {broken:imgs.some(i=>!i.complete||i.naturalWidth===0),count:imgs.length};
  });
  if(!state.broken && (state.count>0||!expectedImageCount))return;
  const carousel=expectedImageCount>1 || (!expectedImageCount&&state.count>1);
  if(attempt >= (carousel?1:maximum-1))return;
  await sleep(20_000+Math.min(20_000,Math.max(0,Math.floor(random()*20_001))));
  await page.reload({waitUntil:'domcontentloaded',timeout:45_000});
  // DOMContentLoaded alone does not mean lazy images have appeared.
  await sleep(25_000);
 }
}
export async function captureRecoveryPosts(rows,capture,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),random=Math.random}={}) {
 const result=new Map(),jobs=new Set();
 for(const row of rows){
  const url=recoveryPostUrl(row);if(!url||result.has(url))continue;
  if(jobs.size>=20)await Promise.race(jobs);
  if(result.size)await sleep(5_000+Math.min(10_000,Math.max(0,Math.floor(random()*10_001))));
  result.set(url,{pending:true});
  const job=Promise.resolve().then(()=>capture(url)).then(item=>result.set(url,{item}),error=>result.set(url,{error:String(error?.message||error)}));
  jobs.add(job);job.finally(()=>jobs.delete(job));
 }
 await Promise.all(jobs);return result;
}
