import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatChtivoIntroduction } from '../../src/features/chtivo/chtivoIntro.js';

test('first chitivo message uses the selected book title and the supplied annotation', () => {
  const message = formatChtivoIntroduction({ title: 'Низший пилотаж' });
  assert.ok(message.startsWith(
    'С вами рубрика Гигорейв чтиво.\n\nВам будет представлен отрывок из произведения «Низший пилотаж».\n\nПриятного прочтения.\n\nКраткая аннотация :\n\n',
  ));
  assert.ok(message.includes('Баян Ширянов (настоящее имя — Кирилл Воробьёв, 1964–2017)'));
  assert.ok(message.includes('впервые опубликованный в интернете в 1996 году'));
  assert.ok(message.includes('галлюцинациях и постепенном разрушении личности'));
  assert.ok(message.includes('одни считали её смелым литературным экспериментом, другие обвиняли в пропаганде наркотиков'));
  assert.ok(message.endsWith('продолженной произведениями «Срединный пилотаж» и «Верховный пилотаж».'));
  assert.ok(!message.includes('какого-то литературного'));
  assert.ok(message.length < 4096);
});

test('other titles are substituted without inventing an annotation', () => {
  const message = formatChtivoIntroduction({ title: 'Другое произведение' });
  assert.ok(message.includes('отрывок из произведения «Другое произведение».'));
  assert.ok(message.includes('Приятного прочтения.'));
  assert.ok(!message.includes('Низший пилотаж'));
  assert.ok(!message.includes('Краткая аннотация'));
});

test('all three paths (start, resume, scheduled publication) use the same introduction', () => {
  const source = readFileSync(new URL('../../src/features/chtivo/chtivo.js', import.meta.url), 'utf8');
  assert.equal((source.match(/context\.send\(formatChtivoIntroduction\(/g) || []).length, 3);
  assert.ok(!source.includes('какого-то литературного произведения'));
});
