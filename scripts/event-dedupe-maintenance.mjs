await import('dotenv/config');
const { runEventDedupeMaintenanceForCurrentDatabase, rebuildVerifiedPartySnapshotQueued } = await import('../src/app/botApplication.js');

const apply = process.argv.includes('--apply');
const rebuildSnapshot = process.argv.includes('--snapshot');

try {
    const result = await runEventDedupeMaintenanceForCurrentDatabase({ apply, rebuildSnapshot: false });
    let snapshot = null;
    if (rebuildSnapshot) {
        snapshot = await rebuildVerifiedPartySnapshotQueued({
            reason: apply
                ? 'owner-command:event-dedupe-maintenance-script-after-apply'
                : 'owner-command:event-dedupe-maintenance-script-refresh',
        });
    }
    console.log(JSON.stringify({
        applied: result.applied,
        raw: result.rawEvents?.length || 0,
        groups: result.groups?.length || 0,
        duplicateRows: result.duplicateRows || 0,
        unresolvedAmbiguous: result.unresolvedAmbiguous?.length || 0,
        purgedDuplicateRows: result.purgedDuplicateRows || 0,
        groups: (result.groups || []).map((group) => ({
            date: group.canonical?.eventDate || '',
            canonical: group.keepKey || '',
            members: (group.members || []).map((member) => ({
                ref: `${member.ref?.sourceType || ''}:${member.ref?.id || ''}`,
                title: member.title || '',
            })),
        })),
        registry: result.registry || null,
        snapshot: snapshot ? {
            canonicalCount: snapshot.canonicalCount,
            remainingDuplicateCount: snapshot.remainingDuplicateCount,
        } : null,
    }, null, 2));
    if (result.error) process.exitCode = 2;
} catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
}
