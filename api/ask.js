// POST /api/ask {question, view} -> {answer, model, fallback} (Vercel Function).
// Keys and the provider chain come from environment variables; see docs/ASSISTANT.md.
import { ask, buildMessages, createLimiter, parseProviders, validateRequest } from './_assistant.js';

const env = process.env;
const limiter = createLimiter({
  perMinute: Number(env.ASSISTANT_RATE_PER_MIN) || 6,
  primaryPerDay: Number(env.ASSISTANT_PRIMARY_DAILY_LIMIT) || 300,
});

export function createHandler({ fetchImpl = fetch, limits = limiter, environment = env } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!limits.allow(ip)) return res.status(429).json({ error: 'Too many questions. Please wait a minute.' });
    const checked = validateRequest(req.body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const result = await ask(parseProviders(environment.ASSISTANT_PROVIDERS), buildMessages(checked.question, checked.viewText), {
      env: environment, fetch: fetchImpl, skip: (_, i) => i === 0 && limits.primaryExhausted(),
    });
    if (result.error) {
      console.warn('assistant unavailable', JSON.stringify(result.attempts));
      return res.status(503).json({ error: result.error });
    }
    if (!result.fallback) limits.countPrimary();
    return res.status(200).json({ answer: result.answer, model: result.model, fallback: result.fallback });
  };
}

export default createHandler();
