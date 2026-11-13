import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadParserReplayEvidence } from './parserReplayEvidence.js';
import { parseIndexedImageFacts, selectBestCompatiblePosterFact, scorePosterFactMetadataQuality } from '../events/eventPosterMatching.js';
import { detectRasterImageDimensions } from '../events/eventImageSelection.js';

// Local evidence only. Invoked in parserWorkWorker; never downloads a CDN URL.
export function repairPosterBindingsFromArchive({ groups=[], rows=[], dataDirectory='./data' }={}) {
 const updates=[], reports=[];
 for(const group of groups) {
  const sourceId=group.sourceType==='vk'?'vk:'+group.screenName:group.sourceType==='telegram'?'tg:'+group.channel:'chat:'+group.peerId;
  const itemId=String(group.postId??group.messageId??group.conversationMessageId??'');
  const urls=group.imageUrls?.length?group.imageUrls:(group.imageMedia||[]).map(x=>x.url).filter(Boolean);
  const evidenceRows=rows.filter(row=>row.sourceId===sourceId&&String(row.itemId)===itemId);
  evidenceRows.push({sourceId,itemId,item:{postId:itemId,sourceUrl:group.events?.[0]?.sourceUrl,text:group.rawText,imageUrls:urls}});
  const evidence=loadParserReplayEvidence({rows:evidenceRows,discoverArchives:true,dataDirectory});
  const item=evidence.itemsById.get(itemId);
  const gallery=item?.imageUrls?.length?item.imageUrls:urls;
  const folder=group.sourceType==='vk'?'vk_announcements/'+group.screenName:group.sourceType==='telegram'?'telegram_announcements/'+group.channel:'vk_chat_announcements/vk-chat-'+group.peerId;
  const facts=[];
  for(const fact of [...(group.imageVisionFacts||[]),...(group.events||[]).flatMap(e=>e.posterVisionFacts||[])]) {
   const index=Number(fact.index); if(!index)continue;
   // Source facts belong to the source's own URL ordering.
   const url=urls[index-1];
   const currentIndex=url?gallery.indexOf(url)+1:index;
   if(currentIndex<1)continue;
   facts.push({...fact,index:currentIndex,originalIndex:index});
  }
  for(const [key,saved] of evidence.posterGateImages) {
   const [source,id,,url]=key.split('\0');
   const index=gallery.indexOf(url)+1;
   if(source!==sourceId||id!==itemId||index<1)continue;
   for(const fact of parseIndexedImageFacts(saved.responseText))facts.push({...fact,index});
  }
  const bound=new Map();
  for(const fact of facts) {
   if(fact.poster!==true)continue;
   const index=fact.index, oldIndex=fact.originalIndex||index;
   const candidates=[fact.imagePath,...(group.imagePaths||[]).filter(p=>new RegExp('-'+oldIndex+'(?:-[a-f0-9]{8,64})?\\.[^.]+$','i').test(p)),
    ...['.jpg','.png','.webp','.jpeg'].map(ext=>folder+'/'+itemId+'-'+oldIndex+ext)];
   const cache=evidence.imageCache.get(gallery[index-1]);
   const paths=candidates.filter(Boolean).map(p=>resolve(dataDirectory,p));
   if(cache?.path)paths.push(resolve(cache.path));
   for(const absolute of paths) {
    if(!existsSync(absolute))continue;
    let buffer;try{buffer=readFileSync(absolute);}catch{continue;}
    const dimensions=detectRasterImageDimensions(buffer);
    if(!dimensions.width||!dimensions.height)continue;
    const digest=createHash('sha256').update(buffer).digest('hex');
    if(fact.imageSha256&&fact.imageSha256!==digest)continue;
    const extension=/^\.(jpg|jpeg|png|webp)$/i.test(extname(absolute))?extname(absolute):cache?.mimeType==='image/png'?'.png':cache?.mimeType==='image/webp'?'.webp':'.jpg';
    const path=join(folder,itemId+'-'+index+'-'+digest.slice(0,12)+extension).replace(/\\/g,'/');
    const candidate={...fact,imagePath:path,imageFilename:basename(path),imageSha256:digest};
    const previous=bound.get(path);
    if(!previous||scorePosterFactMetadataQuality(candidate)>scorePosterFactMetadataQuality(previous.fact))bound.set(path,{fact:candidate,buffer});
    break;
   }
  }
  for(const event of group.events||[]) {
   const selection=selectBestCompatiblePosterFact(event,[...bound.values()].map(x=>x.fact),{preferredIndex:event.posterImageIndex});
   if(!selection||selection.ambiguous)continue;
   const {fact}=selection;
   const target=resolve(dataDirectory,fact.imagePath);
   mkdirSync(resolve(target,'..'),{recursive:true});
   if(!existsSync(target))writeFileSync(target,bound.get(fact.imagePath).buffer,{flag:'wx'});
   updates.push({sourceType:event.sourceType,id:event.id,event:{...event,imagePaths:[fact.imagePath],posterImageIndex:fact.index,
    posterMatchStatus:event.isMultiAnnouncement?'verified_multi_event_poster':'verified_single_event_source_media',
    posterMatchReason:'archive-recovery:'+selection.match.reason,posterVisionFacts:[fact]}});
  }
  reports.push({sourceId,itemId,archiveImages:evidence.imageCache.size,compatibleFiles:bound.size,updated:updates.filter(u=>group.events.some(e=>e.id===u.id&&e.sourceType===u.sourceType)).length});
 }
 return {updates,reports};
}
