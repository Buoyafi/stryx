/**
 * Copies a secret and wipes the clipboard a minute later, so a private key does not sit there for the
 * next paste, a clipboard manager or another site to pick up.
 */
export const CLIPBOARD_CLEAR_SECONDS = 60;

let timer: ReturnType<typeof setTimeout> | null = null;

function wipe(): void {
  timer = null;
  navigator.clipboard.writeText('').catch(() => {
    // A browser refuses clipboard writes from a tab that is not in front: do it when it is again.
    window.addEventListener('focus', wipe, { once: true });
  });
}

export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (timer) clearTimeout(timer);
  timer = setTimeout(wipe, CLIPBOARD_CLEAR_SECONDS * 1000);
}
