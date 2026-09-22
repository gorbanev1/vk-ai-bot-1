export const REQUIRED_VK_PUBLIC_SOURCES = Object.freeze([
    Object.freeze({ source: 'deadway36', initialCount: 20 }),
    Object.freeze({ source: 'liverpool_pub_vrn', initialCount: 20 }),
    Object.freeze({ source: 'idmamaanarchy', initialCount: 20 }),
    Object.freeze({ source: 'meetbowling.club', initialCount: 20 }),
    Object.freeze({ source: 'vavilone_rb', initialCount: 20 }),
]);

export function mergeVkPublicSourceConfigurations(
    configuredSources = [],
    requiredSources = REQUIRED_VK_PUBLIC_SOURCES,
) {
    const merged = new Map();

    for (const configuration of [...configuredSources, ...requiredSources]) {
        const source = String(configuration?.source ?? '').trim();
        if (!source) continue;

        const key = source.toLowerCase();
        const previous = merged.get(key);
        const initialCount = Math.min(
            20,
            Math.max(
                Number(previous?.initialCount ?? 0),
                Number(configuration?.initialCount ?? 0),
            ),
        );

        merged.set(key, {
            source: previous?.source || source,
            initialCount,
        });
    }

    return [...merged.values()];
}
