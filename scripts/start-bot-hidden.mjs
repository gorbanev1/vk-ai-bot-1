import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'logs');
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const stdoutPath = resolve(directory, `bot-hidden-${stamp}.out.log`);
const stderrPath = resolve(directory, `bot-hidden-${stamp}.err.log`);
const stdout = openSync(stdoutPath, 'a'), stderr = openSync(stderrPath, 'a');
try {
    const child = spawn(process.execPath, ['--import', './src/infrastructure/database/databasePreflightRegister.js', resolve(root, 'src/index.js')], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdout, stderr],
    });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('spawn', () => {
        console.log(`BOT_PID=${child.pid}\nSTDOUT=${stdoutPath}\nSTDERR=${stderrPath}`);
        child.unref();
    });
} finally {
    closeSync(stdout); closeSync(stderr);
}
