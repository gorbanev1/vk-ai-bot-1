import { getEventVenuePublisherRecords } from '../events/eventVenueCatalog.js';
import { formatManualSourceDisplayName, getManualSourceUrl } from './manualSourceDisplay.js';

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const cleanName = value => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const recordLinks = record => [record.vkUrl, record.telegramUrl, record.websiteUrl].filter(Boolean);

function linkIdentity(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^www\./u, '').replace(/^vk\.com$/u, 'vk.ru');
        const path = url.pathname.replace(/^\/s\//u, '/').replace(/\/$/u, '');
        return host + (host === 'vk.ru' || host === 't.me' ? path.toLowerCase() : path);
    } catch { return String(value || '').trim(); }
}

function linkLabel(url) {
    if (/^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//iu.test(url)) return 'VK';
    if (/^https?:\/\/t\.me\//iu.test(url)) return 'Telegram';
    return 'Сайт';
}

/** One canonical venue name with all its known publisher links. Parser activity
 * and reference links are separate: only configured rows receive owner toggles. */
export function groupPublicSources(sources, records = getEventVenuePublisherRecords()) {
    const groups = new Map();
    for (const source of Array.isArray(sources) ? sources : []) {
        const sourceUrl = getManualSourceUrl(source);
        const key = linkIdentity(sourceUrl);
        const matches = records.filter(record => recordLinks(record).some(url => linkIdentity(url) === key));
        const known = formatManualSourceDisplayName(source);
        const fallback = known && known !== sourceUrl && !/^https?:/iu.test(known)
            ? known : source.name || String(source.label || '').replace(/^(?:Telegram @|VK vk\.(?:ru|com)\/)/u, '') ||
                String(source.id || '').replace(/^[^:]+:/u, '') || sourceUrl;
        const name = cleanName(matches.length
            ? [...new Set(matches.map(record => record.name))].sort(collator.compare).join(' / ')
            : fallback);
        if (!name) continue;
        const groupKey = name.toLocaleLowerCase('ru');
        if (!groups.has(groupKey)) groups.set(groupKey, { name, links: new Map() });
        const group = groups.get(groupKey);
        for (const url of matches.flatMap(recordLinks)) {
            const id = linkIdentity(url);
            if (!group.links.has(id)) group.links.set(id, {url, label:linkLabel(url)});
        }
        if (sourceUrl) {
            const prior = group.links.get(key) || {url:sourceUrl, label:linkLabel(sourceUrl)};
            group.links.set(key, {...prior, configured:true, enabled:source.enabled !== false});
        }
    }
    const order = {VK:0, Telegram:1, 'Сайт':2};
    return [...groups.values()].sort((a,b) => collator.compare(a.name,b.name)).map(group => ({
        name:group.name,
        links:[...group.links.values()].sort((a,b) => order[a.label]-order[b.label] || collator.compare(a.url,b.url)),
    }));
}

export function formatGroupedPublicSources(sources, {owner = false} = {}) {
    return groupPublicSources(sources).map(group => [
        '• ' + group.name,
        ...group.links.map(link => link.label + ': ' + link.url +
            (owner && link.configured ? ' — ' + (link.enabled ? '1' : '0') : '')),
    ].join('\n')).join('\n\n');
}
