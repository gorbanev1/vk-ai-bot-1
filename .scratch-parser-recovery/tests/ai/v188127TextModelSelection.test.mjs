import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTextAttachmentModelChoice as choose } from '../../src/features/audit/textAttachmentModelSelection.js';

const keyCases = [
    ['Проведи ревью прикреплённого TXT', 'default', 'medium'],
    ['', 'default', 'medium'],
    ['Гигорейв mini low, проверь TXT', 'default', 'low'],
    ['Гигорейв gpt54 high проверь', 'gpt54', 'high'],
    ['Гигорейв GPT-5.4 high проверь', 'gpt54', 'high'],
    ['Гигорейв gpt55 high проверь', 'gpt55', 'high'],
    ['Гигорейв GPT-5.5 high проверь', 'gpt55', 'high'],
    ['Гигорейв luna high проверь', 'pro', 'high'],
    ['Гигорейв terra high проверь', 'pro2', 'high'],
    ['Гигорейв pro2 max проверь', 'pro2', 'max'],
    ['Гигорейв sol xhigh проверь', 'pro3', 'xhigh'],
    ['Гигорейв astra max проверь', 'astra', 'max'],
    ['Гигорейв max проверь', 'astra', 'max'],
    ['Гигорейв gpt-6-astra medium проверь', 'astra', 'medium'],
];
for (const [caption, mode, effort] of keyCases) test(`TXT key: ${caption || '(empty)'}`, () => {
    const selected = choose(caption);
    assert.equal(selected.mode, mode);
    assert.equal(selected.reasoningEffort, effort);
    assert.doesNotMatch(selected.prompt, /^(?:гигорейв|astra|terra|sol|luna)\s+(?:max|high|xhigh|low|medium)/iu);
});
for (const effort of ['none', 'default', 'low', 'medium', 'high', 'xhigh', 'max']) {
    test(`Astra TXT can explicitly request ${effort} without switching the model`, () => {
        const caption = `Гигорейв astra ${['none', 'default'].includes(effort) ? `reasoning ${effort}` : effort} проверь TXT`;
        const selected = choose(caption);
        assert.equal(selected.mode, 'astra');
        assert.equal(selected.reasoningEffort, effort);
        assert.match(selected.prompt, /проверь TXT/u);
    });
}
test('TXT route uses existing GPT_MODEL_* resolver, not a Terra-only or high-only branch', () => {
    const code = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = code.indexOf('async function maybeHandleAstraTextAttachmentIncoming(');
    const end = code.indexOf('async function maybeHandleProjectArchiveAuditIncoming(', start);
    const route = code.slice(start,end);
    assert.match(route, /const selection = resolveTextAttachmentModelChoice\(requestText\)/u);
    assert.match(route, /const model = await resolveGptModel\(selection[.]mode\)/u);
    assert.match(route, /model, reasoningEffort: selection[.]reasoningEffort,/u);
    assert.match(route, /task: selection[.]prompt,/u);
    assert.doesNotMatch(route, /PROJECT_TEXT_ATTACHMENT_MODEL|\['gpt-5\.5', 'gpt-5\.6-terra'\]|reasoningEffort: 'high'/u);
    assert.match(code.slice(code.indexOf('async function executeTelegramTextJob('), end), /createTelegramDocumentAttachment\(result\)/u);
    assert.match(code, /default: 'gpt-5\.4-mini'/u);
});
