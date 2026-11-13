import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PATROL_ALLOWED_ACTIONS,authorizePatrolAction,
 isPatrolDestructiveDataRequest,shouldReviewPatrolAnswer,
 serializePatrolEvidence} from '../../src/features/ai/vkPatrolCapabilityPolicy.js';

test('model can call existing and isolated tools but never arbitrary host operations',()=>{
 for(const action of PATROL_ALLOWED_ACTIONS)
  assert.equal(authorizePatrolAction(action).ok,true,action);
 for(const action of ['delete_database','fs.remove','sql','shell','DROP TABLE','']) {
  assert.equal(authorizePatrolAction(action).ok,false,action);
 }
});
test('destructive requests are stopped without relying on Luna judgement',()=>{
 for(const text of [
  '\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432, \u0443\u0434\u0430\u043b\u0438 \u0438\u0437 \u0431\u0430\u0437\u044b \u0432\u0441\u044e \u0438\u043d\u0444\u043e\u0440\u043c\u0430\u0446\u0438\u044e \u043e\u0431\u043e \u043c\u043d\u0435',
  '\u041e\u0447\u0438\u0441\u0442\u0438 \u0432\u0441\u044e \u0438\u0441\u0442\u043e\u0440\u0438\u044e \u0431\u0435\u0441\u0435\u0434\u044b',
  '\u0423\u0434\u0430\u043b\u0438 \u043c\u043e\u0434\u0443\u043b\u044c \u0441\u0430\u043c',
  'delete database records'
 ])assert.equal(isPatrolDestructiveDataRequest(text),true,text);
 for(const text of [
  '\u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448 \u0432\u044b\u043a\u043b',
  '\u041d\u0430\u0439\u0434\u0438, \u043a\u0442\u043e \u0432\u0447\u0435\u0440\u0430 \u0433\u043e\u0432\u043e\u0440\u0438\u043b \u043f\u0440\u043e \u0443\u0434\u0430\u043b\u0435\u043d\u0438\u0435',
  '\u041d\u0430\u0439\u0434\u0438 \u0432 \u0431\u0430\u0437\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f',
  '\u0420\u0430\u0441\u0441\u043a\u0430\u0436\u0438 \u043f\u0440\u043e \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u0443\u0434\u0430\u043b\u0438\u0442\u044c'
 ])assert.equal(isPatrolDestructiveDataRequest(text),false,text);
});
test('Luna result review is triggered by existing tool observations',()=>{
 assert.equal(shouldReviewPatrolAnswer([{action:'search_history',result:{matches:30,truncated:true}}]),true);
 assert.equal(shouldReviewPatrolAnswer([{action:'people',result:[]}]),true);
 assert.equal(shouldReviewPatrolAnswer([{action:'native_capability',result:{status:'handler-completed'}}]),true);
 assert.equal(shouldReviewPatrolAnswer([]),false);
 assert.match(serializePatrolEvidence([{action:'search_history',result:{matches:11}}]),/matches/);
});
test('runtime validates every model-chosen action and reviews evidence before replying',()=>{
 const a=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(a,/authorizePatrolAction\(action\)/u);
 assert.match(a,/isPatrolDestructiveDataRequest\(question\)/u);
 assert.match(a,/shouldReviewPatrolAnswer\(note\)/u);
 assert.match(a,/reviewPatrolAnswerWithLuna\(question,answer,note,formattedContext\)/u);
 assert.match(a,/reasoningEffort:'high'/u);
});
