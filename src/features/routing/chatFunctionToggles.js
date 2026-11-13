const ACTIONS = Object.freeze({
 'выключ':'disable','выкл':'disable','выключить':'disable','выключи':'disable','откл':'disable','отключить':'disable','отключи':'disable','off':'disable',
 'включ':'enable','вкл':'enable','включить':'enable','включи':'enable','on':'enable',
});
export const CHAT_FUNCTIONS_STATE_PREFIX = 'chat-functions-v1:';
export function parseChatFunctionToggle(input) {
 const text=String(input||'').trim().toLowerCase().replace(/ё/gu,'е')
  .replace(/^(?:гигорейв|гигарейв|gigorave)(?:[\s,:.!—-]+|$)/u,'')
  .replace(/[!?.,]+$/gu,'').trim().replace(/\s+/gu,' ');
 const normalized=text.replace(/(^|\s)статистику(?=\s|$)/gu,'$1статистика');
 const feature='(?:тусы|тусовки|тусовки\\s+в\\s+чате|статистика|статы|статистика\\s+(?:сообщений|реакций|лайков|по\\s+сообщениям\\s+и\\s+реакциям))';
 const action='(?:выключ|выкл|выключить|выключи|откл|отключить|отключи|off|включ|вкл|включить|включи|on)';
 const direct=normalized.match(new RegExp('^('+feature+')\\s+('+action+')$','u'));
 const reversed=normalized.match(new RegExp('^('+action+')\\s+('+feature+')$','u'));
 const name=direct?.[1]||reversed?.[2],word=direct?.[2]||reversed?.[1];
 if(!name||!word)return null;
 return {kind:/^тус/u.test(name)?'parties':'statistics',action:ACTIONS[word]};
}
export function chatFunctionsStateKey(platform,externalPeerId){
 return CHAT_FUNCTIONS_STATE_PREFIX+String(platform||'vk').toLowerCase()+':'+String(externalPeerId||'').trim();
}
export function normalizeChatFunctionsState(data){
 return {partiesEnabled:data?.partiesEnabled!==false,statisticsEnabled:data?.statisticsEnabled!==false};
}
export const partyDisabledResponse='🎸 Выдача тусов в этом чате выключена. Чтобы включить её, напишите «тусы вкл» или «тусы включить».';
export const statisticsDisabledResponse='📊 Автоматическая статистика сообщений и реакций в этом чате выключена. Чтобы включить: «статистика вкл» или «статистика включить».';
export const autoSummaryCommandExamples=[
 'Примеры настроек авторезюме (каждая новая команда с часами полностью заменяет прежнее расписание):',
 '• авторезюме вкл / авторезюме включить — включить последнее сохранённое расписание;',
 '• авторезюме выкл / авторезюме выключить — отключить отправку, сохранить расписание;',
 '• авторезюме статус — показать часы и режим;',
 '• авторезюме шаблон / авторезюме расписание — показать способы настройки;',
 '• авторезюме 12:00 вкл — один отрезок за день с 00:00 до 12:00;',
 '• авторезюме 09:00 17:00 21:00 23:59 вкл — непересекающиеся отрезки;',
 '• авторезюме 12:00 дневное — отрезок до 12:00 и отдельный итог в полночь;',
 '• авторезюме 12:00 13:00 15:00 18:00 дневное недельное — заменить предыдущее расписание;',
 '• авторезюме 09:00 17:00 21:00 23:59 дневное недельное 20:00 месячное 18:00 среднее вкл;',
 '• авторезюме недельное — воскресенье 20:00 (можно задать другое время);',
 '• авторезюме месячное — последний день месяца 18:00 (можно задать другое время);',
 '• авторезюме средне / авторезюме среднее — короткий текст, максимум 2048 символов ВК;',
 '• авторезюме сейчас — создать контрольную сводку сейчас (если включено).',
].join('\n');
