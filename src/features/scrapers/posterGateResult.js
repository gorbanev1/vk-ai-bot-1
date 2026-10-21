// Phase-two exclusions are also applied downstream: removed images must not
// reappear during card extraction. Remap facts by URL, never by shifted offsets.
export function applyPosterGateResult(item, gate) {
    item.__posterGateVisionAttempted = true;
    item.__dateFreeVisionPhase = Boolean(gate.dateFreePhase);
    item.__posterGateError = String(gate.error || '');
    let facts = String(gate.facts || '');
    if (gate.dateFreePhase && Array.isArray(gate.inspectedImageUrls)) {
        const original = item.imageUrls || [];
        const selected = gate.inspectedImageUrls;
        const inspectedIndexes = Array.isArray(gate.inspectedImageIndexes)
            ? gate.inspectedImageIndexes.map((value) => Number(value))
            : selected.map((url) => original.indexOf(url) + 1);
        facts = facts.replace(/\[IMAGE\s+(\d+)\]/giu, (_, number) => {
            const originalIndex = Number(number);
            const index = inspectedIndexes.indexOf(originalIndex) + 1;
            return index > 0 ? `[IMAGE ${index}]` : `[IMAGE ${originalIndex}]`;
        });
        item.imageUrls = [...selected];
    }
    item.__posterGateFacts = facts;
}
