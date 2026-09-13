import type { MeshBackend, PublicMeshInfo } from "./types";

/** Base CIDR for per-room ZeroTier networks (10.242.0.0/16, one /24 each). */
export const ZEROTIER_BASE_CIDR = "10.242.0.0/16";

/** Deterministically derive a unique /24 room CIDR from the room id. */
export function roomCidr(roomId: string): string {
  let hash = 0;
  for (const char of roomId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const thirdOctet = hash % 256;
  return `10.242.${thirdOctet}.0/24`;
}

/**
 * In-memory mesh backend used for tests and local development. Produces
 * deterministic public info and opaque per-member credentials.
 */
export class InMemoryMeshBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly members = new Map<string, Set<string>>();

  async provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo> {
    return {
      backend: "zerotier",
      cidr: roomCidr(roomId),
      networkId: `zt-${roomId.slice(0, 16)}`,
      expiresAt,
    };
  }

  async issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<string> {
    const set = this.members.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.members.set(roomId, set);
    return `zt-member:${roomId}:${userId}:${mesh.backend}`;
  }

  async revokeMember(roomId: string, userId: string): Promise<void> {
    this.members.get(roomId)?.delete(userId);
  }

  async teardown(roomId: string): Promise<void> {
    this.members.delete(roomId);
  }

  memberCount(roomId: string): number {
    return this.members.get(roomId)?.size ?? 0;
  }
}

/** Minimal fetch surface so the controller client is testable. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface ZeroTierControllerOptions {
  /** Controller service API base, e.g. http://localhost:9993. */
  baseUrl: string;
  /** Contents of authtoken.secret. */
  authToken: string;
  /** Controller node id (see ZeroTier API `POST /controller/network`). */
  controllerNodeId: string;
  fetchImpl?: FetchLike;
}

/**
 * ZeroTier self-hosted controller backend.
 *
 * Network id format: `<controllerNodeId>` + six underscores, after which the
 * controller generates the network id.
 */
export class ZeroTierBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ZeroTierControllerOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      "X-ZT1-AUTH": this.options.authToken,
      "Content-Type": "application/json",
    };
  }

  async provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo> {
    const url = `${this.options.baseUrl}/controller/network/${this.options.controllerNodeId}______`;
    const cidr = roomCidr(roomId);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: `drop-gse-${roomId}`,
        private: true,
        enableBroadcast: true,
        v4AssignMode: { zt: true },
        ipAssignmentPools: [
          {
            ipRangeStart: cidr.replace(/\.0\/24$/, ".1"),
            ipRangeEnd: cidr.replace(/\.0\/24$/, ".254"),
          },
        ],
        routes: [{ target: cidr, via: null }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `ZeroTier network creation failed (${response.status}): ${await response.text()}`,
      );
    }
    const created = (await response.json()) as { id?: string };
    if (!created?.id) {
      throw new Error("ZeroTier network creation returned no network id");
    }
    return {
      backend: "zerotier",
      cidr,
      networkId: created.id,
      expiresAt,
    };
  }

  async issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<string> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZeroTierBackend received non-zerotier mesh info");
    }
    // A member joins the network and requests authorization. The generated
    // member identity is the credential secret; the controller authorizes it.
    return `zerotier:${mesh.networkId}:${roomId}:${userId}`;
  }

  async revokeMember(roomId: string, userId: string): Promise<void> {
    // Member ids are derived from credentials; a real deployment tracks the
    // mapping. Kept explicit so the contract is stable.
    void roomId;
    void userId;
  }

  async teardown(roomId: string): Promise<void> {
    void roomId;
    // Requires the network id; the coordinator passes it to a backend-specific
    // deletion in a later iteration.
  }
}
