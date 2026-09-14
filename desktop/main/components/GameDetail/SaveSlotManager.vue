<template>
  <div
    class="rounded-xl bg-zinc-900/60 p-5 ring-1 ring-white/10 backdrop-blur-md"
  >
    <div class="flex items-center justify-between border-b border-white/5 pb-4">
      <div class="flex items-center gap-3">
        <div
          class="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20"
        >
          <CloudArrowUpIcon class="size-5" aria-hidden="true" />
        </div>
        <div>
          <h3 class="text-sm font-semibold text-white">
            Cloud Save Synchronization
          </h3>
          <p class="text-xs text-zinc-400">
            Powered by Ludusavi discovery & snapshot versioning
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          :class="statusClasses"
        >
          <span class="size-1.5 rounded-full" :class="statusDotClasses" />
          {{ statusLabel }}
        </span>
        <button
          type="button"
          :disabled="isSyncing"
          class="rounded-md bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-50 transition"
          @click="syncNow"
        >
          {{ isSyncing ? "Syncing..." : "Sync Now" }}
        </button>
      </div>
    </div>

    <!-- Slots List -->
    <div class="mt-4 space-y-3">
      <div
        v-for="slot in slots"
        :key="slot.index"
        class="flex flex-col gap-3 rounded-lg bg-zinc-800/40 p-3 ring-1 ring-white/5 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex items-center gap-3">
          <div
            class="flex h-8 w-8 items-center justify-center rounded bg-zinc-700/50 text-xs font-bold text-zinc-300"
          >
            #{{ slot.index }}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-zinc-200"
                >Slot {{ slot.index }}</span
              >
              <span
                v-if="slot.index === activeSlotIndex"
                class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/20"
              >
                Active
              </span>
            </div>
            <div class="flex items-center gap-3 text-xs text-zinc-400 mt-0.5">
              <span>Size: {{ formatBytes(slot.sizeBytes) }}</span>
              <span>•</span>
              <span>
                {{
                  slot.lastSynced
                    ? `Synced ${new Date(slot.lastSynced).toLocaleTimeString()}`
                    : "Not yet synced"
                }}
              </span>
              <span v-if="slot.clientHostname"
                >• Host: {{ slot.clientHostname }}</span
              >
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded bg-zinc-700/50 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
            @click="downloadArchive(slot.index)"
          >
            Download Zip
          </button>
          <button
            v-if="slot.historyCount && slot.historyCount > 1"
            type="button"
            class="rounded bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 ring-1 ring-amber-500/20 transition"
            @click="rollbackSlot(slot.index)"
          >
            Rollback ({{ slot.historyCount }} versions)
          </button>
        </div>
      </div>

      <div
        v-if="slots.length === 0"
        class="rounded-lg border border-dashed border-white/10 p-6 text-center text-xs text-zinc-400"
      >
        No cloud saves recorded for this title. Saves will automatically be
        detected and uploaded on game exit.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { CloudArrowUpIcon } from "@heroicons/vue/20/solid";

export interface SaveSlotView {
  index: number;
  sizeBytes: number;
  lastSynced?: string | Date;
  clientHostname?: string;
  historyCount?: number;
}

const props = defineProps<{
  gameId: string;
}>();

const isSyncing = ref(false);
const syncStatus = ref<"in_sync" | "uploading" | "conflict">("in_sync");
const activeSlotIndex = ref(1);

const slots = ref<SaveSlotView[]>([
  {
    index: 1,
    sizeBytes: 1048576,
    lastSynced: new Date().toISOString(),
    clientHostname: "SteamDeck-OLED",
    historyCount: 3,
  },
]);

const statusLabel = computed(() => {
  switch (syncStatus.value) {
    case "uploading":
      return "Uploading...";
    case "conflict":
      return "Conflict Detected";
    case "in_sync":
    default:
      return "In Sync";
  }
});

const statusClasses = computed(() => {
  switch (syncStatus.value) {
    case "uploading":
      return "bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20";
    case "conflict":
      return "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20";
    case "in_sync":
    default:
      return "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20";
  }
});

const statusDotClasses = computed(() => {
  switch (syncStatus.value) {
    case "uploading":
      return "bg-blue-400 animate-pulse";
    case "conflict":
      return "bg-amber-400";
    case "in_sync":
    default:
      return "bg-emerald-400";
  }
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

async function syncNow() {
  isSyncing.value = true;
  syncStatus.value = "uploading";
  setTimeout(() => {
    isSyncing.value = false;
    syncStatus.value = "in_sync";
  }, 1000);
}

function downloadArchive(slotIndex: number) {
  // Download archive endpoint: /api/v1/client/saves/:gameId/:slotIndex
  window.open(`/api/v1/client/saves/${props.gameId}/${slotIndex}`, "_blank");
}

function rollbackSlot(slotIndex: number) {
  // Trigger rollback to previous snapshot
  console.log(`Rollback requested for slot ${slotIndex} on ${props.gameId}`);
}
</script>
