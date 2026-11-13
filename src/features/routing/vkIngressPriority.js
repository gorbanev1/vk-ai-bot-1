const COMMAND=/^(?:(?:гигорейв|гигарейв|gigorave|гигорейвчик)(?:\s|[,!?:]|$)|(?:тус(?:а|ы|овки)?|где\s+кураж|афиша|события|парсер|qtickets|кутикетс|статистика|статы|авторезюме|резюмир\w*|досье|помощь|справка|пинг|ping|id|айди|прожарь|прожарка|хуинглиш|huinglish|грамматика|чтиво|доебат\w*|написать\s+разработчику|показать|а\s+на\s+выходных)(?:\s|[?!.,:]|$))/iu;
export function isLikelyInteractiveVkIncoming({peerId,text='',replySenderId=0,attachments=[],payload=null}={}){
 const peer=Number(peerId);
 if(peer>0&&peer<2000000000)return true; // DMs always receive full supervision.
 if(payload)return true;
 if(Number(replySenderId)<0)return true;
 if(Array.isArray(attachments)&&attachments.some(a=>a?.type==='audio_message'||a?.type==='photo'&&String(text||'').trim()))return true;
 return COMMAND.test(String(text||'').trim());
}
