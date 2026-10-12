import { isValidEmail } from './email.js';
import { toast } from '@stryx/toast-ui';

/** The waitlist form. */

const REQUEST_TIMEOUT_MS = 10_000;

export const MESSAGES = {
  invalid: 'Enter a valid email address.',
  rate: 'Too many tries. Try again a little later.',
  network: "We couldn't reach the server. Check your connection and try again.",
  server: 'Something went wrong on our side. Please try again in a moment.',
};

/** Posts the address. Resolves to { ok: true } or { ok: false, kind } where kind is a key of MESSAGES. */
export async function submitWaitlist(email, leaveBlank, { apiBase = '/api', fetchImpl = (...args) => fetch(...args) } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase}/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, leave_blank: leaveBlank }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 400) return { ok: false, kind: 'invalid' };
    if (res.status === 429) return { ok: false, kind: 'rate' };
    return { ok: false, kind: 'server' };
  } catch {
    return { ok: false, kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export function mountWaitlistForm(form, { apiBase = '/api', fetchImpl } = {}) {
  if (!form) return;

  const input = form.querySelector('input[type="email"]');
  const trap = form.querySelector('input[name="leave_blank"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  if (!input || !submitBtn) return;

  const idleLabel = submitBtn.textContent;
  let sending = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) return;

    if (!isValidEmail(input.value)) {
      input.setAttribute('aria-invalid', 'true');
      toast.error(MESSAGES.invalid);
      input.focus();
      return;
    }

    input.removeAttribute('aria-invalid');
    sending = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Joining…';
    const result = await submitWaitlist(input.value.trim(), trap ? trap.value : '', { apiBase, ...(fetchImpl ? { fetchImpl } : {}) });
    sending = false;

    if (result.ok) {
      toast.success("You're on the list", "We'll email you when it opens up.");
      form.reset();
      input.disabled = true;
      submitBtn.textContent = "You're on the list";
      return;
    }

    // A failure leaves the form usable so they can try again.
    if (result.kind === 'invalid') input.setAttribute('aria-invalid', 'true');
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel;
    toast.error(MESSAGES[result.kind]);
    input.focus();
  });
}
