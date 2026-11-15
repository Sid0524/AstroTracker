// "Ask about this view" assistant: provider chain, prompt and limits.
// Pure logic, shared by api/ask.js and the tests. "_" keeps it from being a route.

export const DEFAULT_PROVIDERS = 'openai:gpt-5';
const ENDPOINTS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: 'OPENROUTER_API_KEY' },
};
export const MAX_QUESTION = 500;
const MAX_VIEW = 3000;

export const SYSTEM_PROMPT = `You explain NASA SPHEREx infrared images to members of the public using the SpaceLapse viewer.
Answer only from the VIEW data and general astronomy knowledge. Be plain, friendly and brief (under 150 words unless asked for more).
Rules:
- Never claim a discovery. Unexplained changes are "candidates to check", and users can press Report.
- If the view data does not show something, say you cannot confirm it. Do not invent numbers, dates or objects.
- Brightness or position differences can come from wavelength, quality flags, image edges or alignment, not only real change.
- Each detector covers a wavelength range, so the wavelength also varies between exposures within one detector.
- SPHEREx detectors: D1 0.75-1.09 um, D2 1.10-1.62, D3 1.63-2.41, D4 2.42-3.82, D5 3.83-4.41, D6 4.42-5.00. Native pixels are 6.15 arcsec.`;

// "openai:gpt-5, openrouter:vendor/model:free" -> [{provider, model}], unknown providers dropped.
export function parseProviders(spec = DEFAULT_PROVIDERS) {
  return String(spec).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':');
    return i > 0 ? { provider: s.slice(0, i).trim().toLowerCase(), model: s.slice(i + 1).trim() } : null;
  }).filter(p => p && p.model && ENDPOINTS[p.provider]);
}

export function validateRequest(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return { error: 'Ask a question about the current view.' };
  if (question.length > MAX_QUESTION) return { error: `Questions are limited to ${MAX_QUESTION} characters.` };
  const view = body?.view && typeof body.view === 'object' ? body.view : {};
  const viewText = JSON.stringify(view).slice(0, MAX_VIEW);
  return { question, viewText };
}

export function buildMessages(question, viewText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `VIEW (data shown on screen):\n${viewText}\n\nQUESTION: ${question}` },
  ];
}

// Request body for an OpenAI-compatible chat completion.
export function requestBody({ provider, model }, messages, env = {}) {
  const max = Number(env.ASSISTANT_MAX_TOKENS) || 2000;
  const body = { model, messages };
  if (provider === 'openai') {
    body.max_completion_tokens = max; // includes reasoning tokens on GPT-5
    body.reasoning_effort = env.ASSISTANT_OPENAI_REASONING || 'low';
  } else {
    body.max_tokens = max;
  }
  return body;
}

// Tries each provider in order; any failure (missing key, limit, quota, outage,
// timeout, empty answer) moves to the next. Returns the answer and who wrote it.
export async function ask(providers, messages, { env = {}, fetch, skip = () => false, timeoutMs = 45000 } = {}) {
  const attempts = [];
  for (const [i, p] of providers.entries()) {
    const label = `${p.provider}:${p.model}`;
    const endpoint = ENDPOINTS[p.provider];
    const key = env[endpoint.key];
    if (!key) { attempts.push({ label, reason: 'no API key configured' }); continue; }
    if (skip(p, i)) { attempts.push({ label, reason: 'daily limit reached' }); continue; }
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(requestBody(p, messages, env)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { attempts.push({ label, reason: `HTTP ${res.status}` }); continue; }
      const data = await res.json();
      const answer = data?.choices?.[0]?.message?.content?.trim();
      if (!answer) { attempts.push({ label, reason: 'empty answer' }); continue; }
      return { answer, model: label, fallback: i > 0, attempts };
    } catch (e) {
      attempts.push({ label, reason: e?.name === 'TimeoutError' ? 'timed out' : 'network error' });
    }
  }
  return { error: 'The assistant is unavailable right now. Please try again later.', attempts };
}

// In-memory limits (per server instance; best effort on serverless).
export function createLimiter({ perMinute = 6, primaryPerDay = 300, now = () => Date.now() } = {}) {
  const hits = new Map();
  let day = '', primaryUsed = 0;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  return {
    allow(ip) {
      const t = now(), recent = (hits.get(ip) || []).filter(x => t - x < 60000);
      if (recent.length >= perMinute) { hits.set(ip, recent); return false; }
      recent.push(t); hits.set(ip, recent);
      return true;
    },
    primaryExhausted() { if (day !== today()) { day = today(); primaryUsed = 0; } return primaryUsed >= primaryPerDay; },
    countPrimary() { if (day !== today()) { day = today(); primaryUsed = 0; } primaryUsed++; },
  };
}
