import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const config = readFileSync(
    new URL('../../docs/CONFIGURATION.md', import.meta.url),
    'utf8',
);

assert.match(source, /VK_EVENT_TOKEN/u);
assert.match(source, /VK_EVENT_GROUP_ID/u);
assert.match(source, /const\s+primaryVk\s*=\s*new\s+VK/u);
assert.match(source, /const\s+eventVk\s*=\s*vkEventToken/u);
assert.match(source, /const\s+vkConnections\s*=\s*\[/u);
assert.match(source, /for\s*\(const connection of vkConnections\)/u);
assert.match(source, /vkExecutionStorage\.run\(connection/u);
assert.match(source, /connection\.client\.updates\.start\(\)/u);
assert.match(source, /events-v\d+-[a-z0-9-]+/u);
assert.match(config, /VK_EVENT_TOKEN=/u);
assert.match(config, /VK_EVENT_GROUP_ID=/u);
assert.match(config, /240709021/u);

console.log('dual VK communities tests: OK');
