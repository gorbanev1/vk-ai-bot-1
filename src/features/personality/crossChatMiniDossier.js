const cacheInitialized=new WeakSet();
const TOPICS=[
 ['музыка и концерты',/(?:музык|концерт|гитар|рок|панк|метал|джаз|дидже|dj\b|группа|песн|трек)/iu],
 ['городские встречи и тусовки',/(?:встрет|встреча|клуб|тусов|тусы|собира|бар\b|кафе|прогул|вечерин)/iu],
 ['игры и технологии',/(?:игр[ауые]|играю|гейм|компьют|телефон|приложен|софт|ноутбук|код|программ)/iu],
 ['поездки и природа',/(?:поездк|путешеств|поход|пикник|лес\b|природ|рыбалк|озер|кемпинг)/iu],
 ['кино и книги',/(?:фильм|кино|сериал|книг|читат|театр|литератур)/iu],
 ['работа и бытовые планы',/(?:работ|смена|офис|выходн|планир|дома|дела|завтра)/iu],
];
const IGNORE_BOT_OR_ROUTING=/^(?:гигорейв|бот|huinglish|хуинглиш)\s*(?:помощь|статус|тусы|досье)?\s*[!?.]*$/iu;
export function buildVkCrossChatMiniDossier(rows=[]) {
 const own=(Array.isArray(rows)?rows:[]).filter(r=>Number(r.sender_id)>0 && String(r.text||'').trim().length>=6 && !IGNORE_BOT_OR_ROUTING.test(String(r.text||'').trim()));
 if(own.length<5)return '';
 const themes=TOPICS.map(([label,re])=>({label,count:own.filter(r=>re.test(String(r.text||''))).length}))
  .filter(x=>x.count>=2).sort((a,b)=>b.count-a.count).slice(0,4);
 const lines=[];
 if(themes.length)lines.push('Повторяющиеся темы собственных реплик: '+themes.map(t=>t.label).join(', ')+'.');
 const humour=own.filter(r=>/(?:ахах|хаха|лол\b|прикол|шут|😁|😂|🤣)/iu.test(String(r.text||''))).length;
 if(humour>=3)lines.push('В сообщениях регулярно встречаются шутки и смех.');
 if(!lines.length)return '';
 lines.push('Это неполное наблюдение по авторским сообщениям в общих VK-беседах, а не психологическая характеристика. Не сообщай названия других чатов, цитаты из них, конфиденциальные подробности и неподтверждённые выводы.');
 return lines.join(' ').slice(0,440);
}
function ensureStore(database){
 if(cacheInitialized.has(database))return;
 database.exec([
  'CREATE TABLE IF NOT EXISTS vk_cross_chat_mini_dossiers (user_id INTEGER PRIMARY KEY, profile_text TEXT NOT NULL DEFAULT \'\', message_count INTEGER NOT NULL DEFAULT 0, source_chat_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);',
  'CREATE INDEX IF NOT EXISTS vk_archive_user_mini_idx ON vk_message_archive(sender_id,created_at DESC) WHERE peer_id>=2000000000 AND peer_id<3000000000 AND is_outbox=0;',
 ].join('\n'));
 cacheInitialized.add(database);
}
export function loadVkCrossChatMiniDossier(database,userId,{nowSeconds=Math.floor(Date.now()/1000),ttlSeconds=3600}={}){
 const user=Number(userId);if(!Number.isSafeInteger(user)||user<=0)return '';
 ensureStore(database);
 const cached=database.prepare('SELECT * FROM vk_cross_chat_mini_dossiers WHERE user_id=?').get(user);
 if(cached && nowSeconds-Number(cached.updated_at||0)<ttlSeconds)return String(cached.profile_text||'');
 // No VK direct messages or Telegram data. Source IDs matter for migrations,
 // but do not get exported in the prompt or displayed to users.
 const rows=database.prepare([
  'SELECT sender_id,text,peer_id,created_at FROM vk_message_archive',
  'WHERE sender_id=? AND peer_id>=2000000000 AND peer_id<3000000000',
  "AND is_outbox=0 AND (action_type IS NULL OR action_type='')",
  'AND length(trim(text))>=6 ORDER BY created_at DESC LIMIT 220',
 ].join(' ')).all(user);
 const profile=buildVkCrossChatMiniDossier(rows);
 const chats=new Set(rows.map(r=>Number(r.peer_id))).size;
 database.prepare([
  'INSERT INTO vk_cross_chat_mini_dossiers(user_id,profile_text,message_count,source_chat_count,updated_at)',
  'VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET',
  'profile_text=excluded.profile_text,message_count=excluded.message_count,',
  'source_chat_count=excluded.source_chat_count,updated_at=excluded.updated_at',
 ].join(' ')).run(user,profile,rows.length,chats,nowSeconds);
 return profile;
}
