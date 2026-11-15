// "Ask SpaceLapse": a floating button opens a drawer that sends the question
// and a summary of the view to /api/ask.

export function initAssistant(root, { getView, fetchImpl = (...a) => fetch(...a), endpoint = 'api/ask' }) {
  const form = root.querySelector('form'), input = root.querySelector('textarea');
  const button = root.querySelector('button[type=submit]'), out = root.querySelector('.assistant-answer');
  const meta = root.querySelector('.assistant-meta');
  const fab = root.querySelector('.assistant-fab'), drawer = root.querySelector('.assistant-drawer');

  function setOpen(open) {
    drawer.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    (open ? input : fab).focus();
  }
  fab.addEventListener('click', () => setOpen(drawer.hidden));
  root.querySelector('.assistant-close').addEventListener('click', () => setOpen(false));
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });

  async function submit(e) {
    e?.preventDefault();
    const question = input.value.trim();
    if (!question || button.disabled) return;
    button.disabled = true;
    out.textContent = 'Thinking…';
    meta.textContent = '';
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, view: getView() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.answer) {
        out.textContent = data.error || 'The assistant is unavailable right now. Please try again later.';
        return;
      }
      out.textContent = data.answer; // plain text only: never rendered as HTML
      meta.textContent = `Answered by ${data.model}${data.fallback ? ' (backup model; may be less accurate)' : ''}. AI answers can be wrong; check the data.`;
    } catch {
      out.textContent = 'Could not reach the assistant. Check your connection and try again.';
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener('submit', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) submit(e); });
  return { submit, setOpen };
}
