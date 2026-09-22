function normalizePath(value) {
    return String(value ?? '')
        .trim()
        .replace(/\\+/gu, '/')
        .replace(/^\.\//u, '')
        .toLowerCase();
}

function normalizeTitle(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function rowMatchesEvent(event, row) {
    const eventId = Number(event?.id || 0);
    const rowId = Number(row?.id || 0);
    const eventType = String(event?.sourceType || '').trim();
    const rowType = String(row?.sourceType || '').trim();
    if (eventId > 0 && rowId === eventId && (!eventType || !rowType || eventType === rowType)) {
        return true;
    }

    const eventDate = String(event?.eventDate || '').trim();
    const rowDate = String(row?.eventDate || '').trim();
    if (!eventDate || eventDate !== rowDate) return false;

    const eventTitle = normalizeTitle(event?.title || event?.participants || '');
    const rowTitle = normalizeTitle(row?.title || row?.participants || '');
    return Boolean(eventTitle && rowTitle && eventTitle === rowTitle);
}

/**
 * Return stored image paths that are demonstrably assigned only to this one
 * event among sibling rows originating from the same canonical source post.
 * This lets a repaired multi-event/digest post show its per-event poster while
 * still rejecting the legacy failure mode where one JPEG was copied to every
 * child event.
 */
export function getExclusiveStoredPosterPaths(event, sourceRows = []) {
    const rows = Array.isArray(sourceRows) ? sourceRows.filter(Boolean) : [];
    if (rows.length < 2) return [];

    let current = rows.find((row) => rowMatchesEvent(event, row)) || null;
    if (!current) {
        const eventDate = String(event?.eventDate || '').trim();
        const sameDate = eventDate
            ? rows.filter((row) => String(row?.eventDate || '').trim() === eventDate)
            : [];
        if (sameDate.length === 1) current = sameDate[0];
    }
    if (!current) return [];

    const currentPaths = [...new Set(
        (Array.isArray(current?.imagePaths) ? current.imagePaths : [])
            .map(normalizePath)
            .filter(Boolean),
    )];
    if (!currentPaths.length) return [];

    const siblingPaths = new Set();
    for (const row of rows) {
        if (row === current) continue;
        for (const path of Array.isArray(row?.imagePaths) ? row.imagePaths : []) {
            const normalized = normalizePath(path);
            if (normalized) siblingPaths.add(normalized);
        }
    }

    return currentPaths.filter((path) => !siblingPaths.has(path));
}

export function filterToExclusiveStoredPosterPaths(event, sourceRows, candidatePaths = []) {
    const exclusive = new Set(getExclusiveStoredPosterPaths(event, sourceRows));
    if (!exclusive.size) return [];
    return (Array.isArray(candidatePaths) ? candidatePaths : []).filter((path) => (
        exclusive.has(normalizePath(path))
    ));
}
