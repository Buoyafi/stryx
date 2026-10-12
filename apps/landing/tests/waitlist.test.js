// @vitest-environment jsdom
/* global document */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stryx/toast-ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { toast } = await import('@stryx/toast-ui');
const { MESSAGES, mountWaitlistForm, submitWaitlist } = await import('../src/lib/waitlist.js');

const reply = (status, body = {}) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('submitWaitlist', () => {
  it('posts the address and the trap field as JSON to /waitlist under the API base', async () => {
    const fetchImpl = reply(200, { ok: true });
    const result = await submitWaitlist('a@b.io', '', { apiBase: '/api', fetchImpl });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/waitlist');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.io', leave_blank: '' });
  });

  it('maps each failure to a kind the page can explain', async () => {
    expect(await submitWaitlist('a@b.io', '', { fetchImpl: reply(400) })).toEqual({ ok: false, kind: 'invalid' });
    expect(await submitWaitlist('a@b.io', '', { fetchImpl: reply(429) })).toEqual({ ok: false, kind: 'rate' });
    expect(await submitWaitlist('a@b.io', '', { fetchImpl: reply(500) })).toEqual({ ok: false, kind: 'server' });
    expect(await submitWaitlist('a@b.io', '', { fetchImpl: reply(413) })).toEqual({ ok: false, kind: 'server' });
    expect(await submitWaitlist('a@b.io', '', { fetchImpl: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) })).toEqual({ ok: false, kind: 'network' });
  });

  it('gives up on a request that never answers', async () => {
    vi.useFakeTimers();
    const hang = vi.fn((_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
    const pending = submitWaitlist('a@b.io', '', { fetchImpl: hang });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toEqual({ ok: false, kind: 'network' });
    vi.useRealTimers();
  });
});

describe('mountWaitlistForm', () => {
  let form;
  let input;
  let trap;
  let button;

  const mount = (fetchImpl) => mountWaitlistForm(form, { apiBase: '/api', fetchImpl });
  const submit = async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `
      <form id="waitlist-form">
        <input type="email" />
        <button type="submit">Join the waitlist</button>
        <input type="text" name="leave_blank" />
      </form>`;
    form = document.getElementById('waitlist-form');
    input = form.querySelector('input[type="email"]');
    trap = form.querySelector('input[name="leave_blank"]');
    button = form.querySelector('button');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not call the server for an invalid email; it toasts, marks the field and focuses it', async () => {
    const fetchImpl = reply(200);
    mount(fetchImpl);
    input.value = 'not-an-email';
    await submit();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(MESSAGES.invalid);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('sends a valid email, then confirms and locks the form', async () => {
    const fetchImpl = reply(200, { ok: true });
    mount(fetchImpl);
    input.value = '  operator@stryx.dev ';
    await submit();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).email).toBe('operator@stryx.dev');
    expect(toast.success).toHaveBeenCalledWith("You're on the list", "We'll email you when it opens up.");
    expect(input.disabled).toBe(true);
    expect(button.textContent).toBe("You're on the list");
    expect(button.disabled).toBe(true);
  });

  it('passes whatever is in the trap field through, so the server can ignore a script', async () => {
    const fetchImpl = reply(200);
    mount(fetchImpl);
    input.value = 'bot@spam.io';
    trap.value = 'http://spam.example';
    await submit();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).leave_blank).toBe('http://spam.example');
  });

  it('shows "Joining…" and ignores a second submit while one is in flight', async () => {
    let release;
    const fetchImpl = vi.fn(() => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({}) }); }));
    mount(fetchImpl);
    input.value = 'a@b.io';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(button.textContent).toBe('Joining…');
    expect(button.disabled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, MESSAGES.rate],
    [500, MESSAGES.server],
    [400, MESSAGES.invalid],
  ])('on a %i it says so and leaves the form ready to try again', async (status, message) => {
    mount(reply(status));
    input.value = 'a@b.io';
    await submit();
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Join the waitlist');
    expect(input.value).toBe('a@b.io');
  });

  it('says the connection is the problem when the request cannot be made', async () => {
    mount(vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    input.value = 'a@b.io';
    await submit();
    expect(toast.error).toHaveBeenCalledWith(MESSAGES.network);
    expect(button.disabled).toBe(false);
  });
});
