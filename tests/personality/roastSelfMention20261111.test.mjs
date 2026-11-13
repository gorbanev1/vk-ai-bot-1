import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseRoastCommand,isRoastBotSelfReference} from '../../src/features/personality/roastCommandRouting.js';
test('exact real VK group mention invokes bot self-roast, not an unrelated person',()=>{
 const parsed=parseRoastCommand('\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432 \u0434\u043e\u0435\u0431\u0430\u0442\u044c\u0441\u044f \u0434\u043e [club233007447|@gigorave]');
 assert.deepEqual(parsed,{matched:true,mode:'named',targetQuery:'[club233007447|@gigorave]'});
 assert.equal(isRoastBotSelfReference(parsed.targetQuery,{vkGroupId:233007447}),true);
 assert.equal(isRoastBotSelfReference(parsed.targetQuery,{vkGroupId:233007448}),false);
 assert.equal(isRoastBotSelfReference('[club181824119|Oleg]',{vkGroupId:233007447}),false);
 assert.equal(isRoastBotSelfReference('[id181824119|Oleg]',{vkGroupId:233007447}),false);
});
test('only exact bot aliases map to the bot',()=>{
 for(const name of ['@gigorave','gigorave','GIGORAVE','\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432','@gigorave_bot'])
  assert.equal(isRoastBotSelfReference(name,{vkGroupId:233007447}),true,name);
 for(const name of ['\u041e\u043b\u0435\u0433','@gigorave_xyz','\u0413\u0438\u0433\u043e\u0440\u0435\u0439\u0432 \u041e\u043b\u0435\u0433',''])
  assert.equal(isRoastBotSelfReference(name,{vkGroupId:233007447}),false,name);
});
test('self selection precedes human roster and model selection',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 const start=app.indexOf('async function handleRoastCommand(');
 const end=app.indexOf('function randomUnitInterval()',start);
 const body=app.slice(start,end);
 assert.match(body,/isRoastBotSelfReference\(parsedCommand\.targetQuery/u);
 assert.match(body,/buildBotSelfDossier\(/u);
 assert.match(body,/\[ROAST SELF TARGET\]/u);
 assert.ok(body.indexOf('isRoastBotSelfReference')<body.indexOf('const now = Math.floor'));
});
