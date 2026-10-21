import 'dotenv/config';
import { readFile } from 'node:fs/promises';
const imagePath = process.argv[2];
const bytes = await readFile(imagePath);
const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const imageUrl = `data:${mime};base64,${bytes.toString('base64')}`;
const body = { model: 'gpt-6-luna', messages: [{ role: 'user', content: [
  { type: 'text', text: 'Прочитай афишу. Укажи название, дату, время и место. Не угадывай.' },
  { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
] }], stream: true, max_tokens: 250 };
const started = Date.now();
try {
  const response = await fetch('https://router.cheap/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  const headerIds = Object.fromEntries(['x-request-id','request-id','cf-ray','x-router-request-id'].map((name) => [name, response.headers.get(name)]).filter(([, value]) => value));
  const reader = response.body?.getReader();
  let pending = ''; let count = 0; let shapes = []; let errors = []; let firstMs = 0; let textChars = 0; let finish = ''; let usage = null;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const line = block.split('\n').find((part) => part.startsWith('data:')); if (!line) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === '[DONE]') continue;
        try {
          const event = JSON.parse(raw); count++; if (!firstMs) firstMs = Date.now() - started;
          if (shapes.length < 2) shapes.push({ keys: Object.keys(event), choiceKeys: Object.keys(event.choices?.[0] || {}), deltaKeys: Object.keys(event.choices?.[0]?.delta || {}), errorKeys: Object.keys(event.error || {}) });
          if (event.error) errors.push(event.error);
          textChars += String(event.choices?.[0]?.delta?.content || '').length;
          finish = event.choices?.[0]?.finish_reason || finish; usage = event.usage || usage;
        } catch {}
      }
    }
  }
  console.log(JSON.stringify({ http: response.status, elapsedMs: Date.now()-started, firstEventMs: firstMs, eventCount: count, headerIds, eventErrors: errors, shapes, textChars, finish, usage }));
} catch (error) {
  console.log(JSON.stringify({ elapsedMs: Date.now()-started, name: error?.name || 'Error', error: String(error?.message || error) }));
}
