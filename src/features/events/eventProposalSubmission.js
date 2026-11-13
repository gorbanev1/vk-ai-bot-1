import { randomUUID } from 'node:crypto';
import { normalizeEventProposalDraftEvent, analyzeEventProposalDraft, hasUsableVenueStatement, parseEventProposalCorrections, applyEventProposalCorrections } from './eventProposalWorkflow.js';

export const EVENT_PROPOSAL_TEMPLATE = 'Название: \nДата: \nМесто: \nУчастники: \nОписание: \nСсылка: \nВремя: \nЦена: \nКонтакты (необязательно): ';
const labels = { date: 'дата', venue: 'место', participants: 'участники', description: 'описание', sourceUrl: 'ссылка', photo: 'фото' };
const present = value => Boolean(String(value || '').trim() && !/^(?:нет|неизвестно|не указано|[-—.…]+)$/iu.test(String(value).trim()));
export function proposalSubmissionStatus(events, referenceDate = '') {
    const missing = new Set();
    const normalized = (events || []).map(event => normalizeEventProposalDraftEvent(event, { allowNearAddressMatch: true }));
    for (const event of normalized) {
        if (!event.eventDate) missing.add('date');
        if (!hasUsableVenueStatement(event.venue)) missing.add('venue');
        for (const field of ['participants', 'description']) if (!present(event[field])) missing.add(field);
        if (!/^https?:\/\/\S+$/iu.test(event.sourceUrl)) missing.add('sourceUrl');
        if (!event.imagePaths?.length && !event._imageUrls?.length) missing.add('photo');
    }
    const past = normalized.some(event => analyzeEventProposalDraft(event, { referenceDate }).blocking.length);
    return { missing: [...missing], complete: normalized.length > 0 && !past && [...missing].every(field => field === 'photo'), past,
        autoApprove: normalized.length > 0 && normalized.every(event => analyzeEventProposalDraft(event, { referenceDate }).canSubmit && present(event.title) && !/^(?:событие|мероприятие|туса)$/iu.test(event.title)) };
}
export function parseProposalEntry(text, owner = false) {
    const source = String(text || '').trim();
    const match = source.match(/^(?:предложи(?:ть)?\s+(?:(?:информацию|инфу)\s+(?:о|об)\s+)?(?:тусу|тусе|тусовку|мероприятие|событие)|(?:добавить|добавь)\s+тусу|тусы\s+добавить)(?=$|\s|:)/iu);
    if (!match || (owner && !/^предлож/iu.test(match[0]))) return null;
    return source.slice(match[0].length).replace(/^\s*:\s*/u, '').trim();
}
export function mergeProposalMaterial(previous, incoming) {
    if (!previous.length) return incoming;
    if (previous.length !== 1 || incoming.length !== 1) throw new Error('Для дополнения нескольких событий укажите номер: «2 ссылка: URL» или «2 место: …».');
    const old = previous[0], fresh = incoming[0];
    const merged = { ...fresh, ...old };
    for (const key of ['title', 'eventDate', 'eventTime', 'venue', 'participants', 'description', 'sourceUrl', 'contacts', 'price']) {
        if (!present(old[key]) && present(fresh[key])) merged[key] = fresh[key];
    }
    for (const key of ['imagePaths', '_imageUrls']) merged[key] = [...new Set([...(old[key] || []), ...(fresh[key] || [])])];
    return [merged];
}

// Actor-scoped durable state; revision fencing discards a parser result after Back/Cancel.
export function createEventProposalSubmission(deps) {
    const busy = new Map();
    const moderationBusy = new Set();
    const keyOf = ctx => deps.key(ctx);
    const read = key => deps.load('event-proposal-session:' + key)?.session || null;
    const write = (key, session) => deps.save('event-proposal-session:' + key, { session });
    const fresh = () => ({ token: randomUUID(), revision: 0, mode: 'input', events: [], history: [], skipped: [], updatedAt: Date.now() });
    const save = (key, state, history = true) => {
        const old = read(key);
        if (history && old) state.history = [...(old.history || []), { ...old, history: [] }].slice(-12);
        state.revision = (old?.revision || 0) + 1; state.updatedAt = Date.now(); write(key, state); return state;
    };
    const controls = [['⬅️ Назад', 'back'], ['Отменить отправку', 'cancel'], ['Сбросить состояние', 'reset']];
    const button = (state, label, action) => ({ text: label, callback_data: 'ep:' + state.token + '.' + state.revision + ':' + action });
    async function send(ctx, text, state, actions = []) {
        const rows = [...actions.map(([label, action]) => [button(state, label, action)]), controls.slice(0, 2).map(([label, action]) => button(state, label, action)), [button(state, ...controls[2])]];
        await deps.send(ctx, text, rows);
    }
    function card(event, index) {
        const venue = normalizeEventProposalDraftEvent(event).venue || '—';
        return '#' + (index + 1) + '\nНазвание: ' + (event.title || '—') + '\nДата: ' + (event.eventDate || '—') + '\nВремя: ' + (event.eventTime || '—') + '\nМесто: ' + venue + '\nУчастники: ' + (event.participants || '—') + '\nОписание: ' + (event.description || '—') + '\nСсылка: ' + (event.sourceUrl || '—') + '\nЦена: ' + (event.price || '—') + (event.contacts ? '\nКонтакты: ' + event.contacts : '') + '\nФото: ' + ((event.imagePaths?.length || event._imageUrls?.length) ? 'есть' : 'нет');
    }
    async function show(ctx, state) {
        if (state.mode === 'reply' || state.mode === 'reply-confirm') return send(ctx, state.mode === 'reply' ? 'Напишите ответ отправителю заявки #' + state.replyId + '.' : 'Ответ отправителю:\n' + state.replyText + '\nОтправить?', state, state.mode === 'reply-confirm' ? [['Отправить ответ', 'reply-send']] : []);
        if (state.mode === 'processing') state = save(keyOf(ctx), { ...state, mode: state.events.length ? 'review' : 'input' }, false);
        if (!state.events.length) return send(ctx, 'Пришлите ссылку, текст, афишу или всё вместе. Ссылку открою в браузере, текст и изображение проверю через ИИ. Дополнения можно присылать отдельно.\n\nСкопируйте и заполните шаблон:\n' + EVENT_PROPOSAL_TEMPLATE + '\nКонтакты необязательны. Для обычной отправки нужны дата, место, участники, описание и ссылка. Неполную заявку можно отправить с подтверждением.', state, [['📋 Скопировать шаблон', 'template']]);
        const status = proposalSubmissionStatus(state.events, deps.today());
        const actions = [];
        if (status.missing.includes('sourceUrl') && !state.skipped.includes('sourceUrl')) actions.push(['Нет ссылки', 'no-link']);
        if (status.missing.includes('photo') && !state.skipped.includes('photo')) actions.push(['Нет фото', 'no-photo']);
        actions.push([status.complete ? 'Всё верно? Отправить' : '⚪ Отправить (не все поля)', status.complete ? 'review' : 'disabled']);
        if (status.missing.length && !status.past) actions.push(['⚠️ Отправить как есть?', 'as-is']);
        if (state.editId) actions.splice(0, actions.length, ['Сохранить изменения заявки', 'save-edit']);
        await send(ctx, state.events.map(card).join('\n\n') + '\n\n' + (status.missing.length ? 'Не хватает: ' + status.missing.map(field => labels[field]).join(', ') + '. Пришлите дополнения или явно подтвердите отправку без них.' : 'Все основные поля заполнены.') + (status.past ? '\nДата уже прошла: исправьте её перед отправкой.' : '') + '\nПравки: «место: …», «описание: …». Если событий несколько: «2 место: …». Удалить событие: «удалить 2».', state, actions);
    }
    async function moderate(ctx, id, action) {
        if (!deps.owner(ctx)) { await deps.send(ctx, 'Эта команда доступна владельцу в ЛС.'); return true; }
        if (moderationBusy.has(id)) { await deps.send(ctx, 'Заявка уже сохраняется.'); return true; }
        moderationBusy.add(id);
        try {
            const proposal = deps.getProposal(id);
            if (!proposal || proposal.status !== 'pending') { await deps.send(ctx, 'Заявка уже рассмотрена или не найдена.'); return true; }
            if (action === 'approve' || action === 'reject') await deps.moderate(ctx, proposal, action);
            else {
                const state = fresh();
                state.mode = action === 'reply' ? 'reply' : 'review';
                state.editId = action === 'edit' ? id : null; state.replyId = action === 'reply' ? id : null;
                state.events = action === 'edit' ? proposal.parsedEvents : [];
                save(keyOf(ctx), state);
                if (action === 'reply') await send(ctx, 'Напишите ответ отправителю заявки #' + id + '. Перед отправкой покажу подтверждение. Кнопки модерации останутся доступны.', state);
                else await show(ctx, state);
            }
        } finally { moderationBusy.delete(id); }
        return true;
    }
    async function handle(ctx, text, callback = '') {
        const key = keyOf(ctx);
        let state = read(key);
        const source = String(text || '').trim();
        const owner = deps.owner(ctx);
        const mod = callback.match(/^epm:(approve|reject|edit|reply):(\d+)$/u) || source.match(/^заявка\s+(принять|отклонить|изменить|написать)\s+#?(\d+)$/iu);
        if (mod) return moderate(ctx, Number(mod[2]), ({ принять: 'approve', отклонить: 'reject', изменить: 'edit', написать: 'reply' })[mod[1]] || mod[1]);
        if (/^тусы\s+(?:на\s+(?:одобрение|апрув)|ожидают)$/iu.test(source)) {
            if (!owner) { await deps.send(ctx, 'Список модерации доступен владельцу в ЛС.'); return true; }
            const rows = deps.list();
            if (!rows.length) await deps.send(ctx, 'Ожидающих заявок нет.');
            for (const proposal of rows) await deps.showOwner(ctx, proposal);
            return true;
        }
        const clicked = callback.match(/^ep:([^:]+):([\w-]+)$/u);
        if (clicked && (!state || clicked[1] !== state.token + '.' + state.revision)) { await deps.send(ctx, 'Эта кнопка от другого или завершённого черновика. Команда «предложить тусу» откроет текущий.'); return true; }
        let action = clicked?.[2] || ({ 'назад': 'back', '⬅️ назад': 'back', 'отмена': 'cancel', 'отменить отправку': 'cancel', 'сбросить состояние': 'reset', 'нет ссылки': 'no-link', 'нет фото': 'no-photo', 'отправить как есть': 'as-is', 'отправить': 'review', 'на проверку': 'review', 'подтверждаю отправку': 'confirm', 'сохранить изменения заявки': 'save-edit' })[source.toLowerCase()] || '';
        if (action === 'reset' || (action === 'cancel' && state)) {
            busy.delete(key); write(key, null); deps.clearLegacy(ctx);
            await deps.send(ctx, state?.submittedId ? 'Состояние сброшено. Заявка #' + state.submittedId + ' уже отправлена и остаётся на проверке.' : 'Черновик и ожидание ввода сброшены. Отправка отменена. Для нового предложения: «предложить тусу».'); return true;
        }
        const entry = parseProposalEntry(source, owner);
        if (!state && entry === null && !clicked) return false;
        if (action === 'back' && state?.mode === 'sent') { await deps.send(ctx, 'Заявка уже отправлена. Для нового черновика: «предложить тусу».'); return true; }
        if (action === 'back') {
            busy.delete(key);
            const history = [...(state.history || [])], previous = history.pop();
            state = save(key, previous ? { ...previous, history } : { ...state, mode: state.events.length ? 'review' : 'input' }, false);
            await show(ctx, state); return true;
        }
        if (busy.has(key)) { await send(ctx, 'Материал ещё разбирается. Можно вернуться назад или отменить; результат отменённого разбора не будет применён.', state); return true; }
        if (state?.mode === 'sent') {
            if (entry === null) {
                if (clicked || action) { await deps.send(ctx, 'Заявка #' + state.submittedId + ' уже отправлена. Новая: «предложить тусу».'); return true; }
                return false;
            }
            state = null;
        }
        if (!state) state = save(key, fresh(), false);
        if (action === 'template') { await send(ctx, EVENT_PROPOSAL_TEMPLATE, state); return true; }
        if (action === 'disabled') { await show(ctx, state); return true; }
        if (action === 'remove-photo') {
            state = save(key, { ...state, mode: 'review', events: state.events.map(event => ({ ...event, imagePaths: [], _imageUrls: [] })) });
            await show(ctx, state); return true;
        }
        if (action === 'no-link' || action === 'no-photo') {
            state = save(key, { ...state, mode: 'review', skipped: [...new Set([...state.skipped, action === 'no-link' ? 'sourceUrl' : 'photo'])] });
            await show(ctx, state); return true;
        }
        if (state.editId && ['review', 'as-is', 'confirm'].includes(action)) { await show(ctx, state); return true; }
        if (action === 'review' || action === 'as-is') {
            const status = proposalSubmissionStatus(state.events, deps.today());
            if (!state.events.length || status.past || (action === 'review' && !status.complete)) { await show(ctx, state); return true; }
            state = save(key, { ...state, mode: 'confirm' });
            await send(ctx, 'Всё верно?' + (status.missing.length ? '\nОтправить без: ' + status.missing.map(field => labels[field]).join(', ') + '?' : '') + '\nЗаявка поступит владельцу на ревью. Автопубликация через сутки возможна только при наличии даты, названия и места.', state, [['🟢 Отправить на ревью', 'confirm']]); return true;
        }
        if (action === 'save-edit' && state.editId) {
            if (!state.events.length) { await send(ctx, 'В заявке должно остаться хотя бы одно событие. Можно вернуться назад или отклонить заявку.', state); return true; }
            const token = state.token, version = state.revision;
            busy.set(key, token);
            let updated;
            try {
                const events = await deps.prepare(state.events);
                const current = read(key);
                if (!current || current.token !== token || current.revision !== version) return true;
                updated = deps.update(state.editId, events);
            } catch (error) { await send(ctx, 'Изменения пока не сохранены: ' + deps.error(error), state); return true; }
            finally { if (busy.get(key) === token) busy.delete(key); }
            if (!updated) await deps.send(ctx, 'Заявка уже рассмотрена; изменения не применены.');
            else await deps.showOwner(ctx, updated);
            write(key, null); return true;
        }
        if (action === 'confirm') {
            if (state.mode !== 'confirm') { await show(ctx, state); return true; }
            const version = state.revision, token = state.token, workId = token + ':' + version; busy.set(key, workId);
            let prepareTimer;
            try {
                const prepared = await Promise.race([deps.prepare(state.events), new Promise((_, reject) => { prepareTimer = setTimeout(() => reject(new Error('Сохранение афиши не завершилось за 3 минуты')), 180_000); })]);
                const current = read(key);
                if (!current || current.revision !== version || current.token !== token) return true;
                // No await between INSERT and durable sent marker: duplicate clicks cannot insert twice.
                const proposal = deps.create(ctx, { ...state, events: prepared });
                save(key, { ...state, mode: 'sent', submittedId: proposal.id, history: [] }, false);
                await deps.send(ctx, '✅ Заявка #' + proposal.id + ' сохранена на проверку. Через сутки автоматически публикуется только заявка с датой, названием и местом.');
                await deps.notify(proposal);
            } catch (error) {
                const current = read(key);
                if (current?.token === token && current.mode !== 'sent') await send(ctx, 'Не удалось закончить отправку: ' + deps.error(error) + '. Черновик сохранён.', current, [['Повторить отправку', 'confirm'], ['Отправить без фото', 'remove-photo']]);
                else if (current?.mode === 'sent') await deps.send(ctx, 'Заявка уже сохранена. Уведомление владельца будет повторено автоматически.');
            }
            finally { clearTimeout(prepareTimer); if (busy.get(key) === workId) busy.delete(key); }
            return true;
        }
        if (!action && entry === null && !/^(?:удалить|убрать)\s+\d+$/iu.test(source) && deps.explicit(source)) return false;
        if (['reply', 'reply-confirm'].includes(state.mode) && source) {
            state = save(key, { ...state, mode: 'reply-confirm', replyText: source });
            await send(ctx, 'Ответ отправителю заявки #' + state.replyId + ':\n' + source + '\n\nОтправить?', state, [['Отправить ответ', 'reply-send']]); return true;
        }
        if (action === 'reply-send' && state.mode === 'reply-confirm') {
            busy.set(key, state.token);
            try { await deps.reply(deps.getProposal(state.replyId), state.replyText); write(key, null); await deps.send(ctx, 'Ответ отправлен. Модерация заявки остаётся доступна.'); }
            catch (error) { await send(ctx, 'Не удалось доставить ответ: ' + deps.error(error) + '. Можно повторить или открыть профиль в заявке.', state, [['Повторить ответ', 'reply-send']]); }
            finally { busy.delete(key); }
            return true;
        }
        const body = entry === null ? source : entry;
        const corrections = parseEventProposalCorrections(body);
        const hasLink = /https?:\/\//iu.test(body);
        const observedRevision = state.revision, observedToken = state.token;
        const images = await deps.images(ctx);
        const afterImages = read(key);
        if (!afterImages || afterImages.token !== observedToken || afterImages.revision !== observedRevision) { await deps.send(ctx, 'Черновик уже изменён другим сообщением или отменён. Повторите дополнение для текущего черновика.'); return true; }
        if (entry === '' && state.events.length && !images.length) { await show(ctx, state); return true; }
        if (state.events.length && corrections.length && !hasLink && !images.length) {
            if (state.events.length > 1 && corrections.some(item => !item.eventIndex)) { await send(ctx, 'Укажите номер события перед полем: «2 место: …».', state); return true; }
            state = save(key, { ...state, mode: 'review', events: applyEventProposalCorrections(state.events, corrections) });
            await show(ctx, state); return true;
        }
        const remove = body.match(/^(?:удалить|убрать)\s+(\d+)$/iu);
        if (remove) {
            const index = Number(remove[1]) - 1;
            if (!state.events[index]) { await send(ctx, 'Нет события с таким номером.', state); return true; }
            state = save(key, { ...state, events: state.events.filter((_, i) => i !== index), mode: 'review' });
            await show(ctx, state); return true;
        }
        if (!body && !images.length) { await show(ctx, state); return true; }
        const targetIndexes = [...new Set(corrections.map(item => item.eventIndex).filter(Boolean))];
        if (state.events.length > 1 && (targetIndexes.length !== 1 || !state.events[targetIndexes[0] - 1])) {
            await send(ctx, 'Укажите событие, например «2 ссылка: URL». Несвязанные карточки не объединяю.', state); return true;
        }
        const targetIndex = targetIndexes.length === 1 ? targetIndexes[0] - 1 : 0;
        const before = { ...state, mode: state.events.length ? 'review' : 'input' };
        state = save(key, { ...state, mode: 'processing', lastInput: body });
        const version = state.revision, token = state.token, workId = token + ':' + version; busy.set(key, workId);
        let timer;
        try {
            await send(ctx, '🔎 Разбираю материал. Черновик сохранён; можно вернуться назад, отменить отправку или сбросить состояние.', state);
            const oldEvents = before.events.length ? [before.events[targetIndex]] : [];
            const combined = oldEvents.length ? 'Дополнение пользователя:\n' + body + '\n\nТекущая карточка:\n' + oldEvents.map(card).join('\n\n') : body;
            const parsed = await Promise.race([deps.parse(ctx, combined), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Разбор не завершился за 12 минут. Черновик сохранён; можно повторить.')), deps.timeoutMs || 12 * 60_000); })]);
            const current = read(key);
            if (!current || current.token !== token || current.revision !== version) return true;
            let events = mergeProposalMaterial(oldEvents, parsed.events);
            if (before.events.length) events = before.events.map((event, index) => index === targetIndex ? events[0] : event);
            if (corrections.length) events = applyEventProposalCorrections(events, corrections);
            state = save(key, { ...before, mode: 'review', events, rawSubmission: [before.rawSubmission, body].filter(Boolean).join('\n'), skipped: [] });
            await show(ctx, state);
        } catch (error) {
            const current = read(key);
            if (current?.token === token && current?.revision === version) {
                const fallback = !before.events.length && corrections.length ? applyEventProposalCorrections([{}], corrections) : before.events;
                state = save(key, { ...before, events: fallback, lastInput: body, rawSubmission: [before.rawSubmission, body].filter(Boolean).join('\n'), mode: fallback.length ? 'review' : 'input' }, false);
                await send(ctx, 'Не удалось разобрать дополнение: ' + deps.error(error) + '. Введённый материал и прежние данные сохранены.', state);
                await show(ctx, state);
            }
        } finally { clearTimeout(timer); if (busy.get(key) === workId) busy.delete(key); }
        return true;
    }
    return {
        handle: async (...args) => {
            try { return await handle(...args); }
            catch (error) {
                const state = read(keyOf(args[0]));
                if (state) await send(args[0], 'Действие не завершено: ' + deps.error(error) + '. Черновик сохранён; можно вернуться назад или сбросить состояние.', state);
                else await deps.send(args[0], 'Действие не завершено: ' + deps.error(error));
                return true;
            }
        }, moderate, isModerating: id => moderationBusy.has(id)
    };
}
