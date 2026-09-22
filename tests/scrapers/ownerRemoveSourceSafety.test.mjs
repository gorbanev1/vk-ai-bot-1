import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';
import { parseManualScraperSource, normalizePersistedManualScraperSources } from '../../src/features/scrapers/manualSourceRegistry.js';

for (const [command, pool, input] of [
    ['тусы удалить источник vk:myclub', 'primary', 'vk:myclub'],
    ['удалить источник https://t.me/mychannel', 'primary', 'https://t.me/mychannel'],
    ['парсер удалить источник tg:mychannel', 'primary', 'tg:mychannel'],
    ['тусы быдлячьи удалить источник vk:myclub', 'secondary', 'vk:myclub'],
]) {
    const result = parseScraperStartCommand(command);
    assert.equal(result.matched, true, command);
    assert.equal(result.removeSource, true, command);
    assert.equal(result.partyPool || 'primary', pool, command);
    assert.equal(result.sourceInput, input, command);
    assert.equal(result.addSource, undefined, command);
}
assert.equal(parseScraperStartCommand('тусы удалить песню').matched, false);
assert.equal(parseScraperStartCommand('тусы удалить источник 7').removeSource, true);
assert.equal(parseManualScraperSource('7').ok, false, 'numeric list positions must not be accepted as IDs');

const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const commandHandler = source.slice(
    source.indexOf('async function handleManualScraperCommand('),
    source.indexOf('async function handleManualScraperCommand(') + 3_000,
);
assert.match(commandHandler, /if \(!await requireOwnerDm\(context\)\)/u);
assert.ok(commandHandler.indexOf('if (!await requireOwnerDm(context))') <
    commandHandler.indexOf('if (command.removeSource)'),
    'source removal must be behind the existing owner/private-chat guard');
assert.match(commandHandler, /removeOwnerManualScraperSource\(command\.sourceInput/u);
const start = source.indexOf('function removeOwnerManualScraperSource(');
const end = source.indexOf('\nfunction formatManualScraperStartHelp(', start);
assert.ok(start > 0 && end > start, 'extract the current implementation, not a test reimplementation');
const implementation = source.slice(start, end);

function setup({ active = false, configured = false, secondary = false } = {}) {
    let writeCount = 0;
    const entry = { kind: 'vk-public', source: 'myclub', initialCount: 20 };
    const register = [entry];
    const config = [{ source: 'myclub', initialCount: 20 }];
    const scraper = { screenName: 'myclub' };
    const sandbox = {
        parseManualScraperSource,
        normalizePersistedManualScraperSources,
        PARTY_POOL_PRIMARY: 'primary', PARTY_POOL_SECONDARY: 'secondary',
        ownerManualScraperSourceRegistry: secondary ? [] : register.slice(),
        ownerSecondaryManualScraperSourceRegistry: secondary ? register.slice() : [],
        configuredTelegramSourceConfigurations: [], configuredVkPublicSourcesFromEnvironment: configured ? [entry] : [],
        REQUIRED_VK_PUBLIC_SOURCES: [], secondarySeedConfigurations: [],
        secondaryPartyAutoParserRunning: false,
        vkChatEventScrapers: [],
        listActiveOperations: () => active ? [{ category: 'parser' }] : [],
        telegramHtmlScrapers: [], secondaryTelegramHtmlScrapers: [],
        vkPublicScrapers: secondary ? [] : [scraper], secondaryVkPublicScrapers: secondary ? [scraper] : [],
        telegramSourceConfigurations: [], secondaryTelegramSourceConfigurations: [],
        vkPublicSourceConfigurations: secondary ? [] : config.slice(),
        configuredVkPublicSources: secondary ? [] : config.slice(),
        secondaryVkPublicSourceConfigurations: secondary ? config.slice() : [],
        writeOwnerManualScraperSourceRegistry: (next) => { writeCount += 1; return normalizePersistedManualScraperSources(next); },
        writeOwnerSecondaryManualScraperSourceRegistry: (next) => { writeCount += 1; return normalizePersistedManualScraperSources(next); },
    };
    vm.runInNewContext(implementation, sandbox, { filename: 'botApplication.js:removeOwnerManualScraperSource' });
    return { sandbox, call: (input, pool) => sandbox.removeOwnerManualScraperSource(input, { partyPool: pool }), writes: () => writeCount };
}
{
    const state = setup();
    const result = state.call('vk:myclub', 'primary');
    assert.equal(result.ok, true);
    assert.equal(state.writes(), 1);
    assert.equal(state.sandbox.ownerManualScraperSourceRegistry.length, 0);
    assert.equal(state.sandbox.vkPublicScrapers.length, 0);
    assert.equal(state.sandbox.vkPublicSourceConfigurations.length, 0);
    assert.equal(state.sandbox.configuredVkPublicSources.length, 0);
}
{
    const state = setup({ secondary: true });
    assert.equal(state.call('vk:myclub', 'secondary').ok, true);
    assert.equal(state.sandbox.ownerManualScraperSourceRegistry.length, 0);
    assert.equal(state.sandbox.ownerSecondaryManualScraperSourceRegistry.length, 0);
    assert.equal(state.sandbox.secondaryVkPublicScrapers.length, 0);
}
for (const settings of [{ active: true }, { configured: true }]) {
    const state = setup(settings);
    assert.equal(state.call('vk:myclub', 'primary').ok, false, JSON.stringify(settings));
    assert.equal(state.writes(), 0);
    assert.equal(state.sandbox.ownerManualScraperSourceRegistry.length, 1);
    assert.equal(state.sandbox.vkPublicScrapers.length, 1);
}
{
    const state = setup();
    assert.equal(state.call('vk:other', 'primary').ok, false);
    assert.equal(state.writes(), 0);
}
console.log('ownerRemoveSourceSafety tests: OK');
