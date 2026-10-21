import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventProposalSubmission, proposalSubmissionStatus, parseProposalEntry, mergeProposalMaterial } from '../../src/features/events/eventProposalSubmission.js';
const full = { title: 'Rave', eventDate: '2026-10-24', venue: 'Diesel', participants: 'DJ', description: 'Music', sourceUrl: 'https://example.org/post', _imageUrls: ['https://example.org/a.jpg'] };
function fixture(overrides = {}) {
    const storage = new Map(), messages = [], proposals = [], replies = [];
    const ctx = { id: 'user', owner: false };
    const deps = {
        key: ctx => ctx.id, load: key => structuredClone(storage.get(key)), save: (key, value) => storage.set(key, structuredClone(value)), today: () => '2026-10-09',
        owner: ctx => ctx.owner, send: async (ctx, text, rows = []) => messages.push({ ctx, text, rows }), error: error => error.message,
        explicit: text => /^(?:парсер|тусы все)(?:\s|$)/u.test(text), clearLegacy() {}, images: async ctx => ctx.images || [],
        parse: async () => ({ events: [{ ...full }] }), prepare: async events => events,
        create: (ctx, state) => { const p = { id: proposals.length + 1, parsedEvents: state.events, status: 'pending' }; proposals.push(p); return p; },
        notify: async () => {}, list: () => proposals, getProposal: id => proposals.find(p => p.id === id),
        showOwner: async (ctx, p) => messages.push({ text: 'owner:' + p.id }), update: (id, events) => { const p = proposals.find(p => p.id === id); if (p?.status !== 'pending') return null; p.parsedEvents = events; return p; },
        moderate: async (ctx, p, action) => { p.status = action; }, reply: async (p, text) => replies.push({ p, text }),
        ...overrides,
    };
    let flow = createEventProposalSubmission(deps);
    const state = () => storage.get('event-proposal-session:' + ctx.id)?.session;
    const click = action => flow.handle(ctx, '', 'ep:' + state().token + '.' + state().revision + ':' + action);
    return { ctx, deps, storage, messages, proposals, replies, state, click, get flow() { return flow; }, reboot() { flow = createEventProposalSubmission(deps); } };
}
test('entry aliases for all users preserve owner direct-add route', () => {
    for (const command of ['добавить тусу', 'тусы добавить', 'предложить тусу', 'предложить информацию о тусе']) assert.equal(parseProposalEntry(command), '');
    assert.equal(parseProposalEntry('добавить тусу', true), null);
    assert.equal(parseProposalEntry('предложить тусу', true), '');
});
test('submission requirements differ from autoapproval, contacts/photo optional', () => {
    assert.equal(proposalSubmissionStatus([{ ...full, contacts: '', _imageUrls: [] }]).complete, true);
    for (const key of ['eventDate', 'venue', 'participants', 'description', 'sourceUrl']) assert.equal(proposalSubmissionStatus([{ ...full, [key]: '' }]).complete, false, key);
    assert.equal(proposalSubmissionStatus([{ title: 'Rave', eventDate: '2026-10-24', venue: 'Hall' }]).autoApprove, true);
    for (const key of ['title', 'eventDate', 'venue']) assert.equal(proposalSubmissionStatus([{ ...full, [key]: '' }]).autoApprove, false, key);
    assert.equal(proposalSubmissionStatus([full], '2027-01-01').autoApprove, false);
});
test('complete draft requires confirmation and duplicate submit creates one proposal', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'добавить тусу test');
    assert.equal(f.proposals.length, 0); assert.equal(f.state().mode, 'review');
    await f.click('review'); await Promise.all([f.click('confirm'), f.click('confirm')]);
    assert.equal(f.proposals.length, 1); assert.equal(f.state().mode, 'sent');
});
test('incomplete as-is explicitly confirms missing fields; contacts not requested', async () => {
    const f = fixture({ parse: async () => ({ events: [{ title: 'draft' }] }) });
    await f.flow.handle(f.ctx, 'предложить тусу draft'); await f.click('disabled');
    assert.equal(f.proposals.length, 0);
    await f.click('no-link'); await f.click('no-photo'); await f.click('as-is');
    assert.match(f.messages.at(-1).text, /дата, место, участники, описание, ссылка, фото/);
    assert.doesNotMatch(f.messages.at(-1).text, /контакты/);
    await f.click('confirm'); assert.equal(f.proposals.length, 1);
});
test('cancel during parse discards late result; old buttons cannot affect new draft', async () => {
    let resolve; const f = fixture({ parse: () => new Promise(r => { resolve = r; }) });
    const running = f.flow.handle(f.ctx, 'предложить тусу draft');
    await new Promise(r => setImmediate(r));
    const old = 'ep:' + f.state().token + '.' + f.state().revision + ':confirm';
    await f.click('reset'); assert.equal(f.state(), null);
    resolve({ events: [full] }); await running; assert.equal(f.state(), null);
    await f.flow.handle(f.ctx, 'предложить тусу'); await f.flow.handle(f.ctx, '', old);
    assert.equal(f.state().events.length, 0); assert.equal(f.proposals.length, 0);
});
test('cancel during prepare creates nothing', async () => {
    let resolve; const f = fixture({ prepare: () => new Promise(r => { resolve = r; }) });
    await f.flow.handle(f.ctx, 'предложить тусу draft'); await f.click('review');
    const running = f.click('confirm'); await new Promise(r => setImmediate(r));
    await f.click('cancel'); resolve([full]); await running; assert.equal(f.proposals.length, 0);
});
test('back undoes changes; stale confirm cannot send modified draft', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'предложить тусу draft'); await f.click('review');
    const stale = 'ep:' + f.state().token + '.' + f.state().revision + ':confirm';
    await f.flow.handle(f.ctx, 'место: Hall'); assert.equal(f.state().events[0].venue, 'Hall');
    await f.flow.handle(f.ctx, '', stale); assert.equal(f.proposals.length, 0);
    await f.click('back'); assert.equal(f.state().events[0].venue, 'Diesel');
});
test('restart preserves draft; explicit command does not discard it', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'предложить тусу draft'); f.reboot();
    assert.equal(await f.flow.handle(f.ctx, 'парсер все'), false);
    assert.equal(f.state().events[0].title, 'Rave');
    await f.flow.handle(f.ctx, 'предложить тусу'); assert.match(f.messages.at(-1).text, /Rave/);
});
test('new photo and link enrich existing draft, do not replace manual fields or old photo', async () => {
    let n = 0;
    const f = fixture({ parse: async () => ({ events: [n++ ? { ...full, venue: 'Other', _imageUrls: ['https://example.org/b.jpg'] } : { ...full, sourceUrl: '' }] }) });
    await f.flow.handle(f.ctx, 'предложить тусу draft');
    await f.flow.handle(f.ctx, 'https://example.org/post');
    assert.equal(f.state().events[0].sourceUrl, full.sourceUrl); assert.equal(f.state().events[0].venue, 'Diesel');
    f.ctx.images = ['https://example.org/b.jpg']; await f.flow.handle(f.ctx, '');
    assert.deepEqual(f.state().events[0]._imageUrls, ['https://example.org/a.jpg', 'https://example.org/b.jpg']);
});
test('parse failure and timeout retain previous data and controls', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'предложить тусу draft');
    f.deps.parse = async () => { throw new Error('offline'); };
    await f.flow.handle(f.ctx, 'new details'); assert.equal(f.state().events[0].title, 'Rave');
    assert.ok(f.messages.at(-1).rows.flat().some(b => b.callback_data.endsWith(':back')));
    f.deps.timeoutMs = 5; f.deps.parse = () => new Promise(() => {});
    await f.flow.handle(f.ctx, 'more details'); assert.equal(f.state().mode, 'review');
});
test('owner reply requires confirmation, preserves moderation, nonowner cannot moderate', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'предложить тусу draft'); await f.click('review'); await f.click('confirm');
    await f.flow.handle(f.ctx, '', 'epm:approve:1'); assert.equal(f.proposals[0].status, 'pending');
    f.ctx.owner = true; await f.flow.handle(f.ctx, '', 'epm:reply:1'); await f.flow.handle(f.ctx, 'Привет');
    assert.equal(f.replies.length, 0); await f.click('reply-send'); assert.equal(f.replies.length, 1);
    assert.equal(f.proposals[0].status, 'pending'); await f.flow.handle(f.ctx, '', 'epm:approve:1'); assert.equal(f.proposals[0].status, 'approve');
});
test('cross-user callback cannot access draft', async () => {
    const f = fixture(); await f.flow.handle(f.ctx, 'предложить тусу draft');
    await f.flow.handle({ id: 'other' }, '', 'ep:' + f.state().token + '.' + f.state().revision + ':as-is');
    assert.equal(f.proposals.length, 0); assert.equal(f.state().mode, 'review');
});
test('multi-event enrichment requires explicit target; contacts correction survives', async () => {
    const f = fixture({ parse: async () => ({ events: [full, { ...full, title: 'Second' }] }) });
    await f.flow.handle(f.ctx, 'предложить тусу draft');
    await f.flow.handle(f.ctx, 'https://example.org/new'); assert.equal(f.state().events.length, 2);
    await f.flow.handle(f.ctx, '2 контакты: @organizer'); assert.equal(f.state().events[1].contacts, '@organizer');
    await f.flow.handle(f.ctx, 'удалить 1'); assert.equal(f.state().events.length, 1); await f.click('back'); assert.equal(f.state().events.length, 2);
    assert.throws(() => mergeProposalMaterial([full, full], [full]));
});

test('photo persistence failure retains draft and permits explicit removal', async () => {
    const f = fixture({ prepare: async () => { throw new Error('photo offline'); } });
    await f.flow.handle(f.ctx, 'предложить тусу draft'); await f.click('review'); await f.click('confirm');
    assert.equal(f.proposals.length, 0); assert.equal(f.state().mode, 'confirm');
    await f.click('remove-photo'); assert.deepEqual(f.state().events[0]._imageUrls, []);
    await f.click('back'); assert.equal(f.state().events[0]._imageUrls.length, 1);
});
test('failed reply retains moderation and back restores reply input', async () => {
    const f = fixture({ reply: async () => { throw new Error('blocked'); } });
    f.proposals.push({ id: 1, status: 'pending', parsedEvents: [full] }); f.ctx.owner = true;
    await f.flow.handle(f.ctx, '', 'epm:reply:1'); await f.flow.handle(f.ctx, 'Ответ'); await f.click('reply-send');
    assert.equal(f.proposals[0].status, 'pending'); await f.click('back'); assert.equal(f.state().mode, 'reply');
    assert.match(f.messages.at(-1).text, /Напишите ответ/);
});
test('cancel then a fresh parse does not allow older parser to release its lock', async () => {
    const resolvers = []; const f = fixture({ parse: () => new Promise(resolve => resolvers.push(resolve)) });
    const old = f.flow.handle(f.ctx, 'предложить тусу old'); await new Promise(r => setImmediate(r)); await f.click('cancel');
    const current = f.flow.handle(f.ctx, 'предложить тусу new'); await new Promise(r => setImmediate(r));
    resolvers[0]({ events: [full] }); await old;
    await f.flow.handle(f.ctx, 'ещё одно дополнение'); assert.match(f.messages.at(-1).text, /ещё разбирается/);
    resolvers[1]({ events: [full] }); await current; assert.equal(f.state().mode, 'review');
});
