import { DatabaseSync } from 'node:sqlite';
import { MAIN_DATABASE_PATH } from './src/infrastructure/database/index.js';
const db = new DatabaseSync(MAIN_DATABASE_PATH);
console.log(db.prepare('SELECT id,catalog_no,title,author,path,version,enabled,created_at FROM chtivo_books ORDER BY catalog_no').all());
