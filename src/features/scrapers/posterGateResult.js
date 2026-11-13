// Remove only exhausted media, retaining original URLs in diagnostics. Facts
// follow their source URL when indexes shift; an unavailable image is not a
// negative Vision classification.
export function applyPosterGateResult(item, gate) {
    item.__posterGateVisionAttempted = true;
    item.__dateFreeVisionPhase = Boolean(gate.dateFreePhase);
    item.__posterGateError = String(gate.error || '');
    let facts = String(gate.facts || '');
    const skipped = new Set(gate.skippedImageUrls || []);
    if (skipped.size) item.__skippedImageUrls = [...new Set([...(item.__skippedImageUrls || []), ...skipped])];
    if ((gate.dateFreePhase && Array.isArray(gate.inspectedImageUrls)) || skipped.size) {
        const original = item.imageUrls || [];
        const inspected = Array.isArray(gate.inspectedImageUrls) ? gate.inspectedImageUrls : original;
        const indexes = Array.isArray(gate.inspectedImageIndexes)
            ? gate.inspectedImageIndexes.map(Number) : inspected.map(url => original.indexOf(url) + 1);
        const selected = (gate.dateFreePhase ? inspected : original).filter(url => !skipped.has(url));
        facts = facts.replace(/\[IMAGE\s+(\d+)\]/giu, (_, number) => {
            const url = inspected[indexes.indexOf(Number(number))] || original[Number(number) - 1];
            const index = selected.indexOf(url) + 1;
            return index > 0 ? '[IMAGE ' + index + ']' : '[IMAGE ' + number + ']';
        });
        item.imageUrls = [...selected];
    }
    item.__posterGateFacts = facts;
}

export function allowTextOnlyAfterImageSkip(item, gate, textGate) {
    return Boolean(gate?.attempted && !gate.error && gate.skippedImageUrls?.length &&
        !item.imageUrls?.length && textGate?.visionEligible);
}
