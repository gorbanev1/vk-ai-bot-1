import { parseManualScraperSource } from './manualSourceRegistry.js';

// Owner-only batch registry command. It parses locally; no VK/TG/API calls.
const SOURCE_TOKEN = /^(?:https?:\/\/|(?:www\.)?(?:t\.me|telegram\.me|vk\.com|vk\.ru)\/|(?:tg|telegram|vk):|@[a-z0-9_])/iu;

export function parseBulkSourceAddCommand(input) {
    const raw = String(input ?? '')
        .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
        .trim()
        .replace(/^[/\\]+/u, '')
        .replace(/^(?:гигорейв|gigorave)(?:[,:]\s*|\s+)/iu, '');
    const match = raw.match(/^(основные|второстепенные)(?:\s+источники)?\s+добавить(?:\s+источник)?(?=\s|:|$)\s*:?\s*([\s\S]*)$/iu);
    if (!match) return null;

    const seen = new Set();
    const sources = [];
    const invalid = [];
    let duplicates = 0;

    // No arbitrary link-count cap: the messaging platform controls message size.
    for (const part of String(match[2] || '').split(/[\s,;]+/u)) {
        const token = part
            .replace(/^[•*("'«\[{]+/u, '')
            .replace(/[)"'»\]}>.!?]+$/u, '')
            .trim();
        if (!token || !SOURCE_TOKEN.test(token)) continue;

        const parsed = parseManualScraperSource(token);
        if (!parsed.ok) {
            invalid.push({ token, error: parsed.error });
            continue;
        }
        if (seen.has(parsed.source.id)) {
            duplicates += 1;
            continue;
        }
        seen.add(parsed.source.id);
        sources.push(parsed.source);
    }

    return {
        partyPool: match[1].toLowerCase() === 'основные' ? 'primary' : 'secondary',
        sources,
        invalid,
        duplicates,
    };
}
