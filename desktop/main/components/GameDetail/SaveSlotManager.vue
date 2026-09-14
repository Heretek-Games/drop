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
            Powered by Ludusavi discovery &amp; snapshot versioning
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
          @click="refresh"
        >
          {{ isSyncing ? "Syncing..." : "Refresh" }}
        </button>
      </div>
    </div>

    <div v-if="errorMessage" class="mt-4 text-xs text-red-400">
      {{ errorMessage }}
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
              <span>{{ slot.historyCount }} snapshot(s)</span>
              <span>•</span>
              <span>
                {{
                  slot.createdAt
                    ? `Created ${new Date(slot.createdAt).toLocaleString()}`
                    : "Not yet synced"
                }}
              </span>
              <span v-if="slot.lastUsedClientId"
                >• Client: {{ slot.lastUsedClientId }}</span
              >
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="slot.latestObjectId"
            type="button"
            class="rounded bg-zinc-700/50 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition"
            @click="downloadArchive(slot.latestObjectId)"
          >
            Download Snapshot
          </button>
        </div>
      </div>

      <div
        v-if="slots.length === 0 && !isSyncing && !errorMessage"
        class="rounded-lg border border-dashed border-white/10 p-6 text-center text-xs text-zinc-400"
      >
        No cloud saves recorded for this title. Saves are detected and uploaded
        automatically when the game exits.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { CloudArrowUpIcon } from "@heroicons/vue/20/solid";

export interface SaveSlotView {
  index: number;
  historyCount: number;
  latestObjectId?: string;
  latestChecksum?: string;
  lastUsedClientId?: string;
  createdAt?: string;
}

const props = defineProps<{
  gameId: string;
}>();

const isSyncing = ref(false);
const syncStatus = ref<"in_sync" | "uploading" | "conflict">("in_sync");
const activeSlotIndex = ref(1);
const slots = ref<SaveSlotView[]>([]);
const errorMessage = ref<string>();

const statusLabel = computed(() => {
  switch (syncStatus.value) {
    case "uploading":
      return "Syncing...";
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

async function refresh() {
  isSyncing.value = true;
  syncStatus.value = "uploading";
  errorMessage.value = undefined;
  try {
    slots.value = await invoke<SaveSlotView[]>("fetch_cloud_save_slots", {
      gameId: props.gameId,
    });
    syncStatus.value = "in_sync";
  } catch (e) {
    console.warn("Failed to load cloud save slots:", e);
    errorMessage.value = "Could not load cloud saves.";
  } finally {
    isSyncing.value = false;
  }
}

async function downloadArchive(objectId: string) {
  try {
    await invoke<string>("download_cloud_save_object", { objectId });
  } catch (e) {
    console.warn("Failed to download cloud save snapshot:", e);
    errorMessage.value = "Could not download the snapshot.";
  }
}

onMounted(refresh);
</script>
