import {extractExplicitGptMode} from '../ai/gptModeRouting.js';
import {inspectVkMessageStructure,vkDirectAttachments,vkAttachmentType,vkStickerImageUrl} from '../../platforms/vk/vkMessageStructure.js';

export function decideVkConversationInput({message={},text='',mentioned=false,addressed=false,hasButton=false,voicePending=false}={}) {
 const structure=inspectVkMessageStructure(message);
 const stickers=vkDirectAttachments(message).filter(a=>vkAttachmentType(a)==='sticker')
  .map(a=>({type:'sticker',url:vkStickerImageUrl(a)}));
 let body=String(text||'').trim();
 if(stickers.length&&/^(?:стикер|\[стикер\])$/iu.test(body)&&!String(message.text||'').trim())body='';
 const mode=extractExplicitGptMode(body);
 body=String(mode.body??body).trim();
 if(hasButton||voicePending)return {action:'continue',structure,stickers};
 const directVoice=structure.attachments.some(a=>a.scope==='current'&&['audio_message','voice'].includes(a.type));
 if(directVoice)return {action:'continue',structure,stickers};
 const bare=body.replace(/^[\s,!:.]+|[\s,!:.]+$/gu,'');
 const reply=message.reply_message||message.replyMessage||message.reply_to_message||message.replyToMessage;
 const confirmation=/^(?:да|нет|ок(?:ей)?|ладно|согласен|согласна|ага|угу)[!.,\s]*$/iu.test(bare);
 const reaction=/^(?:(?:ха){2,}|(?:ах){2,}|(?:хе){2,}|ахах[ах]*|лол|кек|спасибо(?: большое)?|благодарю|понятно|понял(?:а)?|ясно|класс|супер|круто|точно|именно)[!.,\s]*$/iu.test(bare)
  ||(!/[\p{L}\p{N}]/u.test(body)&&!/[?？]/u.test(body)&&Boolean(body));
 // Text confirmations of a question remain available to pending workflows.
 const isReaction=reaction||(confirmation&&!/[?？]/u.test(String(reply?.text||'')));
 const vague=/^(?:[?？]+|а это[?？!.,]*|ну[?？!.,]*|сделай(?: это)?[!.,]*|давай[!.,]*|помоги[!.,]*|вот[!.,]*|с этим[?？!.,]*)$/iu.test(bare);
 const action=isReaction?'silent':!bare?(mentioned||mode.source!=='implicit'?'clarify':'silent'):
  vague?(addressed?'clarify':'silent'):'continue';
 return {action,structure,stickers};
}

// Perception may inform diagnostics; it can never manufacture a user task or public description.
export async function handleVkConversationInput(decision,{inspectSticker,send,observe}={}) {
 if(decision.action==='continue')return false;
 for(const sticker of decision.stickers){
  if(!sticker.url){observe?.({type:'sticker',status:'unavailable'});continue;}
  try{const result=await inspectSticker(sticker,decision.structure);
   observe?.({type:'sticker',status:'observed',result});
  }catch(error){observe?.({type:'sticker',status:'failed',error:String(error?.message||error).slice(0,200)});}
 }
 if(decision.action==='clarify')await send('Что нужно сделать с этим сообщением?');
 return true;
}
