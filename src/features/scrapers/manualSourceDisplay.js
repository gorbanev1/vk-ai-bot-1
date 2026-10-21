const KNOWN_SOURCE_NAMES = new Map([
    ['tg:kurazhcity', 'Город куража'],
    ['tg:kotelnaya_inc', 'Котельная'],
    ['vk:rb_diesel', 'Rock Bar DIESEL & DIESEL Hall'],
    ['vk:overlockbar', 'Overlock Bar'],
    ['vk:artartelchaika', 'Артель «Чайка»'],
    ['vk:divludi', 'Дивные люди. Дивногорье'],
    ['vk:bashnyakult', 'Культурное пространство «Башня»'],
    ['vk:deadway36', 'Бар «Тупик»'],
    ['vk:liverpool_pub_vrn', 'Liverpool Pub'],
    ['vk:idmamaanarchy', 'Паб «Мама Анархия»'],
    ['vk:meetbowling.club', 'Митбоулинг Клуб'],
    ['vk:vavilone_rb', 'Рок-бар «The Last of Vavilone»'],
    ['vk:12bpg', 'Клуб «12» Воронеж'],
]);

export function formatPrimaryVkChatSourceNote() {
    return '• Беседа ВК П🌐ЙТИ на P🐻RTY (создатель: https://vk.ru/nick_more)';
}

export function formatManualSourceDisplayName(source) {
    const id = String(source?.id || '').trim().toLowerCase();
    const known = KNOWN_SOURCE_NAMES.get(id);
    if (known) return known;
    const url = String(source?.url || '').trim();
    return url || String(source?.label || '').replace(/^(?:Telegram @|VK vk\.ru\/)/u, '');
}

export function formatManualSourceListLine(source, { owner = false, enabled = true } = {}) {
    const name = formatManualSourceDisplayName(source);
    const url = getManualSourceUrl(source);
    if (owner && name === url) return `• ${url} — ${enabled ? 1 : 0}`;
    return owner ? `• ${name} — ${url} — ${enabled ? 1 : 0}` : `• ${url}`;
}

export function getManualSourceUrl(source) {
    const raw = String(source?.url || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (url.hostname === 't.me' && url.pathname.startsWith('/s/')) {
            url.pathname = url.pathname.slice(2);
        }
        return url.toString().replace(/\/$/u, '');
    } catch {
        return raw;
    }
}

export function parseManualSourceToggleLine(line, parseSource) {
    const match = String(line || '').trim().match(/^(?:[•*.-]\s*)?.*?https?:\/\/\S+.*?\s+—\s+([01])\s*$/iu);
    if (!match) return null;
    const url = String(line).match(/https?:\/\/\S+/iu)?.[0]?.replace(/[),.;]+$/u, '');
    if (!url) return null;
    const parsed = parseSource(url);
    if (!parsed?.ok) return null;
    return { id: `${parsed.source.kind === 'telegram' ? 'tg' : 'vk'}:${parsed.source.source}`.toLowerCase(), enabled: match[1] === '1' };
}
