<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-lg rounded-2xl bg-zinc-900 p-6 text-white shadow-2xl ring-1 ring-white/10"
    >
      <div class="flex items-center gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
        >
          <ExclamationTriangleIcon class="size-6" />
        </div>
        <div>
          <h3 class="text-base font-semibold text-white">
            Cloud Save Conflict
          </h3>
          <p class="text-xs text-zinc-400">
            A save discrepancy was detected between this machine and Drop Cloud.
          </p>
        </div>
      </div>

      <div class="mt-5 grid grid-cols-2 gap-4">
        <!-- Local Save Card -->
        <button
          type="button"
          class="w-full rounded-xl bg-zinc-800/60 p-4 text-left ring-1 ring-white/5 hover:ring-blue-500/50 transition cursor-pointer"
          :class="{ 'ring-2 ring-blue-500 bg-blue-950/20': choice === 'local' }"
          @click="choice = 'local'"
        >
          <div
            class="text-xs font-semibold uppercase tracking-wider text-blue-400"
          >
            This Device (Local)
          </div>
          <div class="mt-2 text-sm font-medium text-zinc-200">
            {{ formatTime(localTimestamp) }}
          </div>
          <div class="mt-1 text-xs text-zinc-400">
            Size: {{ formatBytes(localSizeBytes) }}
          </div>
          <p class="mt-3 text-[11px] text-zinc-400">
            Keep your locally played save files and overwrite the cloud copy.
          </p>
        </button>

        <!-- Cloud Save Card -->
        <button
          type="button"
          class="w-full rounded-xl bg-zinc-800/60 p-4 text-left ring-1 ring-white/5 hover:ring-blue-500/50 transition cursor-pointer"
          :class="{ 'ring-2 ring-blue-500 bg-blue-950/20': choice === 'cloud' }"
          @click="choice = 'cloud'"
        >
          <div
            class="text-xs font-semibold uppercase tracking-wider text-emerald-400"
          >
            Drop Cloud
          </div>
          <div class="mt-2 text-sm font-medium text-zinc-200">
            {{ formatTime(cloudTimestamp) }}
          </div>
          <div class="mt-1 text-xs text-zinc-400">
            Size: {{ formatBytes(cloudSizeBytes) }}
          </div>
          <p class="mt-3 text-[11px] text-zinc-400">
            Download latest server snapshot and overwrite local files.
          </p>
        </button>
      </div>

      <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          class="rounded-lg bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700 transition"
          @click="resolve('both')"
        >
          Keep Both (New Slot)
        </button>
        <button
          type="button"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 transition shadow-md shadow-blue-500/20"
          @click="resolve(choice)"
        >
          Confirm (Use {{ choice === "local" ? "Local" : "Cloud" }})
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ExclamationTriangleIcon } from "@heroicons/vue/24/outline";

const open = defineModel<boolean>({ default: false });

defineProps<{
  gameTitle?: string;
  localTimestamp: string | Date;
  localSizeBytes: number;
  cloudTimestamp: string | Date;
  cloudSizeBytes: number;
}>();

const emit = defineEmits<{
  (e: "resolve", action: "local" | "cloud" | "both"): void;
}>();

const choice = ref<"local" | "cloud">("cloud");

function formatTime(timestamp: string | Date): string {
  const d = new Date(timestamp);
  return d.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function resolve(action: "local" | "cloud" | "both") {
  emit("resolve", action);
  open.value = false;
}
</script>
