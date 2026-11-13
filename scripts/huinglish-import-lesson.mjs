#!/usr/bin/env node
/**
 * Publish a fully validated lesson to SQLite, atomically.
 * node scripts/huinglish-import-lesson.mjs data/english-huinglish/generated/lesson2/manifest.json --title "Lesson title"
 * No messages are sent by this importer. Subscribers' normal scheduler detects published lessons.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveMainDatabasePath, assertTestDatabaseIsolation } from '../src/infrastructure/database/runtimePaths.js';
import {ensureHuinglishSchema,validateHuinglishParts} from '../src/features/english/huinglishStore.js';
const argv=process.argv.slice(2),file=argv[0];
const opt=(name,defaultValue)=>{const index=argv.indexOf('--'+name);return index===-1?defaultValue:argv[index+1];};
if(!file||argv.includes('--help')||!opt('title','')) {
 console.error('Usage: node scripts/huinglish-import-lesson.mjs manifest.json --title "Урок №2 — ..." [--db PATH]');
 process.exit(2);
}
const manifestPath=resolve(file),m=JSON.parse(readFileSync(manifestPath,'utf8'));
const dbPath=resolve(opt('db',resolveMainDatabasePath()));
assertTestDatabaseIsolation({databasePath:dbPath});
if(!Number.isInteger(m.lesson)||m.lesson<1||!Array.isArray(m.parts)||m.parts.length<1||m.parts.length>25||m.numberOfMessages!==m.parts.length)throw Error('Invalid lesson manifest');
if(!Number.isInteger(m.limit)||m.limit<256||m.limit>4096||!Number.isInteger(m.reserve)||m.reserve<0||m.reserve>=m.limit)throw Error('Invalid message budget');
const contents=m.parts.map((p,i)=>{
 if(p.index!==i+1||!/^[\w.-]+\.txt$/u.test(p.filename))throw Error('Nonsequential parts or unsafe filename: '+p.filename);
 const body=readFileSync(join(dirname(manifestPath),p.filename),'utf8').replace(/\r\n/g,'\n');
 const crlf=body.length+(body.match(/\n/g)||[]).length;
 if(body.length>4096||crlf>4096||crlf>m.limit-m.reserve)throw Error('VK message too long part '+(i+1));
 if(createHash('sha256').update(body).digest('hex')!==p.sha256)throw Error('SHA256 mismatch part '+(i+1));
 if(body.length!==p.utf16 || crlf!==p.utf16WithCRLF)throw Error('Count mismatch part '+(i+1));
 return body;
});
validateHuinglishParts(contents);
const db=new DatabaseSync(dbPath);
try {
 db.exec('PRAGMA busy_timeout=5000;');
 ensureHuinglishSchema(db);
 db.exec('BEGIN IMMEDIATE;');
 try{
  if(db.prepare('SELECT id FROM huinglish_lessons WHERE id=?').get(m.lesson))throw Error('Lesson '+m.lesson+' already exists: refusing overwrite');
  const intro=db.prepare('SELECT intro_text,intro_image FROM huinglish_lessons WHERE id=1').get()||{intro_text:'',intro_image:'intro_vk.jpg'};
  db.prepare('INSERT INTO huinglish_lessons(id,title,intro_text,intro_image,created_at,published) VALUES(?,?,?,?,?,0)').run(m.lesson,opt('title','Урок '+m.lesson),intro.intro_text,intro.intro_image,Date.now());
  const ins=db.prepare('INSERT INTO huinglish_parts(lesson_id,number,body) VALUES(?,?,?)');
  for(let i=0;i<contents.length;i++)ins.run(m.lesson,i+1,contents[i]);
  db.prepare('UPDATE huinglish_lessons SET published=1 WHERE id=?').run(m.lesson);
  db.exec('COMMIT;');
 }catch(error){db.exec('ROLLBACK;');throw error;}
 console.log('PUBLISHED lesson='+m.lesson,'parts='+contents.length,'db='+dbPath);
} finally {db.close();}
