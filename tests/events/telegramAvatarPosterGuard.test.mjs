import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getEventPosterSafetyAssessment, getEventSourceMediaBindingAssessment } from '../../src/features/events/eventProvenance.js';

const cover='telegram_announcements/kurazhcity/4157-2.jpg';
const poster='telegram_announcements/kurazhcity/4157-1.jpg';
const positive=(path)=>({index:1,poster:true,imageType:'poster',posterConfidence:99,title:'Суперкозлы',dates:'4 ноября',imagePath:path,sourceMediaBinding:true,sourceEventCount:1,sourceImageCount:1,fallbackBinding:'single-event-source-media'});
const negative={index:2,poster:false,imageType:'album-cover',imagePath:cover,sourceMediaBinding:true,sourceEventCount:1,sourceImageCount:2,fallbackBinding:'single-event-source-media'};
const row=(photo)=>({id:298,sourceType:'telegram',title:'Суперкозлы',eventDate:'2026-11-04',isMultiAnnouncement:false,posterMatchStatus:'exact_poster_match',posterMatchReason:'single-event-source-metadata-confirmed',posterImageIndex:1,imagePaths:[photo],posterVisionFacts:[positive(photo),negative]});

test('regression: positive poster fact pointing to the same file as rejected channel avatar is NOT safe',()=>{
 const bad=row(cover);
 assert.equal(getEventPosterSafetyAssessment(bad).accepted,false);
 assert.equal(getEventPosterSafetyAssessment(bad).reason,'selected-file-explicitly-rejected-as-poster');
 assert.equal(getEventSourceMediaBindingAssessment(bad).accepted,false);
});

test('regression: verified real poster remains accepted while unrelated rejected avatar is present as history',()=>{
 const good=row(poster);
 const safety=getEventPosterSafetyAssessment(good);
 assert.equal(safety.accepted,true);
 assert.equal(safety.boundPath,poster);
 assert.equal(getEventSourceMediaBindingAssessment(good).accepted,true);
});

test('regression: source-media audit selects the fact matching the chosen poster index and path',()=>{
 const good={...row(poster),posterVisionFacts:[negative,positive(poster)]};
 const binding=getEventSourceMediaBindingAssessment(good);
 assert.equal(binding.accepted,true);
 assert.equal(binding.boundPath,poster);
 assert.equal(binding.fact.index,1);
});

test('Telegram message DOM extractor ignores header avatar and keeps actual post photo',()=>{
 const source=readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js',import.meta.url),'utf8');
 const at=source.indexOf('        const imageUrlsFrom = (root) => {',source.indexOf('const extracted = await page.evaluate'));
 const end=source.indexOf('\n        const linkUrlsFrom',at);
 assert.ok(at>0&&end>at,'find the real browser collector function');
 const code=source.slice(at,end);
 const fn=new Function('absoluteUrl','unique',code+'\nreturn imageUrlsFrom;')(
     value=>String(value||'').trim(),
     values=>[...new Set(values.filter(Boolean))]
 );
 const parent={className:'tgme_widget_message_user_photo',parentElement:null,getAttribute:()=>''};
 const avatar={
    className:'',naturalWidth:512,naturalHeight:512,parentElement:parent,
    getBoundingClientRect:()=>({width:512,height:512}),
    getAttribute:()=>'',closest:sel=>sel.includes('tgme_widget_message_user_photo')?parent:null,
    currentSrc:'https://cdn4.telesco.pe/old-channel-avatar.jpg',
    src:'https://cdn4.telesco.pe/old-channel-avatar.jpg',
 };
 const photo={
     className:'tgme_widget_message_photo_wrap',parentElement:null,
     getBoundingClientRect:()=>({width:566,height:750}),
     getAttribute:key=>key==='style'?"background-image:url('https://cdn4.telesco.pe/real-poster.jpg')":'',
     closest:()=>null,
 };
 const root={querySelectorAll:sel=>sel==='img'?[avatar]:sel==='[style*="background-image"]'?[photo]:[]};
 assert.deepEqual(fn(root),['https://cdn4.telesco.pe/real-poster.jpg']);
});
