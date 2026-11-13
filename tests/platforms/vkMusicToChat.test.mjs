import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseVkAudioAttachment, parseVkMusicChatCommand, matchVkMusicChat,
    discoverVkMusicChats, handleVkMusicChatCommand } from '../../src/features/vk/vkMusicToChat.js';

const album='https://vk.ru/audio_playlist-2000608785_25608785';
const song='https://vk.com/audio-123_456';
function setup(t){
    const dir=mkdtempSync(join(tmpdir(),'vk-music-send-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const dbPath=join(dir,'bot.sqlite'),db=new DatabaseSync(dbPath);
    db.exec('CREATE TABLE vk_message_archive(peer_id INTEGER,created_at INTEGER,action_type TEXT,action_json TEXT)');
    db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?)').run(2000000006,500,'chat_title_update',JSON.stringify({text:'Гигорейв чат (Добрый чат)'}));
    db.prepare('INSERT INTO vk_message_archive VALUES(?,?,?,?)').run(2000000010,501,'',null);
    db.close();
    const sends=[],acks=[];
    const connections=[{label:'primary',client:{api:{messages:{
        getConversationsById:async()=>({items:[{peer:{id:2000000010,type:'chat'},chat_settings:{title:'Фестивальник'},can_write:{allowed:true}}]}),
        getConversations:async()=>({items:[]}),
        send:async args=>{sends.push(args);return 0;},
    }}}}];
    return {dbPath,connections,sends,acks,send:async msg=>acks.push(msg)};
}
test('VK music URLs turn into native attachments',()=>{
    assert.equal(parseVkAudioAttachment(album),'audio_playlist-2000608785_25608785');
    assert.equal(parseVkAudioAttachment(song),'audio-123_456');
    assert.equal(parseVkAudioAttachment('https://vk.ru/music/playlist/-123_456'),'audio_playlist-123_456');
    assert.equal(parseVkAudioAttachment('https://example.com/audio-123_456'),null);
    assert.equal(parseVkAudioAttachment('https://vk.ru/wall-123_456'),null);
});
test('owner DM command accepts title and partial title, optional bot prefix',()=>{
    assert.deepEqual(parseVkMusicChatCommand('отправить в чат Фестивальник '+album),
        {kind:'send',title:'Фестивальник',attachment:'audio_playlist-2000608785_25608785',url:album});
    assert.equal(parseVkMusicChatCommand('Гигорейв, отправить в чат Фести '+song).title,'Фести');
    assert.equal(parseVkMusicChatCommand('список чатов').kind,'list');
    assert.equal(parseVkMusicChatCommand('чаты').kind,'list');
    assert.equal(parseVkMusicChatCommand('отправить в чат Фестивальник https://example.com/audio-123_456').kind,'invalid');
    assert.equal(parseVkMusicChatCommand('привет'),null);
});
test('available chats combine local archive titles and live API; ambiguous matching is safe',async t=>{
    const e=setup(t);
    const chats=await discoverVkMusicChats({databasePath:e.dbPath,connections:e.connections});
    assert.equal(chats.length,2);
    assert.equal(chats.find(x=>x.peerId===2000000010).title,'Фестивальник');
    assert.equal(chats.find(x=>x.peerId===2000000006).title,'Гигорейв чат (Добрый чат)');
    assert.equal(matchVkMusicChat(chats,'Добрый').chat.peerId,2000000006);
    assert.equal(matchVkMusicChat(chats,'фести').chat.peerId,2000000010);
    assert.equal(matchVkMusicChat(chats,'2000000006').chat.peerId,2000000006);
    assert.equal(matchVkMusicChat([...chats,{peerId:2000000022,title:'Фестивальный'}],'фести').status,'ambiguous');
});
test('only owner in DM sends an attachment without any text',async t=>{
    const e=setup(t);
    const opts={text:'отправить в чат Добрый '+album,send:e.send,
        connections:e.connections,databasePath:e.dbPath};
    assert.equal(await handleVkMusicChatCommand({...opts,isOwner:true,isDm:false}),false);
    assert.equal(e.sends.length,0);
    assert.equal(await handleVkMusicChatCommand({...opts,isOwner:false,isDm:true}),true);
    assert.equal(e.sends.length,0);
    assert.equal(await handleVkMusicChatCommand({...opts,isOwner:true,isDm:true}),true);
    assert.equal(e.sends.length,1);
    assert.equal(e.sends[0].peer_id,2000000006);
    assert.equal(e.sends[0].attachment,'audio_playlist-2000608785_25608785');
    assert.ok(!('message' in e.sends[0]));
    assert.ok(!('reply_to' in e.sends[0]));
    await handleVkMusicChatCommand({...opts,text:'отправить в чат Фести '+song,isOwner:true,isDm:true});
    assert.equal(e.sends.length,2);
    assert.equal(e.sends[1].attachment,'audio-123_456');
    assert.equal(e.sends[1].peer_id,2000000010);
    await handleVkMusicChatCommand({...opts,text:'список чатов',isOwner:true,isDm:true});
    assert.ok(e.acks.at(-1).includes('Фестивальник'));
    assert.equal(e.sends.length,2);
});
