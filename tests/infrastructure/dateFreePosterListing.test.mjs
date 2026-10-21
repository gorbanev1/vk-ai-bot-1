import test from 'node:test';
import assert from 'node:assert/strict';
import {upsertVkSourcePost,replaceVkEventsForPost,getVkUpcomingEvents} from '../../src/infrastructure/database/index.js';

test('phase two posterior binding survives SQLite and listing without a date in body',()=>{
 const screenName='datefree_roundtrip'; const postId=5; const sourceUrl='https://vk.ru/wall-999999_5';
 const event={title:'RammPage',eventDate:'2099-10-24',venue:'Rock Bar',status:'approved',imagePaths:[],
  parseMethod:'gigachat_validated_phase2_poster_v2',posterImageIndex:1,posterMatchStatus:'exact_poster_match',
  posterVisionFacts:[{index:1,poster:true,imageType:'poster',posterConfidence:99,title:'RammPage',dates:'24 октября 2099',
   dateFreeEventBinding:{eventDate:'2099-10-24',title:'RammPage'}}]};
 const now=Math.floor(Date.now()/1000);
 upsertVkSourcePost({screenName,postId,sourceUrl,publishedAt:now,rawText:'Новое меню, бронируйте стол.',imageUrls:[],imagePaths:[],contentHash:'datefree',parseStatus:'events-found',fetchedAt:now,imageVisionFacts:event.posterVisionFacts});
 replaceVkEventsForPost({screenName,postId,sourceUrl,imagePaths:[],events:[event]});
 const listed=getVkUpcomingEvents({screenName,fromDate:'2099-10-01',requireDateEvidence:true});
 assert.equal(listed.length,1);
 assert.equal(listed[0].eventDate,'2099-10-24');
 assert.equal(listed[0].posterVisionFacts[0].dateFreeEventBinding.eventDate,'2099-10-24');
});
