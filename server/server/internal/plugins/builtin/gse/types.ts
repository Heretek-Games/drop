/** Shared types for the drop-gse room coordinator (Track B). */

/** Emulator distribution the room is pinned to (all members must match). */
export interface EmulatorBinding {
  flavor: "gbe_fork" | "gse_fork";
  release: string;
  releaseDigest: string;
}

/** Public mesh metadata, safe to broadcast. Never contains credentials. */
export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

export interface RoomMember {
  userId: string;
  meshAddress?: string;
  joinedAt: number;
}

export interface Room {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  hostUserId: string;
  /** Last host heartbeat (ms). Used for lease expiry/migration. */
  hostHeartbeatAt: number;
  members: RoomMember[];
  mesh: PublicMeshInfo;
  createdAt: number;
  expiresAt: number;
}

/** Sanitized room view for discovery (no member identities). */
export interface DiscoverableRoom {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  mesh: PublicMeshInfo;
  memberCount: number;
  createdAt: number;
  expiresAt: number;
}

/** Credentials are stored separately and never leave this shape. */
export interface MeshCredential {
  roomId: string;
  userId: string;
  /** Backend-specific secret (e.g. a one-off auth key or network membership). */
  secret: string;
  /** Mesh address assigned to the member, when the backend provides one. */
  address?: string | undefined;
  issuedAt: number;
  expiresAt: number;
}

/** Value returned by `MeshBackend.issueCredential`. */
export interface IssuedCredential {
  secret: string;
  address?: string | undefined;
}

/**
 * Pluggable per-room mesh provider. Implementations must be idempotent:
 * provisioning an existing room returns the same public info, and teardown of
 * an unknown room is a no-op.
 */
export interface MeshBackend {
  readonly id: PublicMeshInfo["backend"];
  provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo>;
  /** Issue (and authorize) a credential for a member; server-side only. */
  issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential>;
  /** Revoke a member's access. No-op if already gone. */
  revokeMember(roomId: string, userId: string): Promise<void>;
  /**
   * Authorize a member's node after it has joined the mesh. Returns the address
   * assigned by the backend, when it can report one.
   */
  authorizeMember?(
    roomId: string,
    memberId: string,
  ): Promise<string | undefined>;
  /** Remove every node/network for the room. */
  teardown(roomId: string): Promise<void>;
}

export function toDiscoverable(room: Room): DiscoverableRoom {
  return {
    id: room.id,
    gameId: room.gameId,
    versionId: room.versionId,
    emulator: room.emulator,
    mesh: room.mesh,
    memberCount: room.members.length,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  };
}
