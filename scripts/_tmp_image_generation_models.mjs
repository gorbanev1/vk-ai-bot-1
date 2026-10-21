import 'dotenv/config';

const models = ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
for (const model of models) {
  const started = Date.now();
  try {
    const response = await fetch('https://router.cheap/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_COMPAT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, image/*' },
      body: JSON.stringify({ model, prompt: 'A simple blue square on a white background', size: '1024x1024', n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
    const headers = Object.fromEntries(['x-request-id', 'request-id', 'cf-ray', 'x-router-request-id'].map((name) => [name, response.headers.get(name)]).filter(([, value]) => value));
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let payload = null; try { payload = JSON.parse(raw); } catch {}
    console.log(JSON.stringify({ model, http: response.status, elapsedMs: Date.now() - started, contentType, headers, error: payload?.error || null, hasData: Array.isArray(payload?.data) && payload.data.length > 0, bodyChars: raw.length }));
  } catch (error) {
    console.log(JSON.stringify({ model, elapsedMs: Date.now() - started, name: error?.name || 'Error', error: String(error?.message || error) }));
  }
}
