import assert from 'node:assert/strict';
import {
    getAstrologyHelpLines,
    isPrashnaAllowedForPlatform,
    resolveHelpContextProfile,
} from '../../src/features/routing/helpContextProfile.js';

const base = { vkImageLimit: 5, telegramImageLimit: 2 };

const vkChat = resolveHelpContextProfile({ ...base, platform: 'vk', isPrivate: false });
const telegramChat = resolveHelpContextProfile({ ...base, platform: 'telegram', isPrivate: false });
const vkDm = resolveHelpContextProfile({ ...base, platform: 'vk', isPrivate: true });
const telegramDm = resolveHelpContextProfile({ ...base, platform: 'telegram', isPrivate: true });
const ownerTelegram = resolveHelpContextProfile({ ...base, platform: 'telegram', isPrivate: true, isOwner: true });
const ownerVk = resolveHelpContextProfile({ ...base, platform: 'vk', isPrivate: true, isOwner: true });

assert.equal(vkChat.id, 'vk-chat');
assert.equal(telegramChat.id, 'telegram-chat');
assert.equal(vkDm.id, 'vk-dm');
assert.equal(telegramDm.id, 'telegram-dm');
assert.equal(ownerTelegram.id, 'owner');
assert.equal(ownerVk.id, 'owner');
assert.equal(ownerTelegram.imageLimit, null);
assert.equal(ownerVk.imageLimit, null);
assert.match(ownerTelegram.title, /TELEGRAM ЛС/u);
assert.match(ownerVk.title, /VK ЛС/u);
assert.match(vkDm.imageLimitText, /5 изображений/u);
assert.match(vkChat.imageLimitText, /5 изображений/u);
assert.match(telegramDm.imageLimitText, /2 изображения/u);
assert.match(telegramDm.imageLimitText, /общий счётчик/u);
assert.match(telegramChat.imageLimitText, /2 изображения/u);
assert.match(telegramChat.imageLimitText, /тот же счётчик/u);

assert.equal(vkChat.prashnaEnabled, true);
assert.equal(vkDm.prashnaEnabled, true);
assert.equal(telegramChat.prashnaEnabled, false);
assert.equal(telegramDm.prashnaEnabled, false);
assert.equal(ownerTelegram.prashnaEnabled, false);
assert.equal(ownerVk.prashnaEnabled, true);
assert.equal(isPrashnaAllowedForPlatform('telegram'), false);
assert.equal(isPrashnaAllowedForPlatform('vk'), true);


const telegramDmAstrology = getAstrologyHelpLines({ platform: 'telegram', isPrivate: true }).join('\n');
const telegramChatAstrology = getAstrologyHelpLines({ platform: 'telegram', isPrivate: false }).join('\n');
const vkDmAstrology = getAstrologyHelpLines({ platform: 'vk', isPrivate: true }).join('\n');
const vkChatAstrology = getAstrologyHelpLines({ platform: 'vk', isPrivate: false }).join('\n');
assert.doesNotMatch(telegramDmAstrology, /прашн|prashna|horary|хорар/iu);
assert.doesNotMatch(telegramChatAstrology, /прашн|prashna|horary|хорар/iu);
assert.match(telegramDmAstrology, /натал/iu);
assert.match(telegramChatAstrology, /натал/iu);
assert.match(vkDmAstrology, /прашн/iu);
assert.match(vkChatAstrology, /прашн/iu);

console.log('help context profile tests: OK');
