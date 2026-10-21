import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/app/botApplication.js', import.meta.url), 'utf8');

test('V150 image summary uses dedicated full-coverage visual digest', () => {
    assert.match(source, /createGptImageConversationDigest/);
    assert.match(source, /Учитывай ВЕСЬ переданный фрагмент/);
    assert.match(source, /5–8 самостоятельных тем\/мотивов/);
    assert.match(source, /8–14 конкретных визуальных якорей/);
    assert.match(source, /6–12 конкретных визуальных якорей/);
    assert.match(source, /Главная цель — передать СУТЬ ВСЕГО периода/);
});

test('V150 does not erase sensitive themes from semantic coverage', () => {
    assert.match(source, /не вычеркивай из общего настроения/);
    assert.match(source, /передавай безопасными метафорами/);
    assert.doesNotMatch(source, /Полностью исключи имена, никнеймы, внешность реальных людей, личные данные, ругань/);
});
