import { ref, onUnmounted } from "vue";
import { clientPluginManager } from "~/internal/plugins/ClientPluginManager";
import {
  dismissToast,
  enqueueToast,
  expireToasts,
  type AchievementToast,
  type AchievementUnlockEvent,
} from "~/internal/plugins/achievementToasts";

const TOAST_TTL_MS = 6000;

/**
 * Subscribes to the core `drop:achievement:unlock` channel and exposes the live
 * toast queue for the overlay component.
 */
export function useAchievementToasts() {
  const toasts = ref<AchievementToast[]>([]);

  const unsubscribe = clientPluginManager.serverWs.subscribe(
    "drop:achievement:unlock",
    (data) => {
      const event = data as AchievementUnlockEvent;
      if (!event || typeof event.key !== "string") return;
      const now = Date.now();
      toasts.value = enqueueToast(
        expireToasts(toasts.value, now, TOAST_TTL_MS),
        event,
        now,
      );

      const id = toasts.value[toasts.value.length - 1]?.id;
      if (id) {
        setTimeout(() => {
          toasts.value = dismissToast(toasts.value, id);
        }, TOAST_TTL_MS);
      }
    },
  );

  onUnmounted(() => unsubscribe());

  function dismiss(id: string) {
    toasts.value = dismissToast(toasts.value, id);
  }

  return { toasts, dismiss };
}
