# Важно: двухминутное закрытие Cloudflare лечится на стороне роутера

Код бота может наблюдать приходящие байты, но НЕ может отправить `: ping` в уже открытый HTTP-ответ сервера. Локальный таймер, сообщение в Telegram, исходящий TCP keepalive или повторный HTTP GET на другом соединении НЕ сохраняют молчаливый downstream SSE-ответ от роутера через Cloudflare.

Если Cloudflare закрывает HTTP-ответ после ~120 секунд без полезных байтов, в **самом роутере**, до того как он начинает ожидать модель, необходимо:

1. Сразу вернуть HTTP 200, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; отключить сжатие/буферизацию на всех промежуточных прокси; отправить заголовки.
2. Каждые 20–30 секунд ПИШИТЕ В ТОТ ЖЕ downstream-ответ (от роутера к боту) настоящие байты `: keepalive\n\n` и немедленно сбрасывайте буфер. SSE-комментарий не является токеном модели и не должен добавляться в ответ/usage.
3. Между heartbeat передавайте только реальные события модели. По окончании модельного запроса высылайте настоящие завершение и usage, выключайте heartbeat и закрывайте поток. При ошибке не изобретайте `finish_reason: stop` или `[DONE]` и не выдавайте частичный текст как полный ответ.
4. Не делайте второй POST к модели при обрыве: роутер должен долговременно сохранять idempotency key, ID инференса, статус и завершённый ответ и предоставить GET/status на **ту же** операцию. Если внутренняя связь роутер→провайдер также прерывается, downstream heartbeat этого не исправит; нужна отдельная поддержка возобновления/фонового выполнения upstream.

Пример только для адаптации к действительному Node HTTP/Express endpoint **на стороне роутера**:

```js
res.status(200);
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
res.setHeader('Cache-Control', 'no-cache, no-transform');
res.setHeader('X-Accel-Buffering', 'no');
res.flushHeaders?.();
res.write(': connected\n\n');
const beat = setInterval(() => {
  if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
}, 25_000);
res.on('close', () => clearInterval(beat));
try {
  // Передавайте настоящие upstream SSE-данные. Не буферизуйте до конца модели.
  for await (const realSseFrame of providerFrames) {
    if (res.destroyed) break;
    res.write(realSseFrame);
  }
} finally {
  clearInterval(beat);
  if (!res.writableEnded) res.end();
}
```

Этот шаблон не является патчем к не предоставленному исходному коду роутера и не гарантирует работу конкретной конфигурации Cloudflare, если прокси буферизует/переписывает SSE. Проверка: тестовый запрос с паузой модели > 180 секунд, раз в 25–30 секунд в том же HTTP-ответе получаются `: keepalive`, а `GPT FINISH` появляется только при настоящем завершении модели.
