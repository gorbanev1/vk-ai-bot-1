import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('bare Patrol wake word asks for a request before task memory or archive search', () => {
    const guard = app.indexOf('function isBarePatrolMention(text)');
    const adaptive = app.indexOf('async function handlePatrolAdaptive(');
    const guardBranch = app.indexOf("if(isBarePatrolMention(directText))", adaptive);
    const memory = app.indexOf('const memory=getPatrolTaskMemory()', adaptive);

    assert.ok(guard >= 0, 'bare mention helper is present');
    assert.match(app.slice(guard, guard + 300), /гигорейв\|gigorave/u);
    assert.ok(guardBranch > adaptive, 'bare mention branch is inside adaptive handler');
    assert.ok(memory > guardBranch, 'task memory is initialized only after the guard');
    assert.match(app.slice(guardBranch, memory), /Я здесь. Что нужно сделать?/u);
    assert.match(app.slice(guardBranch, memory), /status:'bare-mention'/u);
});
