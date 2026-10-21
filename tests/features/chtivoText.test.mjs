import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { filterChtivoTextBooks, matchChtivoBookQuery, normalizeChtivoText, renumberChtivoBooks, splitChtivoChapters } from '../../src/features/chtivo/chtivoText.js';

const source = readFileSync(new URL('../../chtivo/Низший пилотаж — Баян Ширянов.txt', import.meta.url), 'utf8');

test('book markers split into titled chapters without losing prose', () => {
  const chapters = splitChtivoChapters(source);
  assert.equal(chapters.length, 54);
  assert.equal(chapters[0].title, 'Подержи зеркало');
  assert.ok(chapters[0].body.startsWith('Баян Ширянов'));
  assert.ok(chapters.some(chapter => chapter.title.includes('Марафон')));
  assert.ok(chapters.every(chapter => chapter.body.length > 0));
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
