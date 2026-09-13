import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { roomToActiveRoom } from "~/gse-contract";

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
  appId?: number;
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
  /** This client's assigned mesh address (set once the server authorizes it). */
  const selfAddress = ref<string | null>(null);
  const meshReady = computed(() => selfAddress.value !== null);

  if (!activeRoomsMap.value[gameId]) {
    activeRoomsMap.value[gameId] = [];
  }
  if (!currentRoomMap.value[gameId]) {
    currentRoomMap.value[gameId] = null;
  }

  let liveUnlisten: (() => void) | null = null;

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
    appId?: number,
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
          appId,
          emulator: {
            flavor: "gbe_fork",
            release: "latest",
            releaseDigest: "sha256-default",
          },
        },
      });

      if (res.room) {
        currentRoom.value = res.room;
        await requestCredential(res.room.id);
        await refreshRoom(res.room.id);
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
        await requestCredential(res.room.id);
        await refreshRoom(res.room.id);
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

  /**
   * Request this member's mesh credential. This is what causes the server to
   * assign the member a mesh address (reflected in the room member list).
   */
  async function requestCredential(
    roomId: string,
  ): Promise<{ secret: string; address?: string } | null> {
    try {
      const res = await invoke<{
        credential?: { secret: string; address?: string };
      }>("plugin_request", {
        pluginId: "drop-gse",
        method: "POST",
        path: `/rooms/${roomId}/credential`,
      });
      if (res.credential) {
        // The assigned address is this client's mesh-membership proof.
        selfAddress.value = res.credential.address ?? null;
        return res.credential;
      }
      return null;
    } catch (e) {
      error.value = (e as string).toString();
      return null;
    }
  }

  /** Re-fetch the room as a member so new peer addresses become visible. */
  async function refreshRoom(roomId: string): Promise<GseRoom | null> {
    try {
      const res = await invoke<{ room: GseRoom }>("plugin_request", {
        pluginId: "drop-gse",
        method: "GET",
        path: `/rooms/${roomId}`,
      });
      if (res.room) {
        currentRoom.value = res.room;
      }
      return res.room ?? null;
    } catch (e) {
      error.value = (e as string).toString();
      return null;
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
        selfAddress.value = null;
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
    const activeRoom = roomToActiveRoom(room);
    await invoke("gse_write_room_config", {
      installDir,
      peerIps: activeRoom.peers,
      appId: activeRoom.appId,
    });
  }

  /**
   * Subscribe to `gse:rooms` over the plugin WebSocket gateway. Events arrive
   * via the Tauri `plugin:event` channel (the Rust side owns the socket).
   */
  async function startLiveUpdates(): Promise<void> {
    if (liveUnlisten) return;
    try {
      await invoke("plugin_subscribe", { channel: "gse:rooms" });
      liveUnlisten = await listen<{
        channel: string;
        data: { type?: string; roomId?: string };
      }>("plugin:event", (event) => {
        const payload = event.payload;
        if (payload?.channel !== "gse:rooms") return;
        const data = payload.data;
        if (
          data?.type === "room_closed" &&
          currentRoom.value?.id === data.roomId
        ) {
          currentRoom.value = null;
        }
        void fetchRooms();
      });
    } catch (e) {
      error.value = (e as string).toString();
    }
  }

  function stopLiveUpdates(): void {
    liveUnlisten?.();
    liveUnlisten = null;
  }

  return {
    rooms,
    currentRoom,
    selfAddress,
    meshReady,
    isLoading,
    error,
    fetchRooms,
    refreshRoom,
    requestCredential,
    hostRoom,
    joinRoom,
    leaveRoom,
    syncRoomConfigToDisk,
    startLiveUpdates,
    stopLiveUpdates,
  };
};
