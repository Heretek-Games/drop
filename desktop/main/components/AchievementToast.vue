<template>
  <div
    class="pointer-events-none fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-3"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="pointer-events-auto flex items-start gap-3 rounded-xl bg-zinc-900/95 p-4 text-white shadow-2xl ring-1 ring-amber-500/30 backdrop-blur"
    >
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400"
      >
        <TrophyIcon class="size-5" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <p
          class="text-[10px] font-semibold uppercase tracking-wider text-amber-400"
        >
          Achievement Unlocked
        </p>
        <p class="truncate text-sm font-medium">{{ toast.title }}</p>
        <p v-if="toast.points" class="text-xs text-zinc-400">
          +{{ toast.points }} points
          <span v-if="toast.hardcore"> · Hardcore</span>
        </p>
      </div>
      <button
        type="button"
        class="text-zinc-500 hover:text-zinc-300"
        aria-label="Dismiss achievement toast"
        @click="$emit('dismiss', toast.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { TrophyIcon } from "@heroicons/vue/20/solid";
import type { AchievementToast } from "~/internal/plugins/achievementToasts";

defineProps<{ toasts: AchievementToast[] }>();

defineEmits<{ (e: "dismiss", id: string): void }>();
</script>
