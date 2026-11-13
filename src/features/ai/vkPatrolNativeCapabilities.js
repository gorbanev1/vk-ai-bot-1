import {parseHuinglishCommand} from '../english/huinglishVkLesson.js';
import {parseEnglishGrammarCommand} from '../english/englishGrammarCourse.js';

// Existing native handlers remain the only executors. This is metadata and
// input validation, NOT a new execution API and NOT a way around permissions.
const defs=[
 {id:'huinglish.status',family:'huinglish',type:'status',command:'\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0441\u0442\u0430\u0442\u0443\u0441',readOnly:true,
  description:'Show current HuInglish course status and progress. Use for questions if it is enabled.'},
 {id:'huinglish.enable',family:'huinglish',type:'on',command:'\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0432\u043a\u043b',readOnly:false,
  description:'Enable HuInglish in this VK chat only if explicitly requested.'},
 {id:'huinglish.disable',family:'huinglish',type:'off',command:'\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0432\u044b\u043a\u043b',readOnly:false,
  description:'Disable HuInglish in this VK chat only if explicitly requested.'},
 {id:'huinglish.next',family:'huinglish',type:'next',command:'\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439',readOnly:false,
  description:'Request the next HuInglish lesson, only on explicit instruction.'},
 {id:'huinglish.lesson',family:'huinglish',type:'lesson',parameter:'lesson',readOnly:false,
  description:'Start a specifically numbered HuInglish lesson, requires args.lesson integer 1..99.'},
 {id:'english.status',family:'english',type:'status',command:'English \u0441\u0442\u0430\u0442\u0443\u0441',readOnly:true,
  description:'Show English grammar course status and progress.'},
 {id:'english.lessons',family:'english',type:'list',command:'English \u0443\u0440\u043e\u043a\u0438',readOnly:true,
  description:'List the available English grammar lessons.'},
 {id:'english.enable',family:'english',type:'on',command:'English \u0432\u043a\u043b',readOnly:false,
  description:'Enable English grammar lessons; require explicit instruction.'},
 {id:'english.disable',family:'english',type:'off',command:'English \u0432\u044b\u043a\u043b',readOnly:false,
  description:'Disable English grammar lessons; require explicit instruction.'},
 {id:'english.next',family:'english',type:'next',command:'English \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439',readOnly:false,
  description:'Request the next English grammar lesson.'},
 {id:'english.lesson',family:'english',type:'lesson',parameter:'lesson',readOnly:false,
  description:'Start a numbered English grammar lesson, requires args.lesson integer 1..99.'},
];
export const PATROL_NATIVE_CAPABILITIES=Object.freeze(defs.map(d=>Object.freeze({...d})));
const byId=new Map(PATROL_NATIVE_CAPABILITIES.map(d=>[d.id,d]));
const parserFor={huinglish:parseHuinglishCommand,english:parseEnglishGrammarCommand};
const topicMention={
 huinglish:/\u0445\u0443\u0438\u043d\u0433\u043b\u0438\u0448|\u0445\u0438\u0443\u043d\u0433\u043b\u0438\u0448|huinglish/iu,
 english:/\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a|\u0438\u043d\u0433\u043b\u0438\u0448|\u0430\u043d\u0433\u043b\u0438\u0448|english|\u044d\u043d\u0433\u043b\u0438\u0448/iu,
};
const explicitVerb={
 on:/\u0432\u043a\u043b|\u0432\u043a\u043b\u044e\u0447|\u0437\u0430\u043f\u0443\u0441\u0442|\u043d\u0430\u0447\u043d\u0438|\u0430\u043a\u0442\u0438\u0432\u0438\u0440\u0443\u0439/iu,
 off:/\u0432\u044b\u043a\u043b|\u043e\u0442\u043a\u043b|\u043e\u0441\u0442\u0430\u043d\u043e\u0432|\u043f\u0440\u0435\u043a\u0440\u0430\u0442|\u0443\u0431\u0435\u0440\u0438/iu,
 next:/\u0441\u043b\u0435\u0434\u0443\u044e\u0449|\u0434\u0430\u043b\u044c\u0448\u0435|\u0434\u0430\u043b\u0435\u0435|\u043f\u0440\u043e\u0434\u043e\u043b\u0436/iu,
 lesson:/\u0443\u0440\u043e\u043a|\u0437\u0430\u043d\u044f\u0442\u0438/iu
};
const hypothetical=/\u043a\u0430\u043a\s+(?:\u043c\u043d\u0435\s+)?(?:\u0432\u043a\u043b\u044e\u0447|\u0432\u044b\u043a\u043b\u044e\u0447|\u043e\u0442\u043a\u043b\u044e\u0447)|\u0447\u0442\u043e\s+\u0431\u0443\u0434\u0435\u0442\s+\u0435\u0441\u043b\u0438|\u043c\u043e\u0436\u043d\u043e\s+\u043b\u0438/iu;
const negated=/\u043d\u0435\s+(?:\u043d\u0430\u0434\u043e|\u043d\u0443\u0436\u043d\u043e|\u0441\u0442\u043e\u0438\u0442)\s+(?:\u0432\u043a\u043b\u044e\u0447|\u0432\u044b\u043a\u043b\u044e\u0447|\u043e\u0442\u043a\u043b\u044e\u0447)|\u043d\u0435\s+(?:\u0432\u043a\u043b\u044e\u0447\u0430\u0439|\u0432\u044b\u043a\u043b\u044e\u0447\u0430\u0439|\u043e\u0442\u043a\u043b\u044e\u0447\u0430\u0439)/iu;
export function patrolNativeCapabilityCatalog(){
 return PATROL_NATIVE_CAPABILITIES.map(d=>({
  id:d.id,description:d.description,readOnly:d.readOnly,
  parameters:d.parameter?{[d.parameter]:'integer 1..99'}:{},
 }));
}
export function resolvePatrolNativeCapability({capabilityId,args={},confidence=0,request=''}={}){
 const definition=byId.get(String(capabilityId||''));
 if(!definition)return {ok:false,reason:'unknown-capability'};
 const score=Number(confidence);
 if(!Number.isFinite(score)||score<0.55||score>1)
  return {ok:false,reason:'low-confidence'};
 const raw=String(request||'').trim();
 if(!raw)return {ok:false,reason:'missing-user-request'};
 if(!definition.readOnly){
  if(score<0.85)return {ok:false,reason:'state-change-confidence'};
  if(!topicMention[definition.family].test(raw)||!explicitVerb[definition.type]?.test(raw)
    ||hypothetical.test(raw)||negated.test(raw)||/не\s+(?:запускай|начинай|продолжай|включай|выключай|отключай|останавливай|активируй|показывай)/iu.test(raw))
   return {ok:false,reason:'explicit-user-intent-required'};
  // Never confuse enable and disable when both appear.
  if(['on','off'].includes(definition.type)&&
   explicitVerb[definition.type==='on'?'off':'on'].test(raw))
   return {ok:false,reason:'ambiguous-control-intent'};
 }
 let command=definition.command;
 if(definition.parameter){
  const n=Number(args?.[definition.parameter]);
  if(!Number.isInteger(n)||n<1||n>99)return {ok:false,reason:'invalid-lesson'};
  if(definition.type==='lesson'&&!new RegExp('(?:^|\\D)'+n+'(?:\\D|$)','u').test(raw))
   return {ok:false,reason:'lesson-not-specified-by-user'};
  command=(definition.family==='english'?'English':'\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448')+
   ' \u0443\u0440\u043e\u043a '+n;
 }
 const parsed=parserFor[definition.family](command);
 if(!parsed||parsed.type!==definition.type||
   (definition.parameter&&parsed.id!==Number(args[definition.parameter])))
  return {ok:false,reason:'native-parser-rejected'};
 return {ok:true,capabilityId:definition.id,command,readOnly:definition.readOnly,
  expectedResult:definition.type,confidence:score};
}
