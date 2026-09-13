import type { GseRoom } from "./composables/useGseMultiplayer";

/**
 * Frozen Track A <-> Track B contract.
 *
 * Track A (GSE for games) patches the emulator and writes peer addresses into
 * `custom_broadcasts.txt`. Track B (LAN emulation) is the mesh that produces
 * those peer addresses. An empty `peers` list is valid and means LAN/offline
 * emulator mode with no mesh.
 */

/** Mesh backends a room can be provisioned on. */
export type MeshBackend = "tailscale" | "zerotier" | "byo";

export interface ActiveRoom {
  roomId: string;
  backend: MeshBackend;
  /** Mesh addresses of room peers, written to `custom_broadcasts.txt`. */
  peers: string[];
  /** This node's address inside the room mesh, when known. */
  selfAddress?: string;
  credentialExpiresAt: number;
}

/** Anything that can tell the engine which room (if any) is active. */
export interface PeerSource {
  getActiveRoom(): Promise<ActiveRoom | null>;
}

/**
 * Map a server room view onto the contract. Rooms whose members have no
 * assigned mesh address yield empty `peers` (LAN/offline mode).
 */
export function roomToActiveRoom(room: GseRoom): ActiveRoom {
  const peers = (room.members ?? [])
    .map((member) => member.meshAddress)
    .filter((address): address is string => Boolean(address));

  return {
    roomId: room.id,
    backend: room.mesh.backend,
    peers,
    selfAddress: undefined,
    credentialExpiresAt: room.expiresAt,
  };
}
