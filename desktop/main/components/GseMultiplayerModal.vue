<template>
  <ModalTemplate v-model="isOpen">
    <template #default>
      <div class="sm:flex sm:items-start gap-x-4">
        <div
          class="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-purple-600/20 sm:mx-0 sm:h-10 sm:w-10"
        >
          <UserGroupIcon class="h-6 w-6 text-purple-400" aria-hidden="true" />
        </div>
        <div class="mt-3 text-center sm:mt-0 sm:text-left flex-1">
          <h3 class="text-base font-semibold text-zinc-100">
            Multiplayer Rooms &bull; {{ gameName }}
          </h3>
          <p class="text-xs text-zinc-400 mt-1">
            Encrypted peer-to-peer multiplayer using Drop GSE virtual mesh
            orchestration.
          </p>
        </div>
      </div>

      <!-- Active Room View -->
      <div v-if="currentRoom" class="mt-4 space-y-4">
        <div
          class="rounded-lg border border-purple-500/30 bg-purple-950/20 p-4 space-y-3"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-x-2">
              <span class="relative flex h-2.5 w-2.5">
                <span
                  class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
                ></span>
                <span
                  class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"
                ></span>
              </span>
              <span
                class="text-xs font-semibold uppercase tracking-wider text-emerald-400"
              >
                Active Room
              </span>
            </div>
            <span
              class="rounded bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-300"
            >
              {{ currentRoom.mesh.backend.toUpperCase() }}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span class="text-zinc-500">Room ID:</span>
              <p class="font-mono text-zinc-200 truncate select-all">
                {{ currentRoom.id }}
              </p>
            </div>
            <div>
              <span class="text-zinc-500">Mesh Identifier:</span>
              <p class="font-mono text-zinc-200 truncate">
                {{
                  currentRoom.mesh.backend === "tailscale"
                    ? currentRoom.mesh.aclTag
                    : currentRoom.mesh.networkId
                }}
              </p>
            </div>
          </div>

          <div>
            <span class="text-xs text-zinc-500">
              Connected Peers ({{ currentRoom.members?.length || 1 }}):
            </span>
            <div class="mt-1 max-h-32 overflow-y-auto space-y-1">
              <div
                v-for="(member, idx) in currentRoom.members"
                :key="idx"
                class="flex items-center justify-between rounded bg-zinc-900/60 px-2.5 py-1 text-xs"
              >
                <span class="font-mono text-zinc-300 truncate max-w-[180px]">
                  {{ member.userId }}
                </span>
                <span class="text-[11px] text-zinc-500">
                  {{ member.meshAddress ?? "Mesh Peer" }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="flex gap-x-3">
          <button
            type="button"
            @click="handleLaunchWithRoom"
            class="flex-1 inline-flex justify-center items-center gap-x-2 rounded-md bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-500 transition uppercase font-display"
          >
            <PlayIcon class="size-4" />
            Launch With Room
          </button>
          <button
            type="button"
            @click="handleLeaveRoom"
            :disabled="isLoading"
            class="inline-flex justify-center items-center rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-red-400 hover:text-red-300 hover:bg-zinc-700 transition"
          >
            Leave Room
          </button>
        </div>
      </div>

      <!-- No Active Room: Host or Join -->
      <div v-else class="mt-4 space-y-5">
        <!-- Host Room Card -->
        <div
          class="rounded-lg border border-zinc-700 bg-zinc-800/40 p-4 space-y-3"
        >
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-semibold text-zinc-200">Host New Room</h4>
            <div class="flex items-center gap-x-2">
              <label class="text-xs text-zinc-400">Mesh:</label>
              <select
                v-model="selectedBackend"
                class="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 border border-zinc-700 focus:outline-none focus:border-purple-500"
              >
                <option value="tailscale">Tailscale Mesh</option>
                <option value="zerotier">ZeroTier Mesh</option>
              </select>
            </div>
          </div>

          <p class="text-xs text-zinc-400">
            Create an encrypted room on the Drop server and broadcast
            multiplayer sessions to friends.
          </p>

          <label class="flex items-start gap-x-2 text-[11px] text-zinc-400">
            <input
              v-model="consent"
              type="checkbox"
              class="mt-0.5 rounded border-zinc-600 bg-zinc-900 text-purple-600 focus:ring-purple-500"
            />
            <span>
              I understand this patches the game's Steam files and restores them
              on exit.
            </span>
          </label>

          <button
            type="button"
            @click="handleHostRoom"
            :disabled="isLoading || !consent"
            class="w-full inline-flex justify-center items-center gap-x-2 rounded-md bg-purple-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-500 disabled:opacity-50 transition"
          >
            <PlusIcon class="size-4" />
            <span>Create &amp; Host Room</span>
          </button>
        </div>

        <!-- Discoverable Rooms List -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-semibold text-zinc-200">
              Available Rooms ({{ rooms.length }})
            </h4>
            <button
              type="button"
              @click="() => fetchRooms()"
              class="text-xs text-purple-400 hover:text-purple-300 inline-flex items-center gap-x-1"
            >
              <ArrowPathIcon
                class="size-3"
                :class="{ 'animate-spin': isLoading }"
              />
              Refresh
            </button>
          </div>

          <div
            v-if="rooms.length === 0"
            class="rounded-lg border border-dashed border-zinc-700 p-6 text-center"
          >
            <p class="text-xs text-zinc-400">
              No active rooms found for this game. Host a room above to invite
              peers!
            </p>
          </div>

          <div v-else class="space-y-2 max-h-48 overflow-y-auto pr-1">
            <div
              v-for="room in rooms"
              :key="room.id"
              class="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-850 p-3"
            >
              <div class="space-y-0.5">
                <div class="flex items-center gap-x-2">
                  <span class="font-mono text-xs text-zinc-200">
                    {{ room.id.slice(0, 8) }}...
                  </span>
                  <span
                    class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 uppercase"
                  >
                    {{ room.mesh.backend }}
                  </span>
                </div>
                <p class="text-[11px] text-zinc-500">
                  {{ room.memberCount ?? 1 }} player(s) &bull;
                  {{ formatExpiresIn(room.expiresAt) }}
                </p>
              </div>

              <button
                type="button"
                @click="() => handleJoinRoom(room.id)"
                :disabled="isLoading || !consent"
                class="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-600 hover:text-white transition disabled:opacity-50"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="error" class="mt-3 rounded-md bg-red-600/10 p-3">
        <p class="text-xs text-red-400">{{ error }}</p>
      </div>
    </template>

    <template #buttons>
      <button
        type="button"
        class="inline-flex w-full justify-center rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-100 shadow-sm ring-1 ring-inset ring-zinc-700 hover:bg-zinc-700 sm:w-auto"
        @click="isOpen = false"
      >
        Close
      </button>
    </template>
  </ModalTemplate>
</template>

<script setup lang="ts">
import {
  UserGroupIcon,
  PlayIcon,
  PlusIcon,
  ArrowPathIcon,
} from "@heroicons/vue/20/solid";
import { useGseMultiplayer } from "~/composables/useGseMultiplayer";

const props = defineProps<{
  gameId: string;
  gameName: string;
  versionId: string;
  installDir: string;
  appId?: number;
}>();

const emit = defineEmits<{
  (e: "launch"): void;
}>();

const isOpen = defineModel<boolean>({ default: false });
const selectedBackend = ref<"tailscale" | "zerotier">("tailscale");
const consent = ref(false);

const {
  rooms,
  currentRoom,
  isLoading,
  error,
  fetchRooms,
  hostRoom,
  joinRoom,
  leaveRoom,
  syncRoomConfigToDisk,
  startLiveUpdates,
  stopLiveUpdates,
} = useGseMultiplayer(props.gameId);

watch(
  isOpen,
  async (open) => {
    if (open) {
      await fetchRooms();
      await startLiveUpdates();
    } else {
      stopLiveUpdates();
    }
  },
  { immediate: true },
);

async function handleHostRoom() {
  await hostRoom(props.versionId, selectedBackend.value, props.appId);
  if (currentRoom.value && props.installDir) {
    await syncRoomConfigToDisk(props.installDir, currentRoom.value);
  }
}

async function handleJoinRoom(roomId: string) {
  await joinRoom(roomId);
  if (currentRoom.value && props.installDir) {
    await syncRoomConfigToDisk(props.installDir, currentRoom.value);
  }
}

async function handleLeaveRoom() {
  if (currentRoom.value) {
    await leaveRoom(currentRoom.value.id);
  }
}

async function handleLaunchWithRoom() {
  if (currentRoom.value && props.installDir) {
    await syncRoomConfigToDisk(props.installDir, currentRoom.value);
  }
  isOpen.value = false;
  emit("launch");
}

function formatExpiresIn(expiresAt: number): string {
  const diffMinutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (diffMinutes < 60) {
    return `${diffMinutes}m remaining`;
  }
  const hours = Math.floor(diffMinutes / 60);
  return `${hours}h remaining`;
}
</script>
