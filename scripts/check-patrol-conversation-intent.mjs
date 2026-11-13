import 'dotenv/config';
import {writeFileSync,mkdirSync} from 'node:fs';
import {PATROL_CONVERSATION_POLICY} from '../src/features/ai/vkPatrolConversationIntent.js';
const cases=[
 {id:'meme-reaction',message:{speaker:'Oleg',text:'',replyTo:'bot'},branch:['Oleg: Один на один выйдешь?','bot: Выйду, зрители уже собрались.'],perception:{visibleFacts:'A grinning baboon; no text',possibleConversationalRole:'taunting reaction, uncertain'},expected:['answer','silent']},
 {id:'sarcasm-after-lecture',message:{speaker:'Vlad',text:'Спасибо объяснил. А то я вначале и не понял',replyTo:'bot'},branch:['Oleg sends a baboon meme during playful banter','bot: На изображении обезьяна с насмешливым выражением. В контексте переписки она передаёт насмешку и готовность продолжать перепалку.'],expected:['answer']},
 {id:'genuine-thanks',message:{speaker:'Vlad',text:'Спасибо, теперь понял',replyTo:'bot'},branch:['Vlad: Почему в вопросе нужен does?','bot: В Present Simple вопрос с he/she/it строится с does, основной глагол остаётся без -s.'],expected:['answer','silent']},
 {id:'explicit-meme-explanation',message:{speaker:'Oleg',text:'Объясни, что означает этот мем',replyTo:'image'},branch:['Oleg sends a meme'],perception:{visibleFacts:'Dog sitting in a burning room saying This is fine'},expected:['answer']},
 {id:'other-peoples-branch',message:{speaker:'Vlad',text:'ахахах',replyTo:'Oleg'},branch:['bot and Oleg joked earlier','Oleg sends a reaction to Alina, not to the bot','Vlad replies to Oleg'],expected:['silent']},
 {id:'correct-the-output',message:{speaker:'Oleg',text:'Нет, короче и без описания самой картинки',replyTo:'bot'},branch:['bot described all the objects in a meme'],expected:['answer']},
 {id:'actual-tool-task',message:{speaker:'Oleg',text:'Покажи тусы на завтра',replyTo:'bot'},branch:[],expected:['show_parties','normal_route','native_capability']},
 {id:'respect-native-restriction',message:{speaker:'Nikolay',text:'Нет, унизь его',replyTo:'bot'},branch:['Nikolay: Гигорейв доебись до Олега','bot: Этого участника недавно уже прожаривали. Дай человеку выдохнуть.'],expected:['answer']}
];
const key=process.env.OPENAI_COMPAT_API_KEY;
if(!key)throw Error('Missing model credential');
const base=(process.env.OPENAI_COMPAT_BASE_URL||'https://router.cheap/v1').replace(/\/+$/,'');
const start=Date.now();
const decisions=[];
async function check(c){
 const {expected,...input}=c;
 const response=await fetch(base+'/chat/completions',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-6-luna',reasoning_effort:'high',temperature:0.2,stream:false,messages:[{role:'system',content:PATROL_CONVERSATION_POLICY+' Return one JSON object {action,intent,confidence,answer}. Available actions answer, silent, clarify, inspect_image, show_parties, normal_route, native_capability. Supplied perception is already verified visual evidence. No tools execute in this isolated check.'},{role:'user',content:JSON.stringify(input)}]})});
 if(!response.ok)throw Error('Model HTTP '+response.status);
 const data=await response.json();const content=data.choices?.[0]?.message?.content||'';
 const clean=String(content).replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
 const actual=JSON.parse(clean);
 const decision={id:c.id,expected,actual,actionAccepted:expected.includes(actual.action),usage:data.usage};
 decisions.push(decision);console.log('CASE',JSON.stringify(decision));
}
for(let i=0;i<cases.length;i+=2)await Promise.all(cases.slice(i,i+2).map(check));
const report={at:new Date().toISOString(),model:'gpt-6-luna',elapsedMs:Date.now()-start,decisions,note:'Isolated text/context policy probe using supplied visual observations; not a live chat send or end-to-end image test.'};
mkdirSync('logs',{recursive:true});writeFileSync('logs/patrol-conversation-intent-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(decisions.some(x=>!x.actionAccepted))process.exitCode=1;
