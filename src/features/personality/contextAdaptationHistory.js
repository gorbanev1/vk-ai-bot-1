const BOT_REF=/(?:^|[^\p{L}\p{N}])(?:гигорейв|gigorave)(?=$|[^\p{L}\p{N}])|\[club\d+\|[^\]]*gigorave[^\]]*\]/iu;
const REFUSAL=/(?:не\s+(?:подкалывай|трогай|шли|отвечай|пиши|присылай|тролль|доставай|упоминай|беспокой|спамь)|(?:хватит|перестань|отстань|не надо)\s+(?:меня|мне|писать|подкалывать|напоминать)|не\s+хочу\s+(?:уведомлен|шуток|подколов))/iu;
const INSTRUCTION=/(?:учитывай|учт(?:и|ите)|запомни|запоминай|предпочитаю|я\s+хочу\s+чтобы|хочу\s*,?\s*чтобы|сделай\s*,?\s*чтобы|сделайте\s*,?\s*чтобы|(?:не\s+)?(?:пиши|отвечай|подкалывай|называй|упоминай|напоминай|присылай|добавляй|показывай|освещай)|(?:добавь|убери|измен(?:и|ите))\s+(?:в\s+)?(?:авторезюме|резюме|сводк)|(?:авторезюме|резюме|сводк)[\s\S]{0,75}(?:учитыв|добав|упомин|пиши|выдел|важн))/iu;
const COMMAND_ONLY=/(?:^|\s)(?:авторезюме\s+(?:вкл|выкл|\d{1,2}:\d{2})|тусы\s+(?:сегодня|завтра|недел)|напомни\s+\d|парсер|источники\s*(?:второстепенные)?)/iu;
export function isPotentialContextPreference(row,{botId=-233007447}={}){
 const text=String(row?.text||'').trim();
 if(text.length<4||text.length>2500||!Number.isSafeInteger(Number(row?.senderId))||Number(row?.senderId)<=0)return false;
 if(row?.outbox||row?.isOutbox)return false;
 if(row?.service)return false;
 const addressed=BOT_REF.test(text);
 const instruction=INSTRUCTION.test(text)||REFUSAL.test(text);
 const replyToBot=Number(row?.replySenderId)===Number(botId);
 if(COMMAND_ONLY.test(text)&&!instruction)return false;
 if(addressed&&instruction)return true;
 if(replyToBot&&instruction)return true;
 // Some people address a bot without its name after an immediately adjacent bot reply.
 if(replyToBot&&/(?:сделай|впредь|дальше|лучше|теперь|помни|не\s+(?:надо|нужно|делай)|убери)/iu.test(text))return true;
 return false;
}
export function parseVkHistoryRecord(record){
 let raw={};try{raw=JSON.parse(String(record.raw_message_json||'{}'))}catch{}
 const reply=raw.reply_message||raw.replyMessage||null;
 const originalText=String(record.text||'');
 const forwardedOnly=!originalText.trim()&&(Array.isArray(raw.fwd_messages)&&raw.fwd_messages.length>0);
 return {peerId:Number(record.peer_id),senderId:Number(record.sender_id),
 messageId:Number(record.conversation_message_id),text:originalText,
 outbox:Number(record.is_outbox)===1,service:Boolean(String(record.action_type||''))||forwardedOnly,
 replySenderId:Number(reply?.from_id??reply?.fromId??0)};
}
