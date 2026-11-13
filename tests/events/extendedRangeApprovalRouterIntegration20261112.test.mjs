import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
const snippet=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
test('no primary, secondary or combined event range bypasses approval before the outgoing serial worker',()=>{
 for(const fn of ['async function sendPublicEventsForRange(context, ...args)',
                  'async function sendAllPartiesForRange(context, ...args)']){
  const s=snippet(fn,'return runPartyDeliverySerial(');
  assert.match(s,/maybeQueueExtendedRangeApproval\(context,args\[0\],args\[1\]/u);
  assert.match(s,/if\(gate\)return gate/u);
 }
 assert.match(app,/approvedRangeDeliveryContexts\.add\(context\)/u);
 assert.match(app,/if\(approvedRangeDeliveryContexts\.has\(context\)/u);
});
test('owner buttons on VK and Telegram use the same durable request ID and require verified owner identity',()=>{
 assert.match(app,/callback_data:'prg:y:'\+id/u);
 assert.match(app,/callback_data:'prg:n:'\+id/u);
 assert.match(app,/action:'party_range_approval',id,choice:'approve'/u);
 assert.match(app,/action:'party_range_approval',id,choice:'deny'/u);
 assert.match(app,/const authorized=isOwnerContext\(context\)&&isPrivateContext\(context\)/u);
 assert.match(app,/const allowed=userId===LIMIT_RESET_ADMIN_USER_ID&&/u);
 assert.match(app,/const decision=extendedRangeApprovalStore\.decide\(/u);
 assert.match(app,/if\(!decision\.ok\)return decision/u);
});
test('group reminder text and group event reminder buttons are denied to nonowners',()=>{
 assert.match(app,/if\(!isPrivateContext\(context\)&&!isOwnerContext\(context\)&&/u);
 assert.match(app,/if\(action==='event_remind_group'&&userId!==String\(LIMIT_RESET_ADMIN_USER_ID\)\)/u);
 assert.match(app,/if\(!isOwnerContext\(context\)\)\{\s*await context\.send\(/u);
});
