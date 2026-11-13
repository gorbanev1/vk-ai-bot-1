import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {inspectTelegramPublicPostMedia} from './telegramPostMedia.js';
import {createVkLaunchStagger} from '../../features/scrapers/vkLaunchStagger.js';

export const TELEGRAM_EVENT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const waitForVideoLaunch=createVkLaunchStagger({makeGapMs:()=>5_000+Math.floor(Math.random()*10_001)});
const sourceKey=value=>{
    const match=String(value||'').match(/^https:\/\/t\.me\/(?:s\/)?([a-z0-9_]{5,})\/(\d+)(?:[?#].*)?$/iu);
    return match?'https://t.me/'+match[1].toLowerCase()+'/'+match[2]:'';
};
const sourceId=url=>createHash('sha256').update(sourceKey(url)).digest('hex');
const assetDirectory=dataDirectory=>resolve(dataDirectory,'telegram_event_videos');
const titleKey=title=>String(title||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/gu,' ').trim();
const eventKey=event=>String(event.eventDate||'')+'|'+titleKey(event.title);
const hasEventMetadata=event=>/^\d{4}-\d{2}-\d{2}$/u.test(event?.eventDate||'')&&Boolean(String(event?.title||'').trim()&&String(event?.venue||'').trim());

export function getTelegramEventVideo(event,{dataDirectory='./data'}={}) {
    const source=sourceKey(event?.sourceUrl||event?.canonicalPostUrl);
    if(!source)return null;
    try{
        const directory=assetDirectory(dataDirectory);
        const metadata=JSON.parse(readFileSync(join(directory,sourceId(source)+'.json'),'utf8'));
        if(metadata.sourceUrl!==source||!metadata.eventKeys?.includes(eventKey(event))||!metadata.file)return null;
        if(basename(metadata.file)!==metadata.file)return null;
        const filePath=join(directory,metadata.file),stat=statSync(filePath);
        if(!stat.isFile()||stat.size!==metadata.bytes||stat.size>TELEGRAM_EVENT_VIDEO_MAX_BYTES||!stat.size)return null;
        return {platform:'telegram',type:'video',filePath,fileSize:stat.size,filename:metadata.file,mimeType:'video/mp4'};
    }catch{return null;}
}
export function isTelegramVideoSource(event,{dataDirectory='./data'}={}) {
    const source=sourceKey(event?.sourceUrl||event?.canonicalPostUrl);
    if(!source)return false;
    try{const data=JSON.parse(readFileSync(join(assetDirectory(dataDirectory),sourceId(source)+'.json'),'utf8'));
        return data.sourceUrl===source&&data.mediaType==='video'&&data.eventKeys?.includes(eventKey(event));}catch{return false;}
}

export async function downloadTelegramPostVideo(url,{directory,fetchImpl=fetch}={}) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!/(?:^|\.)telesco\.pe$|(?:^|\.)telegram\.org$/iu.test(parsed.hostname))throw Error('Untrusted Telegram video host');
    await mkdir(directory,{recursive:true});
    const partial=join(directory,randomUUID()+'.part');
    let handle=null;
    try{
        const response=await fetchImpl(url,{signal:AbortSignal.timeout(90_000),redirect:'error'});
        if(!response.ok||response.status===206)throw Error('Video is unavailable or partial');
        if(!/^video\/mp4(?:;|$)/iu.test(response.headers.get('content-type')||''))throw Error('Source is not an MP4 video');
        const declared=Number(response.headers.get('content-length')||0);
        if(declared>TELEGRAM_EVENT_VIDEO_MAX_BYTES)throw Error('Video exceeds Telegram 50 MB upload limit');
        if(!response.body)throw Error('Empty video response');
        handle=await open(partial,'wx');
        let total=0,prefix=Buffer.alloc(0);const hash=createHash('sha256');
        for await(const chunk of response.body){
            const data=Buffer.from(chunk);total+=data.length;
            if(total>TELEGRAM_EVENT_VIDEO_MAX_BYTES)throw Error('Video exceeds Telegram 50 MB upload limit');
            if(prefix.length<12)prefix=Buffer.concat([prefix,data.subarray(0,12-prefix.length)]);
            hash.update(data);await handle.writeFile(data);
        }
        if(total<12||prefix.toString('ascii',4,8)!=='ftyp'||(declared&&total!==declared))throw Error('Incomplete or invalid MP4');
        await handle.close();handle=null;
        const file=hash.digest('hex')+'.mp4';
        await rename(partial,join(directory,file));
        return {file,bytes:total};
    }finally{await handle?.close().catch(()=>{});await rm(partial,{force:true}).catch(()=>{});}
}

// Never scroll Telegram Web: inspect only the exact message reached from the
// post's own Open in Web control. A sign-in screen is an unavailable result.
export async function captureTelegramVideoPost(post,{dataDirectory='./data',openTab=null,sleep=null,trace=()=>{}}={}) {
    if(!sourceKey(post.sourceUrl))return {...post,videoRecoveryStatus:'invalid-source'};
    if(!post.hasVideo&&!post.mediaUnavailableReason)return post;
    const openPage=openTab||(await import('../../infrastructure/browser/browserGrabber.js')).openScraperTab;
    if(!openTab)await waitForVideoLaunch(post.sourceUrl);
    let page;
    const pause=async()=>sleep?sleep(25_000):page.waitForTimeout(25_000);
    try{
        page=await openPage({url:post.sourceUrl,source:'Telegram source video',dataDirectory,
            minimumOpenMs:180_000,navigationTimeoutMs:45_000});
        await pause();
        const exactId=post.channel+'/'+post.messageId;
        let captured=null;
        for(const frame of page.frames()){
            const node=frame.locator('[data-post="'+exactId+'"]').first();
            if(await node.count()){
                const result=await node.evaluate(node=>({
                    html:node.outerHTML,
                    text:node.querySelector('.tgme_widget_message_text')?.innerText||'',
                    visibleError:[...node.querySelectorAll('.message_media_not_supported_label')]
                        .filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden')
                        .map(n=>n.innerText.trim()).find(t=>/^(?:Media is too big|This media is not supported in your browser)$/i.test(t))||'',
                }));
                captured={...post,...inspectTelegramPublicPostMedia(result.html)};
                if(result.visibleError)captured.mediaUnavailableReason=/too big/i.test(result.visibleError)?'too-big':'browser-unsupported';
                break;
            }
        }
        captured ||= {...post};
        if(captured.mediaUnavailableReason){
            const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(a=>({text:a.textContent.trim(),href:a.href})));
            const web=links.find(link=>/^(?:open|show)\s+in\s+web$/iu.test(link.text)&&/^https:\/\/web\.telegram\.org\//iu.test(link.href));
            if(web && decodeURIComponent(web.href).toLowerCase().includes(post.channel.toLowerCase())){
                await page.goto(web.href,{waitUntil:'domcontentloaded',timeout:45_000});
                await pause();
                const body=await page.locator('body').innerText();
                if(/log in|sign in|qr code|your phone number|войти|номер телефона/iu.test(body)){
                    captured.videoRecoveryStatus='web-login-required';
                }else{
                    const node=page.locator('[data-mid="'+post.messageId+'"], [data-message-id="'+post.messageId+'"]').first();
                    if(await node.count()){
                        const urls=await node.locator('video').evaluateAll(nodes=>nodes.filter(v=>!v.closest('.emoji,.custom-emoji,.sticker')).map(v=>v.currentSrc||v.src).filter(u=>u.startsWith('https://')));
                        if(urls.length){captured.videoUrls=[...new Set(urls)];captured.hasVideo=true;captured.mediaType=captured.hasPhoto?'mixed':'video';}
                        captured.videoRecoveryStatus=urls.length?'web-captured':'web-video-unavailable';
                    }else captured.videoRecoveryStatus='web-message-not-captured';
                }
            }else captured.videoRecoveryStatus='open-in-web-unavailable';
        }else captured.videoRecoveryStatus='public-post-captured';
        trace('telegram.video.capture',{sourceUrl:post.sourceUrl,status:captured.videoRecoveryStatus,videoCount:captured.videoUrls?.length||0});
        return captured;
    }catch(error){
        trace('telegram.video.capture-error',{sourceUrl:post.sourceUrl,error:String(error.message||error)});
        return {...post,videoRecoveryStatus:'browser-unavailable'};
    }finally{
        // The shared lifetime guard waits out the existing three minutes.
        // It must not block the next parser task or recreate a manually closed tab.
        if(page&&!page.isClosed())void page.close().catch(()=>{});
    }
}

export async function prepareTelegramEventVideo(post,events,{dataDirectory='./data',capture=captureTelegramVideoPost,download=downloadTelegramPostVideo,trace=()=>{}}={}) {
    const approved=(Array.isArray(events)?events:[]).filter(hasEventMetadata);
    if(!approved.length||!sourceKey(post.sourceUrl)||(!post.hasVideo&&!post.mediaUnavailableReason))return null;
    // A video cannot be guessed to belong to one of several distinct events.
    if(new Set(approved.map(eventKey)).size!==1)return null;
    const directory=assetDirectory(dataDirectory),manifest=join(directory,sourceId(post.sourceUrl)+'.json');
    const existing=getTelegramEventVideo({...approved[0],sourceUrl:post.sourceUrl},{dataDirectory});
    if(existing)return existing;
    let media=post;
    if((!post.videoUrls?.length||post.mediaUnavailableReason)&&!post.videoRecoveryStatus)media=await capture(post,{dataDirectory,trace});
    const metadata={sourceUrl:sourceKey(post.sourceUrl),mediaType:media.hasPhoto?'mixed':media.hasVideo?'video':'unknown',
        eventKeys:approved.map(eventKey),status:media.videoRecoveryStatus||'captured',updatedAt:new Date().toISOString()};
    // Only the one actual attachment is safe; duplicate blurred video tags
    // have already been collapsed, and emoji videos never enter this list.
    const urls=[...new Set(media.videoUrls||[])];
    if(urls.length===1){
        try{Object.assign(metadata,await download(urls[0],{directory}));metadata.status='ready';}
        catch(error){
            metadata.status='video-unavailable';trace('telegram.video.download-error',{sourceUrl:post.sourceUrl,error:String(error.message||error)});
            // A signed CDN URL can expire between capture and processing. Refresh
            // once through the source post; never open a bare media URL as a page.
            if(!media.videoRecoveryStatus){
                const fresh=await capture(post,{dataDirectory,trace});
                const freshUrls=[...new Set(fresh.videoUrls||[])];
                if(freshUrls.length===1&&freshUrls[0]!==urls[0]){
                    try{Object.assign(metadata,await download(freshUrls[0],{directory}));metadata.status='ready';}
                    catch(retryError){trace('telegram.video.download-error',{sourceUrl:post.sourceUrl,error:String(retryError.message||retryError)});}
                }
            }
        }
    }else metadata.status=urls.length?'multiple-videos-unbound':metadata.status;
    if(metadata.status==='ready'&&metadata.mediaType==='unknown')metadata.mediaType='video';
    await mkdir(directory,{recursive:true});
    const temp=manifest+'.'+randomUUID()+'.tmp';
    await writeFile(temp,JSON.stringify(metadata),'utf8');await rename(temp,manifest);
    return getTelegramEventVideo({...approved[0],sourceUrl:post.sourceUrl},{dataDirectory});
}
