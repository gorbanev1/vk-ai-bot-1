/**
 * Source material shown in the owner's edit flow. This deliberately keeps
 * every merged source and every local source image; public card rendering has
 * stricter poster-selection rules and must not be reused for an audit view.
 */

function cleanText(value) {
    return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function sourceIdentity(source, index) {
    const sourceType = cleanText(source?.sourceType).toLowerCase();
    const sourceItemId = cleanText(source?.sourceItemId || source?.source_item_id).toLowerCase();
    const sourceUrl = cleanText(source?.sourceUrl || source?.sourceOriginalUrl).toLowerCase();
    const sourceName = cleanText(source?.sourceName).toLowerCase();
    return sourceItemId || sourceUrl || [sourceType, sourceName, index].filter(Boolean).join('|');
}

function sourceLabel(source, index) {
    const name = cleanText(source?.sourceName);
    const url = cleanText(source?.sourceUrl || source?.sourceOriginalUrl);
    const type = cleanText(source?.sourceType);
    const identity = cleanText(source?.sourceItemId || source?.source_item_id);
    const label = name || identity || type || `источник ${index + 1}`;
    return url ? `${label}\n🔗 ${url}` : label;
}

function sourceText(source) {
    return cleanText(
        source?.sourceText ||
        source?.rawSource ||
        source?.rawText ||
        source?.source_text ||
        source?.sourceSegment ||
        source?.description,
    );
}

function sourceSegment(source) {
    return cleanText(
        source?.sourceSegment ||
        source?.source_segment ||
        source?.sourceSegmentText ||
        source?.source_segment_text ||
        '',
    );
}

function sourceImagePaths(source) {
    return [
        ...(Array.isArray(source?.sourceImagePaths) ? source.sourceImagePaths : []),
        ...(Array.isArray(source?._sourceImagePaths) ? source._sourceImagePaths : []),
        ...(Array.isArray(source?.imagePaths) ? source.imagePaths : []),
        ...(Array.isArray(source?._imagePaths) ? source._imagePaths : []),
    ].map(cleanText).filter(Boolean);
}

function sourceImageUrls(source) {
    return [
        ...(Array.isArray(source?.imageUrls) ? source.imageUrls : []),
        ...(Array.isArray(source?._imageUrls) ? source._imageUrls : []),
    ].map(cleanText).filter(Boolean);
}

function sourceVisionFacts(source) {
    const values = [
        ...(Array.isArray(source?.posterVisionFacts) ? source.posterVisionFacts : []),
        ...(Array.isArray(source?.imageVisionFacts) ? source.imageVisionFacts : []),
        ...(Array.isArray(source?.visionFacts) ? source.visionFacts : []),
    ];
    return values.filter((value) => value && typeof value === 'object');
}

function joinUniqueText(left, right) {
    const values = [left, right].map(cleanText).filter(Boolean);
    return [...new Set(values)].join('\n\n');
}

function mergeVisionFacts(left, right) {
    const result = [];
    const seen = new Set();
    for (const fact of [...left, ...right]) {
        let key;
        try { key = JSON.stringify(fact); } catch { key = String(fact); }
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(fact);
    }
    return result;
}

export function collectOwnerEventSourceMaterials(event, { maxImages = 1000 } = {}) {
    const sources = [event, ...(Array.isArray(event?.mergedSources) ? event.mergedSources : [])]
        .filter((source) => source && typeof source === 'object');
    const records = [];
    const seenSources = new Map();
    const paths = [];
    const seenPaths = new Set();

    sources.forEach((source, index) => {
        const key = sourceIdentity(source, index);
        const record = {
            key,
            label: sourceLabel(source, index),
            text: sourceText(source),
            segment: sourceSegment(source),
            imagePaths: [],
            imageUrls: [...new Set(sourceImageUrls(source))],
            visionFacts: sourceVisionFacts(source),
        };
        for (const path of sourceImagePaths(source)) {
            if (record.imagePaths.includes(path)) continue;
            record.imagePaths.push(path);
            if (!seenPaths.has(path) && paths.length < maxImages) {
                seenPaths.add(path);
                paths.push(path);
            }
        }
        const existing = seenSources.get(key);
        if (existing) {
            existing.text = joinUniqueText(existing.text, record.text);
            existing.segment = joinUniqueText(existing.segment, record.segment);
            existing.imagePaths = [...new Set([...existing.imagePaths, ...record.imagePaths])];
            existing.imageUrls = [...new Set([...existing.imageUrls, ...record.imageUrls])];
            existing.visionFacts = mergeVisionFacts(existing.visionFacts, record.visionFacts);
            return;
        }
        seenSources.set(key, record);
        records.push(record);
    });

    return { records, imagePaths: paths };
}

export function formatOwnerEventSourceMaterials(materials) {
    const records = Array.isArray(materials?.records) ? materials.records : [];
    if (!records.length) return 'Полный исходный текст в базе не сохранён.';
    return records.map((record, index) => [
        records.length > 1 ? `Источник ${index + 1}: ${record.label}` : `Источник: ${record.label}`,
        'Полный исходный текст:',
        record.text || 'Полный текст этого источника в базе не сохранён.',
        record.segment && record.segment !== record.text
            ? ['Фрагмент, отнесённый к этой карточке:', record.segment].join('\n')
            : '',
        record.imagePaths.length
            ? `Локальных картинок источника: ${record.imagePaths.length}.`
            : 'Локальных картинок источника в базе не найдено.',
        record.visionFacts.length
            ? `Сохранено Vision-фактов: ${record.visionFacts.length}.`
            : 'Vision-факты источника не сохранены.',
        record.imageUrls.length
            ? ['Ссылки на картинки источника:', ...record.imageUrls.map((url) => `🖼 ${url}`)].join('\n')
            : '',
    ].join('\n')).join('\n\n');
}

/** Format one source independently so its text stays adjacent to its media. */
export function formatOwnerEventSourceRecord(record, index = 0, total = 1) {
    const item = record && typeof record === 'object' ? record : {};
    const ordinal = total > 1 ? `Источник ${index + 1}:` : 'Источник:';
    return [
        `${ordinal} ${item.label || `источник ${index + 1}`}`,
        'Полный исходный текст анонса:',
        item.text || 'Полный текст этого источника в базе не сохранён.',
        item.segment && item.segment !== item.text
            ? ['Фрагмент, отнесённый к выбранной карточке:', item.segment].join('\n')
            : '',
        item.imagePaths?.length
            ? `Картинок источника в базе: ${item.imagePaths.length}.`
            : 'Картинок источника в базе не найдено.',
        item.visionFacts?.length
            ? `Сохранено Vision-фактов: ${item.visionFacts.length}.`
            : 'Vision-факты источника не сохранены.',
        item.imageUrls?.length
            ? ['Ссылки на картинки:', ...item.imageUrls.map((url) => `🖼 ${url}`)].join('\n')
            : '',
    ].filter(Boolean).join('\n');
}
