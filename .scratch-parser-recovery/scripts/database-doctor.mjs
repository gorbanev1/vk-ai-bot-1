import { runDatabasePreflight } from '../src/infrastructure/database/databasePreflight.js';

const result = runDatabasePreflight();
console.log(JSON.stringify(result, null, 2));
