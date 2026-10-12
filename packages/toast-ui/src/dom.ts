import { createToastQueue, type ToastInput, type ToastRecord, type ToastQueueState } from './core.js';

export interface ToastHostController {
  push(input: ToastInput): string;
  dismiss(id: string): void;
  destroy(): void;
}

export interface ToastHostOptions {
  /** Defaults to document.body. */
  container?: HTMLElement;
}

const EXIT_ANIMATION_MS = 160;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function fullText(record: ToastRecord): string {
  return record.detail ? `${record.title}: ${record.detail}` : record.title;
}

/** One toast host: an aria-live region holding up to MAX_VISIBLE pills, backed by a core.ts queue instance it owns. */
export function mountToastHost(options: ToastHostOptions = {}): ToastHostController {
  const doc = document;
  const host = doc.createElement('div');
  host.className = 'toast-host';
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'false');
  (options.container ?? doc.body).appendChild(host);

  const queue = createToastQueue();
  const nodes = new Map<string, HTMLElement>();
  const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function buildPill(record: ToastRecord): HTMLElement {
    const pill = doc.createElement('div');
    pill.className = 'toast-pill';
    pill.dataset.tone = record.tone;
    pill.setAttribute('role', record.tone === 'error' ? 'alert' : 'status');

    const dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'toast-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', () => queue.dismiss(record.id));

    const dot = doc.createElement('span');
    dot.className = 'toast-dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = doc.createElement('span');
    text.className = 'toast-text';
    text.title = fullText(record);
    const strong = doc.createElement('strong');
    strong.textContent = record.title;
    text.appendChild(strong);
    if (record.detail) {
      const detail = doc.createElement('span');
      detail.textContent = record.detail;
      text.appendChild(detail);
    }

    pill.append(dismissBtn, dot, text);

    if (record.actionLabel && record.onAction) {
      const action = doc.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = record.actionLabel;
      action.addEventListener('click', () => record.onAction?.());
      pill.appendChild(action);
    }

    const progressClip = doc.createElement('span');
    progressClip.className = 'toast-progress-clip';
    const progress = doc.createElement('span');
    progress.className = 'toast-progress';
    progress.setAttribute('aria-hidden', 'true');
    progressClip.appendChild(progress);
    pill.appendChild(progressClip);

    pill.addEventListener('mouseenter', () => queue.pause(record.id));
    pill.addEventListener('mouseleave', () => queue.resume(record.id));
    pill.addEventListener('focusin', () => queue.pause(record.id));
    pill.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && pill.contains(to)) return;
      queue.resume(record.id);
    });
    // Bubbles up from whichever button inside this pill has focus, so this only ever dismisses the
    // toast that is actually focused.
    pill.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') queue.dismiss(record.id);
    });

    return pill;
  }

  function updateProgress(pill: HTMLElement, record: ToastRecord): void {
    const progress = pill.querySelector<HTMLElement>('.toast-progress');
    if (!progress) return;
    if (record.durationMs === null) {
      progress.style.display = 'none';
      return;
    }
    // Restart the CSS animation from the current remaining time, so a resume after a pause continues
    // the shrink from wherever it was, not from full.
    progress.style.animation = 'none';
    void progress.offsetWidth; // commit, so the next line starts a fresh animation
    progress.style.animation = `toast-shrink ${record.remainingMs}ms linear forwards`;
    progress.style.animationPlayState = record.paused ? 'paused' : 'running';
  }

  const shown = new Map<string, ToastRecord>();

  function render(state: ToastQueueState): void {
    const currentIds = new Set(state.visible.map((t) => t.id));

    for (const [id, node] of nodes) {
      if (currentIds.has(id)) continue;
      nodes.delete(id);
      shown.delete(id);
      if (prefersReducedMotion()) {
        node.remove();
        continue;
      }
      node.classList.add('is-exiting');
      const timer = setTimeout(() => {
        node.remove();
        removalTimers.delete(id);
      }, EXIT_ANIMATION_MS);
      removalTimers.set(id, timer);
    }

    // New records are only ever appended, so existing nodes are already in order.
    for (const record of state.visible) {
      let node = nodes.get(record.id);
      if (!node) {
        node = buildPill(record);
        nodes.set(record.id, node);
        host.appendChild(node);
      }
      // Records are replaced, never mutated: an unchanged one keeps its bar running.
      if (shown.get(record.id) === record) continue;
      shown.set(record.id, record);
      updateProgress(node, record);
    }
  }

  const unsubscribe = queue.subscribe(render);
  render(queue.getState());

  function destroy(): void {
    unsubscribe();
    queue.destroy();
    for (const timer of removalTimers.values()) clearTimeout(timer);
    removalTimers.clear();
    nodes.clear();
    shown.clear();
    host.remove();
  }

  return {
    push: (input) => queue.push(input),
    dismiss: (id) => queue.dismiss(id),
    destroy,
  };
}
