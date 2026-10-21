import assert from 'node:assert/strict';
import {
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';
import {
    detectExplicitApplicationCommand,
} from '../../src/features/routing/explicitApplicationCommand.js';

const commands = [
    'резюмируй за неделю',
    'досье Иван',
    'полное досье Иван',
    'кто вышел сегодня',
    'подтяни историю 2 дня',
    'лс участникам привет',
    'проверить тусы на совпадения',
    'вернуть тусу концерт',
    'чёрный список тус',
    'ключи проверить все',
    'проверить рабочие модели',
    'третий обход моделей',
    'создай pdf документ файлом: отчёт за неделю',
    'парсер все чисто',
    'лимиты сбросить',
];

for (const command of commands) {
    assert.equal(detectExplicitApplicationCommand(command).matched, true, command);
    for (const pendingAction of ['image', 'image_edit', 'document_pdf', 'propose_event', 'add_event']) {
        const result = resolveTelegramMenuInput(command, { pendingAction }, { isOwner: true });
        assert.equal(result.type, 'command', `${pendingAction}: ${command}`);
        assert.equal(result.text, command, `${pendingAction}: ${command}`);
        assert.equal(result.state.pendingAction, '', `${pendingAction}: ${command}`);
    }
}

const ordinary = resolveTelegramMenuInput('кот в космосе', { pendingAction: 'image' }, { isOwner: true });
assert.equal(ordinary.type, 'command');
assert.equal(ordinary.text, 'нарисуй кот в космосе');
