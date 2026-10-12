import { mountToastHost as mountHostImpl, type ToastHostController, type ToastHostOptions } from './dom.js';
import type { ToastTone } from './core.js';

export type { ToastTone } from './core.js';
export type { ToastHostController, ToastHostOptions } from './dom.js';

export interface ToastActionOptions {
  actionLabel?: string;
  onAction?: () => void;
  /** Overrides the tone's default auto-dismiss time. `null` means never auto-dismiss. */
  durationMs?: number | null;
}

let activeController: ToastHostController | null = null;
let pending: Array<() => void> = [];

function flushPending(): void {
  const queued = pending;
  pending = [];
  for (const run of queued) run();
}

/** Mounts one toast host and registers it as the target for the `toast` service below. */
export function mountToastHost(options?: ToastHostOptions): ToastHostController {
  const controller = mountHostImpl(options);
  activeController = controller;
  flushPending();
  return {
    push: controller.push,
    dismiss: controller.dismiss,
    destroy() {
      controller.destroy();
      if (activeController === controller) activeController = null;
    },
  };
}

function call(tone: ToastTone, title: string, detail?: string, opts?: ToastActionOptions): void {
  const input = { tone, title, ...(detail !== undefined ? { detail } : {}), ...opts };
  if (activeController) {
    activeController.push(input);
    return;
  }
  pending.push(() => activeController?.push(input));
}

/** The shared toast service: import `{ toast }` and call it from anywhere, React or plain JS. */
export const toast = {
  success(title: string, detail?: string, opts?: ToastActionOptions): void {
    call('success', title, detail, opts);
  },
  error(title: string, detail?: string, opts?: ToastActionOptions): void {
    call('error', title, detail, opts);
  },
  info(title: string, detail?: string, opts?: ToastActionOptions): void {
    call('info', title, detail, opts);
  },
  dismiss(id: string): void {
    activeController?.dismiss(id);
  },
};
