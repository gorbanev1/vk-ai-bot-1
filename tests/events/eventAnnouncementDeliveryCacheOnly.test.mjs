import test from 'node:test';
import assert from 'node:assert/strict';
import { configureEventAnnouncementCopies, prepareEventAnnouncementCopies, selectEventAnnouncement } from '../../src/features/events/eventAnnouncementCopies.js';

test('cache-only inspection never calls a model or fabricates a cropped copy', async () => {
    let edits = 0;
    configureEventAnnouncementCopies({ render: (e, p, text) => 'Header\n' + text,
        edit: async () => { edits++; throw new Error('Delivery must not invoke AI'); } });
    const events = Array.from({ length: 132 }, (_, id) => ({ id, title: 'Event ' + id,
        description: ('Original sentence ' + id + '. ').repeat(150) }));
    const prepared = await prepareEventAnnouncementCopies(events, { cacheOnly: true });
    assert.equal(edits, 0);
    assert.equal(prepared.length, 132);
    for (const [i, event] of prepared.entries()) {
        assert.equal(event.description, events[i].description.trim());
        assert.throws(() => selectEventAnnouncement(event, 'telegram'), { code: 'EVENT_CARD_PREPARATION_PENDING' });
    }
});

test('delivery does not wait for pending ingest editing; later delivery reuses its cached copy', async () => {
    const stored = new Map();
    let finish, edits = 0;
    const event = { title: 'Event', description: 'Original source sentence. '.repeat(100) };
    configureEventAnnouncementCopies({ render: (e, p, text) => text, load: key => stored.get(key),
        save: (key, value) => stored.set(key, value),
        edit: () => { edits++; return new Promise(resolve => { finish = resolve; }); } });
    const ingest = prepareEventAnnouncementCopies([event]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(edits, 1);
    let timer;
    try {
        const immediate = await Promise.race([
            prepareEventAnnouncementCopies([event], { cacheOnly: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery waited for AI')), 1000); })
        ]);
        assert.equal(immediate.length, 1);
        assert.equal(stored.size, 0);
    } finally {
        clearTimeout(timer);
        finish({ shared: 'Saved concise copy. '.repeat(48).trim(), shortSummary: 'Short.', ultraShortSummary: 'Tiny.' });
        await ingest;
    }
    const [cached] = await prepareEventAnnouncementCopies([event], { cacheOnly: true });
    assert.equal(selectEventAnnouncement(cached, 'telegram'), 'Saved concise copy. '.repeat(48).trim());
    assert.equal(cached.shortSummary, 'Short.');
    assert.equal(edits, 1);
});
