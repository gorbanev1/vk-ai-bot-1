import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAIN_DATABASE_PATH, RUNTIME_DATA_DIRECTORY } from '../../infrastructure/database/index.js';
import { filterChtivoTextBooks, matchChtivoBookQuery, normalizeChtivoText, renumberChtivoBooks, splitChtivoBody, splitChtivoChapters } from './chtivoText.js';
import { formatChtivoIntroduction } from './chtivoIntro.js';
import { chtivoPartRandomId } from './chtivoDeliveryId.js';
import { sendChtivoVkMessage } from './chtivoVkTransport.js';
import { findLatestChtivoPartConversationMessageId, resolveChtivoConversationMessageId } from './chtivoReplyTarget.js';

const ROOT = resolve(process.cwd(), 'chtivo');
const PLATFORM_MESSAGE_LIMIT = 4096;
const BODY_TARGET_LIMIT = Math.floor(PLATFORM_MESSAGE_LIMIT * 0.96);
const TAIL_LIMIT = 1024;
const TZ = 'Europe/Moscow';
const db = new DatabaseSync(MAIN_DATABASE_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS chtivo_books (
 id INTEGER PRIMARY KEY AUTOINCREMENT, catalog_no INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', path TEXT NOT NULL UNIQUE, version TEXT NOT NULL, created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS chtivo_chapters (
 id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL, chapter_order INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, version TEXT NOT NULL, UNIQUE(book_id, chapter_order), FOREIGN KEY(book_id) REFERENCES chtivo_books(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chtivo_progress (
 peer_id INTEGER NOT NULL, book_id INTEGER NOT NULL, chapter_order INTEGER NOT NULL DEFAULT 0, chapter_offset INTEGER NOT NULL DEFAULT 0, part_number INTEGER NOT NULL DEFAULT 1, last_text_message_id INTEGER NOT NULL DEFAULT 0, max_mode INTEGER NOT NULL DEFAULT 1, chapter_started_day TEXT NOT NULL DEFAULT '', chapter_completed INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(peer_id, book_id)
);
CREATE TABLE IF NOT EXISTS chtivo_publications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id INTEGER NOT NULL, book_id INTEGER NOT NULL, chapter_order INTEGER NOT NULL, part_number INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, message_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(peer_id, book_id, chapter_order, part_number)
);
CREATE TABLE IF NOT EXISTS chtivo_daily_greetings (
 peer_id INTEGER NOT NULL, day_key TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(peer_id, day_key)
);
CREATE TABLE IF NOT EXISTS chtivo_schedule (
 peer_id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, due_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);`);

const normalize = normalizeChtivoText;
function dayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function titleFromFile(file) {
  let title = basename(file, extname(file)).replace(/\s+ModernLib\.Ru$/iu, '').trim();
  // Файлы библиотек часто названы «Автор. Название - источник». В каталоге
  // показываем именно название произведения, чтобы разные копии одного
  // текста можно было надёжно объединить.
  const byline = title.match(/^[^.]+\.\s*(.+?)(?:\s*[-—]\s*)?$/u);
  if (byline?.[1]) title = byline[1].trim();
  title = title.replace(/\s*[-—]\s*Баян\s+Ширянов\s*$/iu, '').trim();
  return title;
}
function authorFromText(text) { return (text.match(/^Баян\s+Ширянов/imu)?.[0] || '').trim(); }
const splitChapters = splitChtivoChapters;
function canonicalBookKey(title, author = '') {
  const normalized = `${String(title || '')} ${String(author || '')}`
    .toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(/\s+/u).filter(Boolean);
  const authorTokens = String(author || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  const remaining = normalized.slice();
  for (const token of authorTokens) {
    const index = remaining.indexOf(token);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining.sort().join(' ');
}

function syncBooks() {
  if (!existsSync(ROOT)) return;
  const files = readdirSync(ROOT).filter(f => /\.txt$/iu.test(f));
  const currentTextPaths = new Set(files.map(file => resolve(ROOT, file).toLowerCase()));
  const upsert = db.prepare('SELECT id, version FROM chtivo_books WHERE path = ?');
  const insert = db.prepare('INSERT INTO chtivo_books(catalog_no,title,author,path,version,created_at) VALUES(?,?,?,?,?,?)');
  const update = db.prepare('UPDATE chtivo_books SET title=?,author=?,version=?,enabled=1 WHERE id=?');
  const addChapter = db.prepare('INSERT OR REPLACE INTO chtivo_chapters(book_id,chapter_order,title,body,version) VALUES(?,?,?,?,?)');
  for (const name of files) {
    const path = join(ROOT, name); const raw = normalize(readFileSync(path, 'utf8')); if (!raw) continue;
    // Include the chapter parser revision so existing books are rebuilt when
    // the chapter boundary rules change, even if the source TXT is unchanged.
    const legacyChapterVersion = createHash('sha256').update(`${raw}\0chtivo-chapters-v2`).digest('hex');
    const version = createHash('sha256').update(`${raw}\0chtivo-chapters-v5`).digest('hex'); const existing = upsert.get(path);
    let bookId;
    if (existing) {
      bookId = existing.id;
      update.run(titleFromFile(path), authorFromText(raw), version, bookId);
      if (existing.version !== version) {
        const oldFirstChapter = db.prepare('SELECT title, length(body) AS body_length FROM chtivo_chapters WHERE book_id=? ORDER BY chapter_order LIMIT 1').get(bookId);
        const titlePageOffset = normalize(raw.slice(0, raw.search(/^\[\[ГЛАВА:/imu)));
        const isKnownTitlePageBook = /низший пилотаж/iu.test(titleFromFile(path));
        if (oldFirstChapter?.title === 'Вводная часть' || (existing.version === legacyChapterVersion && isKnownTitlePageBook)) {
          db.prepare(`UPDATE chtivo_progress
            SET chapter_order=MAX(0, chapter_order-1),
                chapter_offset=CASE WHEN chapter_order=1 AND chapter_completed=1 THEN ? ELSE chapter_offset END,
                chapter_completed=0, updated_at=?
            WHERE book_id=? AND chapter_order>0`).run(Number(oldFirstChapter?.body_length || titlePageOffset.length), Math.floor(Date.now() / 1000), bookId);
        }
        db.prepare('DELETE FROM chtivo_chapters WHERE book_id=?').run(bookId);
      }
    }
    else { const no = Number(db.prepare('SELECT COALESCE(MAX(catalog_no),0)+1 n FROM chtivo_books').get().n); bookId = Number(insert.run(no, titleFromFile(path), authorFromText(raw), path, version, Math.floor(Date.now()/1000)).lastInsertRowid); }
    const chapters = splitChapters(raw); chapters.forEach((c, i) => addChapter.run(bookId, i, c.title, c.body, version));
  }
  // Keep the reading cursor after text that was already sent before a chapter
  // parser update. This prevents a merged title page from being sent again.
  for (const row of db.prepare(`
    SELECT p.peer_id, p.book_id, p.chapter_order, p.chapter_offset, p.part_number,
      MAX(pub.end_offset) AS published_offset, MAX(pub.part_number) AS published_part
    FROM chtivo_progress p
    JOIN chtivo_publications pub
      ON pub.peer_id=p.peer_id AND pub.book_id=p.book_id
      AND pub.chapter_order=p.chapter_order AND pub.status='sent'
    GROUP BY p.peer_id, p.book_id, p.chapter_order
  `).all()) {
    const publishedOffset = Number(row.published_offset || 0);
    const publishedPart = Number(row.published_part || 0);
    if (publishedOffset > Number(row.chapter_offset || 0)) {
      db.prepare(`UPDATE chtivo_progress
        SET chapter_offset=?, part_number=MAX(part_number, ?), chapter_completed=0, updated_at=?
        WHERE peer_id=? AND book_id=? AND chapter_order=?`)
        .run(publishedOffset, publishedPart + 1, Math.floor(Date.now() / 1000), row.peer_id, row.book_id, row.chapter_order);
    }
  }
  for (const row of db.prepare('SELECT id, path FROM chtivo_books WHERE enabled=1').all()) {
    if (!currentTextPaths.has(resolve(String(row.path || '')).toLowerCase())) {
      db.prepare('UPDATE chtivo_books SET enabled=0 WHERE id=?').run(row.id);
    }
  }
  // Старые импорты DOC не поддерживаются текущим загрузчиком и не должны
  // оставаться видимыми. Среди TXT-копий одного произведения оставляем
  // наиболее полную версию (с большим числом глав и объёмом текста).
  const candidates = db.prepare(`
    SELECT b.id, b.title, b.author, b.path,
      COALESCE((SELECT COUNT(*) FROM chtivo_chapters c WHERE c.book_id=b.id), 0) AS chapter_count,
      COALESCE((SELECT SUM(length(c.body)) FROM chtivo_chapters c WHERE c.book_id=b.id), 0) AS body_length
    FROM chtivo_books b WHERE b.enabled=1
  `).all();
  const groups = new Map();
  for (const book of candidates) {
    if (!/\.txt$/iu.test(String(book.path || ''))) {
      db.prepare('UPDATE chtivo_books SET enabled=0 WHERE id=?').run(book.id);
      continue;
    }
    const key = canonicalBookKey(book.title, book.author);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(book);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Number(b.chapter_count) - Number(a.chapter_count) || Number(b.body_length) - Number(a.body_length));
    for (const duplicate of group.slice(1)) db.prepare('UPDATE chtivo_books SET enabled=0 WHERE id=?').run(duplicate.id);
  }
}
syncBooks();

function books() {
  // The catalog number is a display/index value, not a durable database id.
  // Re-number visible TXT files so disabled legacy imports never leak gaps.
  const currentTextPaths = new Set(readdirSync(ROOT).filter(file => /\.txt$/iu.test(file)).map(file => resolve(ROOT, file)));
  const stored = db.prepare("SELECT * FROM chtivo_books WHERE enabled=1 AND lower(path) LIKE '%.txt' ORDER BY catalog_no, id").all();
  return renumberChtivoBooks(filterChtivoTextBooks(stored, currentTextPaths));
}
function choose(value) {
  const list = books(); const n = Number(value); if (Number.isInteger(n) && n > 0) return list.find(b => b.catalog_no === n) || null;
  return matchChtivoBookQuery(list, value);
}
function splitBody(body, target = BODY_TARGET_LIMIT, hardMax = target) {
  return splitChtivoBody(body, target, hardMax);
}
function findSentCmid(peerId, messageText, afterTimestamp) {
  const row = db.prepare('SELECT conversation_message_id FROM vk_message_archive WHERE peer_id=? AND is_outbox=1 AND text=? AND created_at>=? ORDER BY conversation_message_id DESC LIMIT 1')
    .get(Number(peerId), String(messageText), Number(afterTimestamp));
  return Number(row?.conversation_message_id || 0);
}
function getProgress(peerId, bookId) { return db.prepare('SELECT * FROM chtivo_progress WHERE peer_id=? AND book_id=?').get(peerId, bookId); }
function activeBook(peerId) { const row = db.prepare('SELECT b.* FROM chtivo_progress p JOIN chtivo_books b ON b.id=p.book_id WHERE p.peer_id=? AND p.active=1 LIMIT 1').get(peerId); return row || null; }
function ensureDailyGreeting(context) {
  const key = dayKey();
  const inserted = db.prepare('INSERT OR IGNORE INTO chtivo_daily_greetings(peer_id,day_key,created_at) VALUES(?,?,?)').run(context.peerId, key, Math.floor(Date.now() / 1000));
  return Number(inserted.changes || 0) > 0;
}

async function sendReadingPart(context, text, { random_id = 0, replyWithForwardConversationMessageId = 0 } = {}) {
  if (typeof context.api?.messages?.send === 'function') {
    return sendChtivoVkMessage(context.api, {
      peerId: context.peerId, message: text, randomId: random_id, replyTo: replyWithForwardConversationMessageId,
    });
  }
  return context.send(text, { random_id, ...(replyWithForwardConversationMessageId ? { replyWithForwardConversationMessageId } : {}) });
}
function previousReadingPartId(context, book, chapter, progress) {
  if (!progress.chapter_offset) return 0; // New chapter starts a new chain.
  if (Number(progress.last_text_message_id) > 0) return Number(progress.last_text_message_id);
  const publication = db.prepare("SELECT * FROM chtivo_publications WHERE peer_id=? AND book_id=? AND chapter_order=? AND end_offset=? AND status='sent' ORDER BY part_number DESC LIMIT 1")
    .get(context.peerId, book.id, progress.chapter_order, progress.chapter_offset);
  let id = Number(publication?.message_id || 0);
  if (!id) {
    const partNumber = Number(publication?.part_number || progress.part_number - 1);
    const archivedParts = db.prepare('SELECT conversation_message_id,is_outbox,text FROM vk_message_archive WHERE peer_id=? AND is_outbox=1 AND instr(text,?)>0 AND instr(text,?)>0 AND created_at>=? ORDER BY conversation_message_id DESC LIMIT 100')
      .all(context.peerId, chapter.title, '\nЧасть ' + partNumber + '\n\n', Math.max(0, Number(publication?.created_at || 0) - 5));
    id = findLatestChtivoPartConversationMessageId(archivedParts, chapter.title, {
      partNumber, bookTitle: book.title,
      body: publication ? chapter.body.slice(publication.start_offset, publication.end_offset) : '',
    });
  }
  if (id) {
    db.prepare('UPDATE chtivo_progress SET last_text_message_id=? WHERE peer_id=? AND book_id=?').run(id, context.peerId, book.id);
    if (publication) db.prepare('UPDATE chtivo_publications SET message_id=? WHERE id=?').run(id, publication.id);
  }
  return id;
}

async function publish(context, book, progress, maxMode) {
  if (progress.chapter_completed) return { sent: false, text: 'Эта глава уже закончена. Новую можно начать командой «чтиво новая глава».' };
  let chapter = db.prepare('SELECT * FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(book.id, progress.chapter_order);
  if (!chapter) return { sent: false, text: 'Книга прочитана полностью. Выбрать другую можно командой «чтиво список».' };
  const remaining = chapter.body.slice(progress.chapter_offset); if (!remaining) return { sent: false, text: 'Эта глава уже закончена. Новая глава будет доступна на следующий день.' };
  let lastId = previousReadingPartId(context, book, chapter, progress);
  if (progress.chapter_offset > 0 && !lastId) {
    throw new Error('Чтиво: не найдено сообщение предыдущей части главы; продолжение ожидает восстановления цепочки');
  }
  const sameDayContinuation = progress.chapter_offset > 0 && progress.chapter_started_day === dayKey();
  const formatPrefix = partNumber => progress.chapter_offset === 0 && partNumber === progress.part_number
    ? '«' + book.title + '»\n' + chapter.title + '\nЧасть ' + partNumber + '\n\n'
    : chapter.title + (sameDayContinuation ? '\nГигорейв чтиво — продолжение за сегодня' : '') + '\nЧасть ' + partNumber + '\n\n';
  // Reserve enough room for the longest realistic part number. This keeps the
  // hard 4096-character limit valid when a chapter crosses from part 9 to 10
  // (or any later digit boundary).
  const headerReserve = formatPrefix(999999999).length;
  const bodyCapacity = Math.min(BODY_TARGET_LIMIT, PLATFORM_MESSAGE_LIMIT - headerReserve);
  const hardBodyCapacity = PLATFORM_MESSAGE_LIMIT - headerReserve;
  let chunks = splitBody(remaining, bodyCapacity, hardBodyCapacity); let count = Math.max(1, Math.min(maxMode, chunks.length));
  count = Math.min(2, count);
  // Up to two regular parts, plus the final tail (at most 25% of the VK limit).
  if (chunks.length === count + 1 && chunks.at(-1).length <= TAIL_LIMIT) count += 1;
  let offset = progress.chapter_offset;
  for (let i = 0; i < count; i += 1) {
    const partPrefix = formatPrefix(progress.part_number);
    const text = partPrefix + chunks[i];
    if (text.length > PLATFORM_MESSAGE_LIMIT) throw new Error('Чтиво сообщение превышает лимит VK: ' + text.length);
    const replyTo = lastId || undefined;
    const sentAt = Math.floor(Date.now() / 1000);
    const randomId = chtivoPartRandomId(context.peerId, book.id, progress.chapter_order, progress.part_number);
    const sent = await sendReadingPart(context, text, {
      random_id: randomId,
      ...(replyTo ? { replyWithForwardConversationMessageId: replyTo } : {}),
    });
    // VK may return only a regular message_id (or a MessageContext with that
    // id) even though replies in a conversation require conversation_message_id.
    // Resolve it immediately through messages.getById so the next part can
    // always quote the exact preceding bot part.
    let id = await resolveChtivoConversationMessageId(context.api, sent);
    if (!id) id = Number(sent?.conversationMessageId ?? sent?.conversation_message_id ?? 0);
    for (let attempt = 0; !id && attempt < 8; attempt += 1) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
      id = findSentCmid(context.peerId, text, sentAt);
    }
    const end = offset + chunks[i].length; offset = end; lastId = id; progress.part_number += 1;
    const done = offset >= chapter.body.length;
    db.prepare('INSERT OR REPLACE INTO chtivo_publications(peer_id,book_id,chapter_order,part_number,start_offset,end_offset,message_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(context.peerId, book.id, progress.chapter_order, progress.part_number - 1, end - chunks[i].length, end, id, 'sent', Math.floor(Date.now()/1000));
    db.prepare('INSERT OR REPLACE INTO chtivo_progress(peer_id,book_id,chapter_order,chapter_offset,part_number,last_text_message_id,max_mode,chapter_started_day,chapter_completed,active,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(context.peerId, book.id, progress.chapter_order + (done ? 1 : 0), done ? 0 : offset, progress.part_number, lastId, maxMode, progress.chapter_started_day || dayKey(), done ? 1 : 0, 1, Number(progress.version || 0) + 1, Math.floor(Date.now()/1000));
    console.log('[CHTIVO PART SENT]', JSON.stringify({ peerId: context.peerId, bookId: book.id, chapter: progress.chapter_order, part: progress.part_number - 1, conversationMessageId: lastId, replyTo: replyTo || 0 }));
    if (!lastId) {
      console.warn('[CHTIVO REPLY RECEIPT MISSING]', context.peerId, book.id, progress.chapter_order, progress.part_number - 1);
      // Keep the delivered cursor; do not repeat it or send an unthreaded continuation.
      return { sent: true, done, pendingReply: !done };
    }
    await sendReadingPart(context, done
      ? 'Глава закончена. Следующая глава придёт завтра по расписанию.'
      : 'Продолжение этой главы придёт по расписанию. Чтобы прочитать его сейчас, напиши «чтиво далее».',
    lastId ? { replyWithForwardConversationMessageId: lastId } : undefined);
  }
  const done = offset >= chapter.body.length;
  return { sent: true, done };
}


async function handleChtivoCommandLocked(context, input) {
  const text = String(input || '').trim(); const m = text.match(/^чтиво(?:\s+(.+?))?[.!?]*$/iu); if (!m) return false;
  const arg = String(m[1] || '').trim();
  if (/^список$/iu.test(arg)) { const list = books(); await context.send(list.length ? list.map(b => `${b.catalog_no}. ${b.title}${b.author ? ` — ${b.author}` : ''}`).join('\n') : 'Каталог книг пуст.'); return true; }
  if (/^выкл$/iu.test(arg)) { db.prepare('UPDATE chtivo_progress SET active=0,updated_at=? WHERE peer_id=?').run(Math.floor(Date.now()/1000), context.peerId); db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(context.peerId); await context.send('Чтиво приостановлено. Прогресс сохранён.'); return true; }
  if (/^вкл$/iu.test(arg)) { const b = db.prepare('SELECT b.* FROM chtivo_progress p JOIN chtivo_books b ON b.id=p.book_id WHERE p.peer_id=? ORDER BY p.updated_at DESC LIMIT 1').get(context.peerId); if (!b) { await context.send('Сначала выбери книгу: «чтиво список».'); return true; } const p=getProgress(context.peerId,b.id)||{chapter_order:0,chapter_offset:0,part_number:1,last_text_message_id:0,version:0,max_mode:1}; db.prepare('UPDATE chtivo_progress SET active=0 WHERE peer_id=?').run(context.peerId); db.prepare('UPDATE chtivo_progress SET active=1 WHERE peer_id=? AND book_id=?').run(context.peerId,b.id); db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(context.peerId); if (ensureDailyGreeting(context)) await context.send(formatChtivoIntroduction(b)); const r=await publish(context,b,p,p.max_mode||1); if (r.sent) scheduleFollowing(context.peerId,b.id); else await context.send(r.text); return true; }
  if (/^новая\s+глава$/iu.test(arg)) {
    const book = activeBook(context.peerId);
    if (!book) { await context.send('Сначала выбери книгу: «чтиво список».'); return true; }
    const progress = getProgress(context.peerId, book.id);
    if (!progress?.chapter_completed) {
      await context.send('Сначала дочитай текущую главу. Команда «чтиво далее» продолжает только её.');
      return true;
    }
    const nextChapter = db.prepare('SELECT 1 FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(book.id, progress.chapter_order);
    if (!nextChapter) { await context.send('Книга прочитана полностью. Выбрать другую можно командой «чтиво список».'); return true; }
    db.prepare('UPDATE chtivo_progress SET chapter_completed=0,chapter_offset=0,part_number=1,last_text_message_id=0,chapter_started_day=?,updated_at=? WHERE peer_id=? AND book_id=?')
      .run(dayKey(), Math.floor(Date.now() / 1000), context.peerId, book.id);
    const nextProgress = getProgress(context.peerId, book.id);
    const result = await publish(context, book, nextProgress, nextProgress.max_mode || 1);
    if (result.sent) scheduleFollowing(context.peerId, book.id);
    else await context.send(result.text);
    return true;
  }
  if (/^(?:далее|отправить)$/iu.test(arg)) {
    const b=activeBook(context.peerId);
    if(!b){await context.send('Сначала выбери книгу: «чтиво список».');return true;}
    let p=getProgress(context.peerId,b.id);
    if(!p){await context.send('Сначала выбери книгу: «чтиво список».');return true;}
    if (p.chapter_completed) {
      await context.send('Эта глава уже закончена. Следующая глава будет доступна завтра.');
      return true;
    }
    const r=await publish(context,b,p,1);
    if(r.sent) scheduleFollowing(context.peerId,b.id);
    if (!r.sent) await context.send(r.text);
    return true;
  }
  const modeMatch = arg.match(/\s+макс\s+([12])$/iu); const maxMode = Number(modeMatch?.[1] || 1); const value = arg.replace(/\s+макс\s+[12]$/iu,'').trim(); const selected=choose(value); if (selected?.ambiguous) { await context.send('Уточни книгу:\n'+selected.ambiguous.map(b=>`${b.catalog_no}. ${b.title}`).join('\n')); return true; } if (!selected) { await context.send('Книга не найдена. Напиши «чтиво список».'); return true; }
  let p=getProgress(context.peerId,selected.id);
  // Repeating the same selection must not create an extra immediate drop.
  if (p?.active && Number(p.max_mode || 1) === maxMode) {
    await context.send('Книга «' + selected.title + '» уже включена. Прогресс и расписание сохранены.');
    return true;
  }
  db.prepare('UPDATE chtivo_progress SET active=0 WHERE peer_id=?').run(context.peerId); db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(context.peerId); if(!p) { p={peer_id:context.peerId,book_id:selected.id,chapter_order:0,chapter_offset:0,part_number:1,last_text_message_id:0,max_mode:maxMode,chapter_started_day:dayKey(),chapter_completed:0,active:1,version:0}; db.prepare('INSERT INTO chtivo_progress(peer_id,book_id,chapter_order,chapter_offset,part_number,last_text_message_id,max_mode,chapter_started_day,chapter_completed,active,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(context.peerId,selected.id,0,0,1,0,maxMode,dayKey(),0,1,0,Math.floor(Date.now()/1000)); } else { db.prepare('UPDATE chtivo_progress SET active=1,max_mode=?,updated_at=? WHERE peer_id=? AND book_id=?').run(maxMode,Math.floor(Date.now()/1000),context.peerId,selected.id); p=getProgress(context.peerId,selected.id); } if (ensureDailyGreeting(context)) await context.send(formatChtivoIntroduction(selected)); const r=await publish(context,selected,p,maxMode); if (r.sent) scheduleFollowing(context.peerId, selected.id); else await context.send(r.text); return true;
}

const peerLocks = new Set();
const liveContexts = new Map();
let schedulerTimer = null;
let schedulerTransport = null;
let schedulerTickRunning = false;
export function configureChtivoScheduler(transport) {
  schedulerTransport = transport && typeof transport.send === 'function' ? transport : null;
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => schedulerTick().catch(error => console.error('[CHTIVO SCHEDULER TICK]', error)), 30_000);
    schedulerTimer.unref?.();
  }
  if (schedulerTransport) restoreChtivoSchedules();
  void schedulerTick().catch(error => console.error('[CHTIVO SCHEDULER TICK]', error));
}
function schedulerContext(peerId, bookId) {
  const live = liveContexts.get(Number(peerId));
  if (live) return live;
  if (!schedulerTransport) return null;
  return {
    peerId: Number(peerId),
    send: (message, params = {}) => schedulerTransport.send({
      peerId: Number(peerId),
      bookId: Number(bookId),
      message: String(typeof message === 'object' ? message.message : message),
      replyTo: Number(params?.replyWithForwardConversationMessageId || params?.replyToConversationMessageId || 0) || 0,
      // The scheduler must reply to the bot's last *conversation* message.
      // `messages.send` accepts a conversation message id here; retaining the
      // value in the durable progress row lets a restart continue the thread.
      randomId: Number(params?.random_id || 0) || 0,
    }),
  };
}
function randomBetween(min, max) { return min + Math.floor(Math.random() * Math.max(1, max - min + 1)); }
function nextDropAt(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const start = hour >= 16 ? 16 * 60 + 1 : Math.max(10 * 60, hour * 60 + 2);
  const end = hour >= 16 ? 22 * 60 + 30 : 22 * 60;
  const minutes = randomBetween(Math.min(start + 1, end), end);
  const base = new Date(now);
  const utc = new Date(base.toLocaleString('en-US', { timeZone: TZ }));
  utc.setHours(0, 0, 0, 0); utc.setMinutes(minutes);
  const offset = utc.getTime() - new Date(base.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const result = new Date(utc.getTime() + offset);
  if (result.getTime() <= Date.now()) result.setDate(result.getDate() + 1);
  return Math.floor(result.getTime() / 1000);
}
function nextDropAtForChapter(now, remainingParts) {
  if (remainingParts <= 0) return scheduleNextDay(now);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  const nowMinute = hour * 60 + minute;
  let start = hour >= 16 ? Math.max(nowMinute + 1, 16 * 60) : Math.max(nowMinute + 1, 10 * 60);
  let end = hour >= 16 ? 22 * 60 + 30 : (remainingParts >= 3 ? 22 * 60 : 17 * 60);
  if (start >= end) return scheduleNextDay(now);
  return scheduleWithinToday(now, start, end);
}
function scheduleNextDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day) + 1));
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 10, randomBetween(0, 59));
  return wallClockToEpoch(wall);
}
function wallClockToEpoch(wallClockUtc) {
  const date = new Date(wallClockUtc);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const actualWall = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
  return Math.floor((wallClockUtc - (actualWall - wallClockUtc)) / 1000);
}
function scheduleWithinToday(now, startMinute, endMinute) {
  const minute = randomBetween(startMinute, endMinute);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return wallClockToEpoch(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Math.floor(minute / 60), minute % 60));
}
function scheduleNext(peerId, bookId, remainingParts = 1) {
  const due = nextDropAtForChapter(new Date(), remainingParts);
  db.prepare('INSERT OR REPLACE INTO chtivo_schedule(peer_id,book_id,due_at,updated_at) VALUES(?,?,?,?)').run(peerId, bookId, due, Math.floor(Date.now() / 1000));
}
function scheduleRemainingToday(peerId, bookId) {
  const progress = getProgress(peerId, bookId);
  if (!progress?.active || progress.chapter_completed) {
    db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(peerId);
    return;
  }
  const chapter = db.prepare('SELECT body FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(bookId, progress.chapter_order);
  const chunks = chapter ? splitBody(chapter.body.slice(progress.chapter_offset)).length : 0;
  if (chunks <= 0) {
    db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(peerId);
    return;
  }
  scheduleNext(peerId, bookId, chunks);
}
function scheduleFollowing(peerId, bookId) {
  const progress = getProgress(peerId, bookId);
  if (!progress?.active) return;
  if (progress.chapter_completed) {
    const next = db.prepare('SELECT 1 FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(bookId, progress.chapter_order);
    if (!next) { db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(peerId); return; }
    const now = new Date();
    const completedDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(progress.updated_at * 1000));
    const due = completedDay === dayKey() ? scheduleNextDay(now) : nextDropAtForChapter(now, 1);
    db.prepare('INSERT OR REPLACE INTO chtivo_schedule(peer_id,book_id,due_at,updated_at) VALUES(?,?,?,?)').run(peerId, bookId, due, Math.floor(Date.now()/1000));
    return;
  }
  const chapter = db.prepare('SELECT body FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(bookId, progress.chapter_order);
  const chunks = chapter ? splitBody(chapter.body.slice(progress.chapter_offset)).length : 0;
  scheduleNext(peerId, bookId, Math.ceil(chunks / Math.max(1, Number(progress.max_mode) || 1)));
}
function restoreChtivoSchedules() {
  // Recover durable active subscriptions after restart, without sending immediately
  // or re-enabling chats explicitly paused by their readers.
  const rows = db.prepare('SELECT p.peer_id,p.book_id FROM chtivo_progress p JOIN chtivo_books b ON b.id=p.book_id WHERE p.active=1 AND b.enabled=1 AND NOT EXISTS (SELECT 1 FROM chtivo_schedule s WHERE s.peer_id=p.peer_id)').all();
  for (const row of rows) scheduleFollowing(row.peer_id, row.book_id);
  console.log('[CHTIVO SCHEDULE RESTORED]', JSON.stringify(rows));
}
async function schedulerTick() {
  if (schedulerTickRunning) return;
  schedulerTickRunning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const row of db.prepare('SELECT * FROM chtivo_schedule WHERE due_at<=? ORDER BY due_at').all(now)) {
      const peerId = Number(row.peer_id);
      const context = schedulerContext(peerId, row.book_id);
      if (!context || peerLocks.has(peerId)) continue;
      peerLocks.add(peerId);
      try {
        db.prepare('DELETE FROM chtivo_schedule WHERE peer_id=?').run(peerId);
        const book = db.prepare('SELECT * FROM chtivo_books WHERE id=? AND enabled=1').get(row.book_id);
        let progress = book && getProgress(peerId, row.book_id);
        if (!book || !progress || !progress.active) continue;
        if (progress.chapter_completed) {
          const completedDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(progress.updated_at * 1000));
          if (completedDay === dayKey()) { scheduleFollowing(peerId, row.book_id); continue; }
          if (!db.prepare('SELECT 1 FROM chtivo_chapters WHERE book_id=? AND chapter_order=?').get(row.book_id, progress.chapter_order)) continue;
          db.prepare('UPDATE chtivo_progress SET chapter_completed=0,chapter_offset=0,part_number=1,last_text_message_id=0,chapter_started_day=?,updated_at=? WHERE peer_id=? AND book_id=?')
            .run(dayKey(), now, peerId, row.book_id);
          progress = getProgress(peerId, row.book_id);
        }
        if (ensureDailyGreeting(context)) await context.send(formatChtivoIntroduction(book));
        const result = await publish(context, book, progress, progress.max_mode || 1);
        if (result.sent) scheduleFollowing(peerId, row.book_id);
        else if (result.text) await context.send(result.text);
      } catch (error) {
        console.error('[CHTIVO SCHEDULER ERROR]', error);
        scheduleNext(peerId, row.book_id, 1);
      } finally {
        peerLocks.delete(peerId);
      }
    }
  } finally {
    schedulerTickRunning = false;
  }
}
function registerContext(context) {
  liveContexts.set(Number(context.peerId), context);
  if (!schedulerTimer) configureChtivoScheduler(null);
}
export async function handleChtivoCommand(context, input) {
  const match = String(input || '').trim().match(/^чтиво(?:\s+(.+?))?[.!?]*$/iu);
  if (!match) return false;
  const peerId = Number(context.peerId);
  if (!Number.isSafeInteger(peerId) || peerId <= 0) return false;
  if (peerLocks.has(peerId)) { await context.send('Предыдущая команда чтива ещё обрабатывается. Повтори её через несколько секунд.'); return true; }
  peerLocks.add(peerId);
  registerContext(context);
  try { return await handleChtivoCommandLocked(context, input); }
  finally { peerLocks.delete(peerId); }
}

export const chtivoInternals = Object.freeze({ normalize, splitBody, splitChapters, dayKey });
