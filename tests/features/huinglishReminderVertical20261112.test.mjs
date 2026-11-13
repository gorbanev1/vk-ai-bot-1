import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../src/features/english/huinglishMultiPlatform.js',import.meta.url),'utf8');
test('private HuInglish reminder explicitly identifies spoken English and the next HuInglish lesson',()=>{
 assert.match(source,/\u0414\u0430\u0432\u043d\u043e \u043d\u0435 \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u043b\u0438 \u0440\u0430\u0437\u0433\u043e\u0432\u043e\u0440\u043d\u044b\u0439 \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439 \u2014 \u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448/u);
 assert.match(source,/\u0425\u043e\u0447\u0435\u0448\u044c \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0443\u0440\u043e\u043a \u043f\u043e \u0425\u0443\u0438\u043d\u0433\u043b\u0438\u0448\u0443 \u2116'\+next/u);
});
test('VK reminder has one full-width button per row',()=>{
 const start=source.indexOf('if(reminderButtons)args.keyboard=');
 const end=source.indexOf('if(reply?.conversationMessageId)',start);
 assert.ok(start>0&&end>start);
 const keyboard=source.slice(start,end);
 assert.match(keyboard,/\u0411\u043e\u043b\u044c\u0448\u0435 \u043d\u0435 \u043f\u0440\u0435\u0434\u043b\u0430\u0433\u0430\u0442\u044c/u);
 assert.equal((keyboard.match(/color:'(?:positive|secondary|negative)'/gu)||[]).length,3);
 assert.doesNotMatch(keyboard,/color:'positive'\},\{action:/u);
 assert.match(keyboard,/color:'positive'\}\],\s*\[\{action:/u);
});
test('both Telegram delivery implementations render all reminder actions in separate rows',()=>{
 const matches=[...source.matchAll(/\[\{text:'\u0414\u0430',callback_data:'huinglish:reminder:yes:'\+buttonToken\}\],\s*\[\{text:'\u041d\u0435\u0442, \u0441\u043f\u0440\u043e\u0441\u0438\u0442\u044c \u0447\u0435\u0440\u0435\u0437 \u043d\u0435\u0434\u0435\u043b\u044e',callback_data:'huinglish:reminder:later:'\+buttonToken\}\]/gu)];
 assert.ok(matches.length>=2,'API and legacy fallback paths both must use stacked Telegram buttons');
 assert.ok(source.includes("callback_data:'huinglish:reminder:never:'+buttonToken"));
});
