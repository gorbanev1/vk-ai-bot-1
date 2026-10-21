import 'dotenv/config';
import { readFile } from 'node:fs/promises';

const imagePath = process.argv[2];
const bytes = await readFile(imagePath);
const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const imageUrl = `data:${mime};base64,${bytes.toString('base64')}`;
const body = {
  model: 'gpt-6-luna',
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Прочитай афишу. Верни только JSON с полями title, date, time, place. Не угадывай: неизвестное значение = null.' },
    { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
  ] }],
  stream: false,
  max_tokens: 250,
  temperature: 0,
  reasoning_effort: 'none',
};

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const started = Date.now();
  try {
    const response = await fetch('https://router.cheap/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await response.text();
    let payload = {}; try { payload = JSON.parse(raw); } catch {}
    const headers = Object.fromEntries(['x-request-id', 'request-id', 'cf-ray', 'x-router-request-id'].map((name) => [name, response.headers.get(name)]).filter(([, value]) => value));
    console.log(JSON.stringify({ attempt, http: response.status, elapsedMs: Date.now() - started, headers, error: payload?.error || null, model: payload?.model || null, text: payload?.choices?.[0]?.message?.content || null, usage: payload?.usage || null }));
  } catch (error) {
    console.log(JSON.stringify({ attempt, elapsedMs: Date.now() - started, name: error?.name || 'Error', error: String(error?.message || error) }));
  }
}
