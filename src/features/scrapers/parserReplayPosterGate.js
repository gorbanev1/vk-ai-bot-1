// Replay uses the same Vision extractor and image-index contract as parser-all.
export function createReplayPosterGate({extract,prepareImage,getCachedImageFact=()=>'',log=()=>{}}){
 const results=new Map();
 const key=(source,id)=>String(source)+'\0'+String(id);
 return {
  getResult:(source,id)=>results.get(key(source,id))||null,
  async onCapture(payload){
   for(const request of payload?.posterGateRequests||[]){
    const sourceId=request.sourceId||payload.sourceId;
    const urls=Array.isArray(request.imageUrls)?request.imageUrls:[];
    const indexes=urls.map(url=>(request.originalImageUrls||urls).indexOf(url)+1);
    const skippedImageUrls=[];let facts='',error='';
    try{
     facts=await extract({
      imageUrls:urls,prepareImage:url=>prepareImage(url,request.sourceUrl),
      browserCacheOnly:true,sourceUrl:request.sourceUrl,
      sourceLabel:request.source||request.sourceLabel||sourceId,
      sourceText:String(request.sourceText||''),
      dateFreePhase:request.visionPhase==='phase2-date-free-image',
      imageIndexes:indexes,secondaryJointGate:Boolean(request.secondaryJointGate),
      getCachedImageFact:(number,url)=>getCachedImageFact({...request,sourceId},number,url),
      trace:(stage,data={})=>{
       if(stage==='image_skipped'&&data.imageUrl)skippedImageUrls.push(data.imageUrl);
       log('item.poster-gate.'+stage,{sourceId,itemId:request.itemId,...data});
      },
     });
    }catch(e){facts=String(e?.partialFacts||'');error=String(e?.message||e);
     log('item.poster-gate.error',{sourceId,itemId:request.itemId,error});}
    results.set(key(sourceId,request.itemId),{attempted:true,facts:String(facts||''),error,
     skippedImageUrls,dateFreePhase:request.visionPhase==='phase2-date-free-image',
     inspectedImageUrls:urls,inspectedImageIndexes:indexes});
   }
  }
 };
}
