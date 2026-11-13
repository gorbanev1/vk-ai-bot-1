/** Pick one authoritative image source. Photo attached to the command wins over a reply. */
const str=x=>String(x??'').trim();
function largest(photo){
 if(!photo||typeof photo!=='object')return '';
 const items=[];
 const add=(url,weight)=>{if(/^https?:\/\//iu.test(str(url)))items.push({url:str(url),weight})};
 for(const s of Array.isArray(photo.sizes)?photo.sizes:[])add(s?.url??s?.src,(Number(s?.width)||0)*(Number(s?.height)||0));
 add(photo.max_size_url,Number.MAX_SAFE_INTEGER);add(photo.orig_photo?.url,Number.MAX_SAFE_INTEGER-1);
 for(const [name,url]of Object.entries(photo)){const m=/^(?:photo|src)_(\d+)$/iu.exec(name);if(m)add(url,Number(m[1]));}
 return items.sort((a,b)=>b.weight-a.weight)[0]?.url||'';
}
function images(message){
 const out=[];
 for(const original of Array.isArray(message?.attachments)?message.attachments:[]){
  const a=original?.toJSON?.()||original;
  if(!a||typeof a!=='object')continue;
  const type=str(a.type||a.attachmentType).toLowerCase();
  if(type==='photo'||(!type&&a.photo)){
   const url=largest(a.photo||a);if(url)out.push(url);
  }else if(type==='doc'||type==='document'){
   const doc=a.doc||a.document||a;
   if(str(doc.mime_type||doc.mimeType).toLowerCase().startsWith('image/')||/\.(?:png|jpe?g|webp)$/iu.test(str(doc.title||doc.name))){
    const url=str(doc.url)||largest(doc.preview?.photo);if(/^https?:\/\//iu.test(url))out.push(url);
   }
  }else if(['wall','post','wall_reply'].includes(type)){
   const wall=a.wall||a.post||a.wall_reply||a;
   // Only images directly attached to the wall post, not its entire repost history.
   out.push(...images({attachments:wall.attachments||[]}));
  }
 }
 return [...new Set(out)].slice(0,4);
}
const replyOf=m=>m?.reply_message||m?.replyMessage||m?.reply_to_message||m?.replyToMessage||null;
const cmidOf=m=>Number(m?.conversation_message_id||m?.conversationMessageId||0)||null;
export function selectImmediateImageEditSource(message){
 const m=message?.toJSON?.()||message||{},reply=replyOf(m);
 const candidates=[{message:m,source:'attached-to-command'}];
 if(reply&&typeof reply==='object'){
  candidates.push({message:reply,source:'immediate-reply'});
  const inner=replyOf(reply);
  if(inner&&typeof inner==='object')candidates.push({message:inner,source:'reply-of-reply'});
  for(const f of (Array.isArray(reply.fwd_messages)?reply.fwd_messages:[]).slice(0,4))candidates.push({message:f,source:'reply-forward'});
 }
 for(const f of (Array.isArray(m.fwd_messages)?m.fwd_messages:[]).slice(0,4))candidates.push({message:f,source:'command-forward'});
 for(const candidate of candidates){
  const urls=images(candidate.message);
  if(urls.length)return {hasReply:Boolean(reply),source:candidate.source,conversationMessageId:cmidOf(candidate.message),urls};
 }
 return {hasReply:Boolean(reply),source:reply?'immediate-reply':'attached-to-command',
  conversationMessageId:cmidOf(reply||m),urls:[]};
}
export function buildExplicitImageEditPrompt(value){
 const prompt=str(value).replace(/\s+/gu,' ');
 if(/^(?:дорисуй|добавь|нарисуй)\s+(?:мне\s+)?(?:волосы|волос|причёску|прическу)(?=\s|$)/iu.test(prompt)){
  return prompt+'\nИзменение должно быть заметным: добавь или увеличь густоту естественных волос именно на голове человека. Сохрани лицо, бороду, одежду, окружение и освещение исходного снимка.';
 }
 if(/^(?:добавь|сделай|дорисуй)\s+(?:мне\s+)?бороду(?=\s|$)/iu.test(prompt)){
  return prompt+'\nДобавь на лицо естественную реалистичную бороду и усы. Сохрани узнаваемость лица, прическу, одежду и фон. Никаких надписей.';
 }
 return prompt;
}
