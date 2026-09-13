import { invoke } from "@tauri-apps/api/core";

export interface EmulatorBinding {
  flavor: "gbe_fork" | "gse_fork";
  release: string;
  releaseDigest: string;
}

export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

export interface RoomMember {
  userId: string;
  meshAddress?: string;
  joinedAt: number;
}

export interface GseRoom {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  hostUserId?: string;
  members?: RoomMember[];
  memberCount?: number;
  mesh: PublicMeshInfo;
  createdAt: number;
  expiresAt: number;
}

const activeRoomsMap = ref<{ [gameId: string]: GseRoom[] }>({});
const currentRoomMap = ref<{ [gameId: string]: GseRoom | null }>({});

export const useGseMultiplayer = (gameId: string) => {
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  if (!activeRoomsMap.value[gameId]) {
    activeRoomsMap.value[gameId] = [];
  }
  if (!currentRoomMap.value[gameId]) {
    currentRoomMap.value[gameId] = null;
  }

  const rooms = computed(() => activeRoomsMap.value[gameId] ?? []);
  const currentRoom = computed({
    get: () => currentRoomMap.value[gameId] ?? null,
    set: (val: GseRoom | null) => {
      currentRoomMap.value[gameId] = val;
    },
  });

  async function fetchRooms(): Promise<GseRoom[]> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await invoke<{ rooms: GseRoom[] }>("plugin_request", {
        pluginId: "drop-gse",
        method: "GET",
        path: `/rooms?gameId=${encodeURIComponent(gameId)}`,
      });
      activeRoomsMap.value[gameId] = res.rooms ?? [];
      return activeRoomsMap.value[gameId];
    } catch (e) {
      error.value = (e as string).toString();
      return [];
    } finally {
      isLoading.value = false;
    }
  }

  async function hostRoom(
    versionId: string,
    backend: "tailscale" | "zerotier" = "tailscale",
  ): Promise<GseRoom | null> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await invoke<{ room: GseRoom }>("plugin_request", {
        pluginId: "drop-gse",
        method: "POST",
        path: "/rooms",
        body: {
          gameId,
          versionId,
          backend,
          emulator: {
            flavor: "gbe_fork",
            release: "latest",
            releaseDigest: "sha256-default",
          },
        },
      });

      if (res.room) {
        currentRoom.value = res.room;
        await fetchRooms();
      }
      return res.room;
    } catch (e) {
      error.value = (e as string).toString();
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function joinRoom(roomId: string): Promise<GseRoom | null> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await invoke<{ room: GseRoom }>("plugin_request", {
        pluginId: "drop-gse",
        method: "POST",
        path: `/rooms/${roomId}/join`,
      });

      if (res.room) {
        currentRoom.value = res.room;
        await fetchRooms();
      }
      return res.room;
    } catch (e) {
      error.value = (e as string).toString();
      return null;
    } finally {
      isLoading.value = false;
    }
  }

  async function leaveRoom(roomId: string): Promise<boolean> {
    isLoading.value = true;
    error.value = null;
    try {
      await invoke("plugin_request", {
        pluginId: "drop-gse",
        method: "DELETE",
        path: `/rooms/${roomId}`,
      });
      if (currentRoom.value?.id === roomId) {
        currentRoom.value = null;
      }
      await fetchRooms();
      return true;
    } catch (e) {
      error.value = (e as string).toString();
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  async function syncRoomConfigToDisk(
    installDir: string,
    room: GseRoom,
  ): Promise<void> {
    const peerIps = (room.members ?? [])
      .map((m) => m.meshAddress)
      .filter((addr): addr is string => Boolean(addr));

    await invoke("gse_write_room_config", {
      installDir,
      peerIps,
    });
  }

  return {
    rooms,
    currentRoom,
    isLoading,
    error,
    fetchRooms,
    hostRoom,
    joinRoom,
    leaveRoom,
    syncRoomConfigToDisk,
  };
};
