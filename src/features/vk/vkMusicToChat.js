import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';

const VK_URL=/https?:\/\/(?:m\.)?vk\.(?:ru|com)\/[^\s<>"«»]+/giu;
const normalize=value=>String(value??'').toLowerCase().replace(/ё/gu,'е').replace(/[^a-zа-я0-9]+/giu,' ').trim().replace(/\s+/gu,' ');

export function parseVkAudioAttachment(input){
    try {
        const url=new URL(String(input||'').trim().replace(/[.,;!?]+$/u,''));
        if(!['https:','http:'].includes(url.protocol)||!['vk.com','vk.ru','m.vk.com','m.vk.ru'].includes(url.hostname.toLowerCase()))return null;
        for(const candidate of [decodeURIComponent(url.pathname),decodeURIComponent(url.searchParams.get('z')||'')]){
            const playlist=candidate.match(/(?:^|\/)audio_playlist(-?\d+)_(\d+)(?:_([a-z0-9]+))?(?=$|[\/?#&])/iu);
            if(playlist)return 'audio_playlist'+playlist[1]+'_'+playlist[2]+(playlist[3]?'_'+playlist[3]:'');
            const track=candidate.match(/(?:^|\/)audio(-?\d+)_(\d+)(?:_([a-z0-9]+))?(?=$|[\/?#&])/iu);
            if(track)return 'audio'+track[1]+'_'+track[2]+(track[3]?'_'+track[3]:'');
            const music=candidate.match(/^\/music\/playlist\/(-?\d+)_(\d+)(?=$|[\/?#&])/iu);
            if(music)return 'audio_playlist'+music[1]+'_'+music[2];
        }
    }catch{}
    return null;
}
export function parseVkMusicChatCommand(value){
    const text=String(value??'').trim().replace(/^гигорейв(?:\s*[,.:!]\s*|\s+)/iu,'');
    if(/^(?:список\s+чатов|чаты(?:\s+гигорейва)?|мои\s+чаты|в\s+каких\s+чатах\s+гигорейв)\s*[.!?]*$/iu.test(text))return {kind:'list'};
    const m=text.match(/^отправ(?:ить|ь)\s+в\s+(?:чат|беседу)\s+([\s\S]+)$/iu);
    if(!m)return null;
    const urls=[...m[1].matchAll(VK_URL)].map(x=>x[0]);
    if(urls.length!==1)return {kind:'invalid',reason:'Нужна ровно одна ссылка VK на трек или плейлист.'};
    const attachment=parseVkAudioAttachment(urls[0]);
    if(!attachment)return {kind:'invalid',reason:'Поддерживаются музыкальные треки и плейлисты ВК, не обычные посты.'};
    const title=m[1].replace(urls[0],'').replace(/^[\s:«"']+|[\s:»"'.!?]+$/gu,'').trim();
    if(!title||title.length>130)return {kind:'invalid',reason:'Укажи название или часть названия беседы перед ссылкой.'};
    return {kind:'send',title,attachment,url:urls[0]};
}
function store(catalog,id,props){
    const peerId=Number(id);
    if(!Number.isSafeInteger(peerId)||peerId<2_000_000_000)return;
    const previous=catalog.get(peerId)||{peerId,title:'',verified:false,canWrite:null,endpointKey:'primary',lastActivity:0};
    catalog.set(peerId,{...previous,...props,peerId,lastActivity:Math.max(previous.lastActivity||0,props.lastActivity||0)});
}
export async function discoverVkMusicChats({databasePath='data/bot.sqlite',connections=[]}={}){
    const catalog=new Map();
    let db;
    try{
        db=new DatabaseSync(resolve(databasePath),{readOnly:true});
        for(const x of db.prepare('SELECT peer_id,MAX(created_at) last_at FROM vk_message_archive WHERE peer_id>=2000000000 GROUP BY peer_id').all()){
            store(catalog,x.peer_id,{lastActivity:x.last_at||0});
        }
        for(const x of db.prepare("SELECT peer_id,action_json FROM vk_message_archive WHERE action_type='chat_title_update' ORDER BY created_at DESC").all()){
            if(catalog.get(Number(x.peer_id))?.title)continue;
            let action;try{action=JSON.parse(x.action_json||'{}')}catch{continue}
            if(action?.text)store(catalog,x.peer_id,{title:String(action.text)});
        }
    }finally{db?.close();}
    const known=[...catalog.keys()];
    for(const c of connections){
        const api=c?.client?.api?.messages;
        if(!api)continue;
        for(let i=0;i<known.length;i+=50){
            try{
                const result=await api.getConversationsById({peer_ids:known.slice(i,i+50)});
                for(const item of result?.items||[]){
                    const v=item.conversation||item,id=Number(v.peer?.id||0);
                    if(v.peer?.type&&v.peer.type!=='chat')continue;
                    store(catalog,id,{...(v.chat_settings?.title?{title:String(v.chat_settings.title)}:{}),
                        verified:true,canWrite:v.can_write?.allowed!==false,endpointKey:c.label||'primary'});
                }
            }catch(error){console.warn('[MUSIC CHAT LOOKUP ERROR]',c.label,String(error?.code||error?.message||'').slice(0,90));}
        }
        try{
            const response=await api.getConversations({count:200});
            for(const item of response?.items||[]){
                const v=item.conversation||item,id=Number(v.peer?.id||0);
                if(id<2_000_000_000)continue;
                store(catalog,id,{title:String(v.chat_settings?.title||''),
                    verified:true,canWrite:v.can_write?.allowed!==false,endpointKey:c.label||'primary'});
            }
        }catch(error){console.warn('[MUSIC CHAT LIST ERROR]',c.label,String(error?.code||error?.message||'').slice(0,90));}
    }
    return [...catalog.values()].sort((a,b)=>b.lastActivity-a.lastActivity||a.peerId-b.peerId);
}
export function matchVkMusicChat(chats,title){
    const needle=normalize(title);
    if(!needle)return {status:'none',matches:[]};
    const byId=/^#?2\d{9}$/u.test(title)?chats.filter(x=>String(x.peerId)===title.replace(/^#/u,'')):[];
    const exact=byId.length?byId:chats.filter(x=>x.title&&normalize(x.title)===needle);
    const matches=exact.length?exact:chats.filter(x=>x.title&&normalize(x.title).includes(needle));
    return matches.length===1?{status:'single',chat:matches[0],matches}:{status:matches.length?'ambiguous':'none',matches};
}
const label=c=>(c.title||'Название неизвестно')+' (ID '+c.peerId+')';
export function formatVkMusicChats(chats){
    return ['🎵 Чаты, известные Гигорейву:',
        ...chats.map(c=>(c.verified?'✅ ':'◽ ')+label(c)),
        '','✅ — ВК подтвердил доступ к беседе; ◽ — данные архива, доступ нужно проверить при отправке.',
        'Команда: отправить в чат [название или часть] [ссылка на трек/плейлист]'].join('\n');
}
export async function handleVkMusicChatCommand({text,isOwner=false,isDm=false,send,connections=[],databasePath='data/bot.sqlite'}={}){
    const command=parseVkMusicChatCommand(text);
    if(!command||!isDm)return false;
    if(!isOwner){await send('Отправлять музыку в беседы может только владелец бота.');return true;}
    if(command.kind==='invalid'){await send('❌ '+command.reason+'\nПример: отправить в чат Фестивальник https://vk.ru/audio_playlist-2000608785_25608785');return true;}
    let chats;
    try{chats=await discoverVkMusicChats({databasePath,connections});}
    catch(error){console.error('[MUSIC CHAT CATALOG FAILED]',String(error?.message||'').slice(0,150));await send('Не удалось получить список бесед. Ничего не отправлено.');return true;}
    if(command.kind==='list'){await send(formatVkMusicChats(chats));return true;}
    const result=matchVkMusicChat(chats,command.title);
    if(result.status==='none'){await send('Беседа «'+command.title+'» не найдена. Ничего не отправлено.\n'+formatVkMusicChats(chats));return true;}
    if(result.status==='ambiguous'){await send('Нашлось несколько бесед. Ничего не отправлено. Уточни название или ID:\n'+result.matches.map(label).join('\n'));return true;}
    const chat=result.chat;
    if(chat.canWrite===false){await send('Нет разрешения писать в '+label(chat)+'.');return true;}
    const active=connections.find(x=>x.label===chat.endpointKey)||connections[0];
    if(!active?.client?.api?.messages?.send){await send('VK-подключение для отправки недоступно.');return true;}
    // Attach ONLY the audio/playlist, no 'message' or 'reply_to'.
    try{
        const raw=await active.client.api.messages.send({
            peer_id:chat.peerId,random_id:randomInt(1,2147483647),attachment:command.attachment,
        });
        const id=typeof raw==='number'?raw:Number(raw?.message_id||raw?.response||0);
        await send('✅ Отправил '+command.attachment+' в '+label(chat)+' без текста.'+
            (id>0?' ID: '+id+'.':' ВК вернул ID 0; проверь отображение в беседе.'));
    }catch(error){
        console.error('[MUSIC CHAT SEND ERROR]',chat.peerId,error?.code||'',String(error?.message||'').slice(0,120));
        await send('❌ ВК не подтвердил отправку в '+label(chat)+': '+String(error?.message||'').slice(0,175)+'. Повторно не отправлял.');
    }
    return true;
}
