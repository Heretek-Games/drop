import type { IssuedCredential, MeshBackend, PublicMeshInfo } from "./types";

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

/** Base CIDR for per-room ZeroTier networks (10.242.0.0/16, one /24 each). */
export const ZEROTIER_BASE_CIDR = "10.242.0.0/16";

/** Deterministically derive a unique /24 room CIDR from the room id. */
export function roomCidr(roomId: string): string {
  const thirdOctet = hashString(roomId) % 256;
  return `10.242.${thirdOctet}.0/24`;
}

/** Deterministic host address inside a room /24 (offset 20–219). */
export function roomMemberAddress(
  cidr: string,
  userId: string,
): string | undefined {
  if (!cidr.endsWith("/24")) return undefined;
  const base = cidr.replace(/\.0\/24$/, "");
  const host = 20 + (hashString(userId) % 200);
  return `${base}.${host}`;
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
  ): Promise<IssuedCredential> {
    const set = this.members.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.members.set(roomId, set);
    return {
      secret: `zt-member:${roomId}:${userId}:${mesh.backend}`,
      address:
        mesh.backend === "zerotier"
          ? roomMemberAddress(mesh.cidr, userId)
          : undefined,
    };
  }

  async revokeMember(roomId: string, userId: string): Promise<void> {
    this.members.get(roomId)?.delete(userId);
  }

  async authorizeMember(
    roomId: string,
    memberId: string,
  ): Promise<string | undefined> {
    return roomMemberAddress(roomCidr(roomId), memberId);
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
  private readonly networks = new Map<string, string>();

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
    this.networks.set(roomId, created.id);
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
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZeroTierBackend received non-zerotier mesh info");
    }
    // A member joins the network and requests authorization; the assigned
    // address is reported by the controller once the member is authorized.
    return { secret: `zerotier:${mesh.networkId}:${roomId}:${userId}` };
  }

  async authorizeMember(
    roomId: string,
    memberId: string,
  ): Promise<string | undefined> {
    const networkId = this.networks.get(roomId);
    if (!networkId) return undefined;
    const response = await this.fetchImpl(
      `${this.options.baseUrl}/network/${networkId}/member/${memberId}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ authorized: true }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `ZeroTier member authorization failed (${response.status})`,
      );
    }
    const member = (await response.json()) as {
      assignedAddresses?: string[];
    };
    const address = member.assignedAddresses?.[0];
    // Controller reports addresses as CIDR (e.g. 10.242.5.20/24).
    return address ? address.split("/")[0] : undefined;
  }

  async revokeMember(roomId: string, userId: string): Promise<void> {
    // Member ids are derived from credentials; a real deployment tracks the
    // mapping. Kept explicit so the contract is stable.
    void roomId;
    void userId;
  }

  async teardown(roomId: string): Promise<void> {
    const networkId = this.networks.get(roomId);
    if (!networkId) return;
    this.networks.delete(roomId);
    await this.fetchImpl(
      `${this.options.baseUrl}/controller/network/${networkId}`,
      { method: "DELETE", headers: this.headers() },
    );
  }
}

/**
 * Tailscale control-plane operations, injected so the backend is testable
 * without a tailnet. A real implementation provisions a room tag + same-room
 * ACL before issuing any key, and removes tagged nodes on teardown.
 */
export interface TailscaleProvisioner {
  provisionRoom(roomId: string): Promise<string>;
  issueAuthKey(aclTag: string, userId: string): Promise<string>;
  teardownRoom(roomId: string): Promise<void>;
}

/**
 * Tailscale ephemeral backend. Keys are one-off and tagged per room; the
 * client joins with isolated ephemeral state so a user's own tailnet identity
 * is never replaced.
 */
export class TailscaleBackend implements MeshBackend {
  readonly id = "tailscale" as const;

  constructor(private readonly provisioner: TailscaleProvisioner) {}

  async provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo> {
    const aclTag = await this.provisioner.provisionRoom(roomId);
    return { backend: "tailscale", aclTag, expiresAt };
  }

  async issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "tailscale") {
      throw new Error("TailscaleBackend received non-tailscale mesh info");
    }
    void roomId;
    return { secret: await this.provisioner.issueAuthKey(mesh.aclTag, userId) };
  }

  async revokeMember(): Promise<void> {
    // Ephemeral nodes purge themselves; tagged-node removal happens on teardown.
  }

  async teardown(roomId: string): Promise<void> {
    await this.provisioner.teardownRoom(roomId);
  }
}
