/**
 * Achievement toast queue (#8).
 *
 * The core emits `drop:achievement:unlock`; the desktop turns each unlock into
 * a toast. The queue logic is kept pure (and unit-tested) so the composable
 * only has to wire the WebSocket subscription.
 */
export interface AchievementUnlockEvent {
  key: string;
  title: string;
  points?: number;
  hardcore?: boolean;
}

export interface AchievementToast extends AchievementUnlockEvent {
  id: string;
  createdAt: number;
}

let sequence = 0;

/** Appends a toast unless an identical achievement is already queued. */
export function enqueueToast(
  queue: AchievementToast[],
  event: AchievementUnlockEvent,
  now: number,
): AchievementToast[] {
  if (queue.some((toast) => toast.key === event.key)) {
    return queue;
  }
  const toast: AchievementToast = {
    ...event,
    id: `achievement-toast-${++sequence}`,
    createdAt: now,
  };
  return [...queue, toast];
}

export function dismissToast(
  queue: AchievementToast[],
  id: string,
): AchievementToast[] {
  return queue.filter((toast) => toast.id !== id);
}

/** Drops toasts older than `ttlMs` (used to auto-expire the UI). */
export function expireToasts(
  queue: AchievementToast[],
  now: number,
  ttlMs: number,
): AchievementToast[] {
  return queue.filter((toast) => now - toast.createdAt < ttlMs);
}
