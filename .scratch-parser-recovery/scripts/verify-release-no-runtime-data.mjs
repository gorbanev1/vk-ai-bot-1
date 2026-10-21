import { readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
const root = resolve(process.argv[2] || process.cwd());
const forbiddenNames = new Set(['bot.sqlite','bot.sqlite-wal','bot.sqlite-shm','live-message-journal.jsonl','vk-message-archive-journal.jsonl']);
const hits=[];
function walk(dir){ for(const name of readdirSync(dir)){ const p=join(dir,name); const rel=relative(root,p).replaceAll('\\','/'); const st=statSync(p); if(st.isDirectory()){ if(rel==='node_modules'||rel==='.git') continue; walk(p); } else if(forbiddenNames.has(name) || /(^|\/)data\/healthy-backups\//u.test(rel) || /(^|\/)data\/corruption-backups\//u.test(rel)) hits.push(rel); }}
walk(root);
if(hits.length){ console.error('Runtime DB/state files present in release tree:\n'+hits.map(x=>' - '+x).join('\n')); process.exit(1); }
console.log('release runtime-data guard: OK');
