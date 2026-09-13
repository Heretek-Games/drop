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

export interface MeshBackendInfo {
  backend: "zerotier" | "tailscale";
  memory: boolean;
}

export const useGseMultiplayer = (gameId: string) => {
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  /** The backend this Drop deployment is configured with (server-side). */
  const activeBackend = ref<MeshBackendInfo | null>(null);
  /** This client's assigned mesh address (set once the server authorizes it). */
  const selfAddress = ref<string | null>(null);
  const selfNetworkId = ref<string | null>(null);
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

  /** Fetch the server-configured mesh backend (there is one per deployment). */
  async function fetchBackend(): Promise<MeshBackendInfo | null> {
    try {
      const res = await invoke<MeshBackendInfo>("plugin_request", {
        pluginId: "drop-gse",
        method: "GET",
        path: "/backend",
      });
      activeBackend.value = res;
      return res;
    } catch {
      return null;
    }
  }

  async function hostRoom(
    versionId: string,
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
   * Join the room's ZeroTier network via the local ZeroTier One service. The
   * credential encodes the network id as `zerotier:<nwid>:<room>:<user>`.
   * Returns this node's ZeroTier address (needed to authorize the member), or
   * null when the mesh is not ZeroTier or ZeroTier is unavailable.
   */
  async function joinMesh(secret: string): Promise<string | null> {
    if (!secret.startsWith("zerotier:")) return null;
    const networkId = secret.split(":")[1];
    if (!networkId) return null;
    selfNetworkId.value = networkId;
    try {
      return await invoke<string>("gse_mesh_join", { networkId });
    } catch (e) {
      error.value = (e as string).toString();
      return null;
    }
  }

  /**
   * Report this node's ZeroTier address to the coordinator so it authorizes
   * the member on the room's controller and assigns a deterministic address.
   */
  async function reportMember(roomId: string, memberId: string): Promise<void> {
    try {
      const res = await invoke<{ room?: GseRoom; address?: string }>(
        "plugin_request",
        {
          pluginId: "drop-gse",
          method: "POST",
          path: `/rooms/${roomId}/member`,
          body: { memberId },
        },
      );
      if (res.address) selfAddress.value = res.address;
      if (res.room) currentRoom.value = res.room;
    } catch (e) {
      error.value = (e as string).toString();
    }
  }

  /**
   * Apply a server credential: record any backend-assigned address, join the
   * ZeroTier network, then report this node so the coordinator authorizes it.
   * The address is often only assigned at authorization time (ZTNET), so the
   * report step is what makes `meshReady` true.
   */
  async function applyCredential(
    roomId: string,
    credential: { secret: string; address?: string },
  ): Promise<void> {
    if (credential.address) selfAddress.value = credential.address;
    const nodeId = await joinMesh(credential.secret);
    if (nodeId) await reportMember(roomId, nodeId);
  }

  async function requestCredential(
    roomId: string,
  ): Promise<{ secret: string; address?: string } | null> {
    // Prefer authenticated WebSocket delivery; fall back to the HTTP endpoint.
    try {
      const res = await invoke<{
        ok?: boolean;
        credential?: { secret: string; address?: string };
      }>("plugin_request_ws", {
        channel: "gse:credential",
        data: { roomId },
      });
      if (res?.credential) {
        await applyCredential(roomId, res.credential);
        return res.credential;
      }
    } catch {
      // Fall through to HTTP.
    }

    try {
      const res = await invoke<{
        credential?: { secret: string; address?: string };
      }>("plugin_request", {
        pluginId: "drop-gse",
        method: "POST",
        path: `/rooms/${roomId}/credential`,
      });
      if (res.credential) {
        await applyCredential(roomId, res.credential);
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
      if (selfNetworkId.value) {
        try {
          await invoke("gse_mesh_leave", {
            networkId: selfNetworkId.value,
          });
        } catch {
          // Best-effort; the network also expires server-side.
        }
        selfNetworkId.value = null;
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
    const activeRoom = roomToActiveRoom(room, selfAddress.value ?? undefined);
    await invoke("gse_write_room_config", {
      installDir,
      peerIps: activeRoom.peers,
      appId: activeRoom.appId,
      flavor: room.emulator.flavor,
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
    activeBackend,
    selfAddress,
    selfNetworkId,
    meshReady,
    isLoading,
    error,
    fetchBackend,
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
