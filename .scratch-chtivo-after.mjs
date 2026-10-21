import { DatabaseSync } from 'node:sqlite';
import { MAIN_DATABASE_PATH } from './src/infrastructure/database/index.js';
const db=new DatabaseSync(MAIN_DATABASE_PATH);
console.log(JSON.stringify(db.prepare('SELECT id,catalog_no,title,author,path,enabled FROM chtivo_books ORDER BY catalog_no').all(),null,2));
