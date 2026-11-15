# "Ask about this view" assistant

A panel in SpaceLapse, under the filmstrip, answers plain-language questions
about what is on screen. The browser sends the question plus a short summary of
the view: target, detector, dates, and the coverage summary. A Vercel Function
(`api/ask.js`) forwards it to an AI model and returns plain text, labelled with
the model that wrote it.

## Providers and fallback

The chain is configured by environment variables and tried in order. Any
failure moves on to the next provider: a missing key, the primary's daily cap,
HTTP 429 (rate limit or quota), 5xx, a timeout, a network error or an empty
answer.

```
ASSISTANT_PROVIDERS=openai:gpt-5,openrouter:<vendor/model:free>
OPENAI_API_KEY=...            # platform.openai.com: API key with a spend cap
OPENROUTER_API_KEY=...        # optional fallback
```

- Supported providers: `openai` and `openrouter`. Both use the same chat format,
  so no extra packages are needed.
- Answers from a fallback model are labelled "backup model; may be less accurate".
- Use an API key, not a personal ChatGPT/Codex login: a subscription is for
  personal use, not for a public site's visitors.

## Limits and cost controls

| Variable | Default | Effect |
|---|---|---|
| `ASSISTANT_RATE_PER_MIN` | 6 | Questions per visitor (IP) per minute |
| `ASSISTANT_PRIMARY_DAILY_LIMIT` | 300 | Primary answers per day; then the fallback is used |
| `ASSISTANT_MAX_TOKENS` | 2000 | Output cap (GPT-5: includes reasoning) |
| `ASSISTANT_OPENAI_REASONING` | `low` | GPT-5 reasoning effort |

- Questions are limited to 500 characters, and the view summary to 3,000.
- Limits are kept in memory per server instance, so they are best effort.
  Also set a monthly spend cap in each provider's dashboard.

## Safety

- The prompt tells the model never to claim a discovery, to say it cannot
  confirm what the view does not show, and to mention wavelength, flags and
  alignment as alternative explanations.
- Answers are shown as plain text, never as HTML.
- Keys stay on the server and are never returned to the browser.

## Deploying (Vercel)

1. Add the variables above in **Project → Settings → Environment Variables**,
   then redeploy.
2. The deployment must include `api/` and `package.json` (for `"type": "module"`).
   No install step is needed: the function uses Node's built-in `fetch`.
3. Without keys, the panel says the assistant is unavailable. The rest of the
   site is unaffected.

## Tests

- `tests/assistant.test.js`: provider chain, fallback, limits, prompt rules, HTTP handler.
- `tests/js/assistant.test.cjs`: the panel.

Both run without network access or keys.
