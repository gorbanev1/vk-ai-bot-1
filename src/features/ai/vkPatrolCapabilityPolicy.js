import {patrolPlannerObservations} from './vkPatrolNativeExecution.js';
// Explicit, small tool surface for the existing-function-only patrol mode.
// A model's JSON is never an authorization token.
export const PATROL_ALLOWED_ACTIONS=Object.freeze([
 'resume_task','task_history','recent_photos','people','history','search_history','help','list_modules','discover_capabilities','recurring_chat',
 'native_capability','normal_route','native_command',
 'db_catalog','db_query','message_context','search_photos','inspect_image','create_image_from_photos',
 'show_parties','create_image','edit_image','pin_photo','answer','silent','clarify','write_module','run_module','delete_module','build_module'
]);
const allowed=new Set(PATROL_ALLOWED_ACTIONS);
export function authorizePatrolAction(action){
 const name=String(action||'').trim();
 if(allowed.has(name))return {ok:true};
 return {ok:false,reason:'tool-not-in-explicit-allowlist'};
}
// A separate, deterministic input guard is required: model prompting alone
// must not authorize deletion or modification of the main application.
export function isPatrolDestructiveDataRequest(text){
 const words=String(text||'').trim()
  .replace(/^(?:\u0433\u0438\u0433\u043e\u0440\u0435\u0439\u0432|gigorave)[\s,:!-]+/iu,'')
  .trim();
 const imperative=/^(?:(?:\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430|\u043c\u043e\u0436\u0435\u0448\u044c|\u043d\u0443-\u043a\u0430)\s+)*(?:\u0443\u0434\u0430\u043b\u0438(?:\u0442\u0435)?|\u0441\u043e\u0442\u0440\u0438|\u0441\u0442\u0435\u0440\u0438|\u043e\u0447\u0438\u0441\u0442\u0438|\u0441\u043d\u0435\u0441\u0438|\u0443\u043d\u0438\u0447\u0442\u043e\u0436\u044c|delete|drop|truncate|remove)(?:\s|$)/iu;
 const object=/(?:\u0431\u0430\u0437|\u0434\u0430\u043d\u043d|\u0438\u043d\u0444\u043e\u0440\u043c\u0430\u0446|\u0441\u043e\u043e\u0431\u0449\u0435\u043d|\u0438\u0441\u0442\u043e\u0440|\u0437\u0430\u043f\u0438\u0441|\u0434\u043e\u0441\u044c\u0435|\u043b\u043e\u0433|\u0444\u0430\u0439\u043b|\u0444\u043e\u0442\u043e|\u043c\u043e\u0434\u0443\u043b|\u043a\u043e\u0434|\u0432\u0441\u0451|\u0432\u0441\u0435|database|record)/iu;
 return imperative.test(words)&&object.test(words);
}
const evidenceActions=new Set(['resume_task','task_history','native_capability','show_parties','create_image','edit_image','create_image_from_photos','pin_photo','recent_photos','people','history','search_history',
 'list_modules','help','run_module','build_module','db_catalog','db_query','message_context','search_photos','inspect_image','discover_capabilities','recurring_chat']);
export function shouldReviewPatrolAnswer(notes=[]){
 return Array.isArray(notes)&&notes.some(x=>evidenceActions.has(String(x?.action||''))&&
  Object.hasOwn(x,'result'));
}
export function serializePatrolEvidence(notes=[],limit=12500){
 return patrolPlannerObservations(Array.isArray(notes)?notes:[],Math.max(1000,Math.min(20000,limit)));
}
