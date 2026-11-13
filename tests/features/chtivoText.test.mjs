import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { filterChtivoTextBooks, matchChtivoBookQuery, normalizeChtivoText, renumberChtivoBooks, splitChtivoBody, splitChtivoChapters } from '../../src/features/chtivo/chtivoText.js';

const source = readFileSync(new URL('../../chtivo/Низший пилотаж — Баян Ширянов.txt', import.meta.url), 'utf8');

test('book markers split into titled chapters without losing prose', () => {
  const chapters = splitChtivoChapters(source);
  assert.equal(chapters.length, 29);
  assert.equal(chapters[0].title, 'Подержи зеркало');
  assert.ok(chapters[0].body.includes('Баян Ширянов'));
  assert.ok(chapters[1].title === 'Марафон');
  assert.ok(chapters[1].body.includes('День первый'));
  assert.ok(chapters.some(chapter => chapter.title.startsWith('Заморочка 6')));
  const reconstructed = chapters.map(chapter => chapter.body).join('\n');
  assert.ok(reconstructed.includes('НИЗШИЙ ПИЛОТАЖ'));
  assert.ok(reconstructed.includes('Подержи зеркало'));
  assert.ok(!reconstructed.includes('[[ГЛАВА:'));
});

test('normalization is stable for Windows line endings and trailing spaces', () => {
  assert.equal(normalizeChtivoText('  строка  \r\nтекст \r'), 'строка\nтекст');
});

test('visible TXT books receive consecutive catalog numbers independent of old ids', () => {
  const visible = renumberChtivoBooks([
    { id: 3, catalog_no: 3, title: 'Низший пилотаж' },
  ]);
  assert.deepEqual(visible.map(({ catalog_no, title }) => ({ catalog_no, title })), [
    { catalog_no: 1, title: 'Низший пилотаж' },
  ]);
});

test('catalog excludes DOC imports and TXT records whose source file is gone', () => {
  const entries = [
    { id: 1, path: 'C:\\library\\book.doc' },
    { id: 2, path: 'C:\\library\\removed.txt' },
    { id: 3, path: 'C:\\library\\current.txt' },
  ];
  assert.deepEqual(
    filterChtivoTextBooks(entries, ['C:/library/current.txt']).map(({ id }) => id),
    [3],
  );
});

test('book selection matches any title fragment, numbered display titles, and author text', () => {
  const catalog = [{ catalog_no: 1, title: 'Низший пилотаж', author: 'Баян Ширянов' }];
  assert.equal(matchChtivoBookQuery(catalog, 'пилотаж'), catalog[0]);
  assert.equal(matchChtivoBookQuery(catalog, 'низший пилотаж'), catalog[0]);
  assert.equal(matchChtivoBookQuery(catalog, '1. Низший пилотаж — Баян Ширянов'), catalog[0]);
  assert.equal(matchChtivoBookQuery(catalog, 'Ширянов'), catalog[0]);
});

test('book selection reports ambiguous partial title matches', () => {
  const catalog = [
    { title: 'Низший пилотаж', author: 'Баян Ширянов' },
    { title: 'Пилотаж', author: 'Другой автор' },
  ];
  assert.deepEqual(matchChtivoBookQuery(catalog, 'пилотаж').ambiguous, catalog);
});

test('book selection tolerates one or two title typos', () => {
  const books = [{ catalog_no: 1, title: 'Низший пилотаж', author: 'Баян Ширянов' }];
  assert.equal(matchChtivoBookQuery(books, 'низжий пилотаж')?.catalog_no, 1);
  assert.equal(matchChtivoBookQuery(books, 'нижший пилотаж')?.catalog_no, 1);
});

test('body splitting preserves paragraphs and never exceeds the final message budget', () => {
  const input = 'Заголовок\n\n' + 'Первое предложение. Второе предложение!'.repeat(48) + '\n\n' + 'Следующий абзац. '.repeat(180);
  const chunks = splitChtivoBody(input, 330, 360);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), normalizeChtivoText(input));
  assert.ok(chunks.every(chunk => chunk.length <= 360));
  assert.ok(chunks.every(chunk => !/\b(?:предложе|абзац)$/u.test(chunk)));
});

test('short subsection headings stay attached to the following prose', () => {
  const chunks = splitChtivoBody('Марафон. День первый\n\nДЕНЬ ПЕРВЫЙ.\n\nУтро.\n\nТекст абзаца.\n\nДЕНЬ ВТОРОЙ.\n\nВечер.\n\nДругой текст.', 4096, 4096);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].indexOf('Утро.') < chunks[0].indexOf('Текст абзаца.'));
  assert.ok(chunks[0].indexOf('ДЕНЬ ВТОРОЙ.') < chunks[0].indexOf('Другой текст.'));
});
