import 'dotenv/config';
import { runNoPosterForceReparseV18910 } from '../src/app/botApplication.js';

const result = await runNoPosterForceReparseV18910();
console.log(JSON.stringify(result, null, 2));
