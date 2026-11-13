import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHuinglishMultiPlatform} from '../../src/features/english/huinglishMultiPlatform.js';
import {createEnglishGrammarCourse} from '../../src/features/english/englishGrammarCourse.js';
import {executePatrolNativeCapability} from '../../src/features/ai/vkPatrolNativeExecution.js';
for(const [family,create,command] of [['english',createEnglishGrammarCourse,'English статус'],['huinglish',createHuinglishMultiPlatform,'Хуинглиш статус']]){
 test(family+' completion hook waits for actual course status delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrol-course-'));let sent=0;
  const vk={api:{messages:{send:async()=>{await new Promise(r=>setImmediate(r));sent++;return {message_id:sent,conversation_message_id:sent};}}}};
  const service=create({vk,dbPath:join(dir,'test.sqlite'),dataDir:dir,logger:{info(){},error(){},warn(){}},sitePromosEnabled:false});
  try{
   const result=await executePatrolNativeCapability({selected:{ok:true,capabilityId:family+'.status',command,expectedResult:'status',readOnly:true},context:{platform:'vk',peerId:2000000011,isPrivate:false,isOwner:false},services:{[family]:service}});
   assert.equal(result.status,'verified');assert.ok(sent>0);assert.ok(result.state);
  }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
 });
}
