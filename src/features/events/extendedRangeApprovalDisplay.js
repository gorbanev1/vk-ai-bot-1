const safeName=(value,fallback)=>{
 const text=String(value||'').trim().replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').slice(0,120);
 return text&&!/^(?:-?\d+|(?:vk|tg|telegram):\d+|id\s*\d+)$/iu.test(text)?text:fallback;
};
export function approvalDisplayNames(record){
 return {
  chatName:safeName(record?.chatTitle,'Название беседы недоступно'),
  requesterName:safeName(record?.requesterName,'Участник беседы (имя недоступно)'),
  platformName:record?.platform==='telegram'?'Telegram':'ВКонтакте',
 };
}
export function formatExtendedRangeOwnerRequest(record,{decision=''}={}){
 const {chatName,requesterName,platformName}=approvalDisplayNames(record);
 return [
  '📅 Запрос на расширенную афишу',
  '💬 Беседа: «'+chatName+'» ('+platformName+')',
  '👤 Запросил: '+requesterName,
  '🗓 Период: '+String(record?.range?.fromDate||'?')+' — '+String(record?.range?.toDate||'?'),
  'Запрошена афиша за пределами стандартной недели.',
  'Решение действует окончательно: после первого нажатия изменить его нельзя.',
  ...(decision?['','Решение: '+decision]:[]),
 ].join('\n');
}
export function formatExtendedRangeGroupDecision(record){
 const {requesterName}=approvalDisplayNames(record),range=record?.range||{};
 const dates=String(range.fromDate||'?')+' — '+String(range.toDate||'?');
 const approved=!['denied'].includes(String(record?.status||''));
 return approved
  ?'✅ Владелец разрешил расширенную афишу по запросу '+requesterName+'.\nПериод: '+dates+'.\nНачинаю выдачу событий.'
  :'⛔ Владелец отклонил запрос '+requesterName+' на расширенную афишу.\nПериод: '+dates+'.\nВыдача за этот период не будет запущена.';
}
export function formatExtendedRangeDecisionAlready(status){
 return status==='denied'?'Уже отказано. Решение окончательное.'
 :['approved','delivered','delivery-failed'].includes(status)?'Уже разрешено. Решение окончательное.'
 :status==='pending'?'Решение ещё ожидается.':'Запрос завершён.';
}
