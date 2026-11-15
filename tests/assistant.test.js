// Assistant server: provider chain with fallback, limits, prompt rules. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_GUIDE, ask, buildMessages, createLimiter, parseProviders, requestBody, validateRequest, SYSTEM_PROMPT } from '../api/_assistant.js';
import { createHandler } from '../api/ask.js';

const ENV = { OPENAI_API_KEY: 'sk-openai-test', OPENROUTER_API_KEY: 'sk-or-test' };
const CHAIN = parseProviders('openai:gpt-5, openrouter:vendor/free-model:free');
const reply = (status, content = 'An answer.') => async () => ({ ok: status < 400, status, json: async () => ({ choices: [{ message: { content } }] }) });
function fakeFetch(outcomes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    const o = outcomes[calls.length - 1] ?? outcomes.at(-1);
    if (o instanceof Error) throw o;
    return o();
  };
  fn.calls = calls;
  return fn;
}

test('providers are read from config, in order; unknown or malformed entries are ignored', () => {
  assert.deepEqual(parseProviders(), [{ provider: 'openai', model: 'gpt-5' }]);
  assert.deepEqual(CHAIN, [{ provider: 'openai', model: 'gpt-5' }, { provider: 'openrouter', model: 'vendor/free-model:free' }]);
  assert.deepEqual(parseProviders('acme:x, openai, :y, OpenAI:gpt-5-mini'), [{ provider: 'openai', model: 'gpt-5-mini' }]);
});

test('questions are required and bounded; the view summary is capped', () => {
  assert.match(validateRequest({}).error, /Ask a question/);
  assert.match(validateRequest({ question: 'x'.repeat(501) }).error, /500 characters/);
  const ok = validateRequest({ question: '  Why? ', view: { coverage: 'c'.repeat(5000) } });
  assert.equal(ok.question, 'Why?');
  assert.equal(ok.viewText.length, 3000);
  assert.equal(validateRequest({ question: 'Hi', view: 'not an object' }).viewText, '{}');
});

test('P1/C: the prompt forbids discovery claims and invented data, and carries the view', () => {
  assert.match(SYSTEM_PROMPT, /Never claim a discovery/);
  assert.match(SYSTEM_PROMPT, /cannot confirm/);
  assert.match(SYSTEM_PROMPT, /wavelength also varies between exposures within one detector/, 'same detector is not the same wavelength');
  const [system, user] = buildMessages('What moved?', '{"target":"Barnard"}');
  assert.equal(system.role, 'system');
  assert.match(user.content, /VIEW[\s\S]*Barnard[\s\S]*QUESTION: What moved\?/);
});

test('OpenAI requests cap total tokens and use low reasoning effort by default; both are configurable', () => {
  const m = buildMessages('q', '{}');
  assert.deepEqual(Object.keys(requestBody(CHAIN[0], m)).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort']);
  assert.equal(requestBody(CHAIN[0], m).reasoning_effort, 'low');
  const custom = requestBody(CHAIN[0], m, { ASSISTANT_MAX_TOKENS: '900', ASSISTANT_OPENAI_REASONING: 'medium' });
  assert.equal(custom.max_completion_tokens, 900);
  assert.equal(custom.reasoning_effort, 'medium');
  assert.equal(requestBody(CHAIN[1], m).max_tokens, 2000);
});

test('the primary model answers when available and is labelled', async () => {
  const f = fakeFetch([reply(200, 'You are looking at D1.')]);
  const r = await ask(CHAIN, buildMessages('q', '{}'), { env: ENV, fetch: f });
  assert.deepEqual([r.answer, r.model, r.fallback], ['You are looking at D1.', 'openai:gpt-5', false]);
  assert.equal(f.calls[0].auth, 'Bearer sk-openai-test');
  assert.match(f.calls[0].url, /api\.openai\.com/);
});

test('limits, quota, outages, timeouts, network errors and empty answers fall back to OpenRouter', async () => {
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  for (const [first, reason] of [[reply(429), 'HTTP 429'], [reply(503), 'HTTP 503'], [timeout, 'timed out'], [new TypeError('x'), 'network error'], [reply(200, '  '), 'empty answer']]) {
    const f = fakeFetch([first, reply(200, 'Backup answer.')]);
    const r = await ask(CHAIN, buildMessages('q', '{}'), { env: ENV, fetch: f });
    assert.deepEqual([r.answer, r.model, r.fallback], ['Backup answer.', 'openrouter:vendor/free-model:free', true], reason);
    assert.equal(r.attempts[0].reason, reason);
    assert.match(f.calls[1].url, /openrouter\.ai/);
    assert.equal(f.calls[1].auth, 'Bearer sk-or-test');
  }
});

test('a provider without a key, or past its daily limit, is skipped', async () => {
  const f = fakeFetch([reply(200, 'Backup.')]);
  const r = await ask(CHAIN, buildMessages('q', '{}'), { env: { OPENROUTER_API_KEY: 'k' }, fetch: f });
  assert.equal(r.model, 'openrouter:vendor/free-model:free');
  assert.equal(r.attempts[0].reason, 'no API key configured');
  const g = fakeFetch([reply(200, 'Backup.')]);
  const s = await ask(CHAIN, buildMessages('q', '{}'), { env: ENV, fetch: g, skip: (_, i) => i === 0 });
  assert.equal(s.attempts[0].reason, 'daily limit reached');
  assert.equal(g.calls.length, 1, 'primary not called');
});

test('when every provider fails the user gets a clear message and no keys', async () => {
  const r = await ask(CHAIN, buildMessages('q', '{}'), { env: ENV, fetch: fakeFetch([reply(500)]) });
  assert.match(r.error, /unavailable right now/);
  assert.equal(r.attempts.length, 2);
  assert.doesNotMatch(JSON.stringify(r), /sk-/);
});

test('limits: per-visitor per minute, and a daily cap on the primary that resets each day', () => {
  let t = Date.parse('2026-11-15T10:00:00Z');
  const l = createLimiter({ perMinute: 2, primaryPerDay: 1, now: () => t });
  assert.equal(l.allow('a'), true); assert.equal(l.allow('a'), true); assert.equal(l.allow('a'), false);
  assert.equal(l.allow('b'), true, 'other visitors unaffected');
  t += 61000; assert.equal(l.allow('a'), true, 'window slides');
  assert.equal(l.primaryExhausted(), false); l.countPrimary(); assert.equal(l.primaryExhausted(), true);
  t += 86400000; assert.equal(l.primaryExhausted(), false, 'new day');
});

// --- HTTP handler ------------------------------------------------------------
function call(handler, { method = 'POST', body = { question: 'What is this?', view: { target: 'Barnard' } }, ip = '1.2.3.4' } = {}) {
  return new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(data) { resolve({ code: this.code, data }); } };
    handler({ method, body, headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` }, socket: {} }, res);
  });
}

test('the API accepts only POST, validates input and rate-limits visitors', async () => {
  const h = createHandler({ fetchImpl: fakeFetch([reply(200)]), limits: createLimiter({ perMinute: 1 }), environment: ENV });
  assert.equal((await call(h, { method: 'GET' })).code, 405);
  assert.equal((await call(h, { body: {} })).code, 400);
  assert.equal((await call(h, { ip: '9.9.9.9' })).code, 200);
  assert.equal((await call(h, { ip: '9.9.9.9' })).code, 429);
});

test('the API labels fallback answers, counts only primary answers, and switches when the daily cap is hit', async () => {
  const env = { ...ENV, ASSISTANT_PROVIDERS: 'openai:gpt-5,openrouter:vendor/free-model:free' };
  const f = fakeFetch([reply(200, 'Primary.'), reply(200, 'Backup.')]);
  const h = createHandler({ fetchImpl: f, limits: createLimiter({ primaryPerDay: 1 }), environment: env });
  assert.deepEqual((await call(h)).data, { answer: 'Primary.', model: 'openai:gpt-5', fallback: false });
  const second = await call(h);
  assert.deepEqual(second.data, { answer: 'Backup.', model: 'openrouter:vendor/free-model:free', fallback: true });
  assert.equal(f.calls.length, 2, 'primary skipped once its daily cap is used');
});

test('the API returns 503 without details when no provider can answer', async () => {
  const h = createHandler({ fetchImpl: fakeFetch([reply(500)]), limits: createLimiter(), environment: { ...ENV, ASSISTANT_PROVIDERS: 'openai:gpt-5' } });
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await call(h);
    assert.equal(r.code, 503);
    assert.deepEqual(Object.keys(r.data), ['error']);
  } finally { console.warn = warn; }
});

test('UI/C: the prompt includes an app guide naming the real controls, so the assistant can say what to press', () => {
  for (const control of ['Explore', 'time-lapse', 'blink', 'Select A or B below the timeline', 'detector buttons', 'Field of view',
    'Combine same-day images', 'Wavelength window', 'Scan for changes', 'Report', 'Copy view link', 'Archive coverage',
    'Inspect image quality', 'Label known asteroids', 'Spectrum', 'Run five target checks', 'Quick start']) {
    assert.ok(APP_GUIDE.includes(control), control);
  }
  assert.ok(SYSTEM_PROMPT.includes(APP_GUIDE));
  assert.match(SYSTEM_PROMPT, /how to use the app[\s\S]*name the exact control/i);
  assert.ok(SYSTEM_PROMPT.length < 4000, 'prompt stays small and cacheable');
});
