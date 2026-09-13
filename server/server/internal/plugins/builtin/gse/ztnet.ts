import { type FetchLike, roomCidr, roomMemberAddress } from "./mesh";
import type { IssuedCredential, MeshBackend, PublicMeshInfo } from "./types";

export interface ZtnetBackendOptions {
  /** ZTNET base URL, e.g. `http://ztnet:3000`. */
  baseUrl: string;
  /** Organization API token (`x-ztnet-auth`). */
  apiToken: string;
  /** ZTNET organization id that owns the room networks. */
  organizationId: string;
  fetchImpl?: FetchLike;
}

interface ZtnetNetworkResponse {
  nwid?: string;
  id?: string;
}

interface ZtnetMemberResponse {
  ipAssignments?: string[];
}

/**
 * ZTNET-managed ZeroTier controller backend.
 *
 * ZTNET sits in front of a self-hosted `zerotier-one` controller. Networks are
 * created via the org API and configured in a second call (the create endpoint
 * only accepts a name); members are authorized by node id. All requests use the
 * `x-ztnet-auth` organization token.
 *
 * Note: ZTNET's network update schema does not expose `enableBroadcast`; LAN
 * discovery is delivered through the module's unicast `custom_broadcasts.txt`.
 */
export class ZtnetBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly networks = new Map<string, string>();
  /** roomId → (userId → member node id), for revocation. */
  private readonly memberIds = new Map<string, Map<string, string>>();

  constructor(private readonly options: ZtnetBackendOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "x-ztnet-auth": this.options.apiToken,
      "Content-Type": "application/json",
    };
  }

  private orgUrl(suffix = ""): string {
    return `${this.baseUrl}/api/v1/org/${this.options.organizationId}/network${suffix}`;
  }

  private async json<T>(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: this.headers(),
      body: init?.body,
    });
    if (!response.ok) {
      throw new Error(
        `ZTNET request failed (${response.status}) ${url}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  async provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo> {
    const created = await this.json<ZtnetNetworkResponse>(this.orgUrl(), {
      method: "POST",
      body: JSON.stringify({ name: `drop-gse-${roomId}` }),
    });
    const networkId = created.nwid ?? created.id;
    if (!networkId) {
      throw new Error("ZTNET network creation returned no network id");
    }

    const cidr = roomCidr(roomId);
    await this.json<ZtnetNetworkResponse>(this.orgUrl(`/${networkId}`), {
      method: "POST",
      body: JSON.stringify({
        name: `drop-gse-${roomId}`,
        private: true,
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

    this.networks.set(roomId, networkId);
    return {
      backend: "zerotier",
      cidr,
      networkId,
      expiresAt,
    };
  }

  async issueCredential(
    roomId: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZtnetBackend received non-zerotier mesh info");
    }
    // The client joins the network with the nwid; ZTNET authorizes the node
    // once it reports its member id (see `authorizeMember`).
    return { secret: `zerotier:${mesh.networkId}:${roomId}:${userId}` };
  }

  async authorizeMember(
    roomId: string,
    userId: string,
    memberId: string,
  ): Promise<string | undefined> {
    const networkId = this.networks.get(roomId);
    if (!networkId) return undefined;

    // Assign a deterministic address from the room pool at authorization time;
    // the controller does not auto-assign until the node actually joins, and
    // peers need known addresses for `custom_broadcasts.txt`.
    const assigned = roomMemberAddress(roomCidr(roomId), memberId);

    const member = await this.json<ZtnetMemberResponse>(
      this.orgUrl(`/${networkId}/member/${memberId}`),
      {
        method: "POST",
        body: JSON.stringify({
          authorized: true,
          ...(assigned ? { ipAssignments: [assigned] } : {}),
        }),
      },
    );

    const roomMembers = this.memberIds.get(roomId) ?? new Map<string, string>();
    roomMembers.set(userId, memberId);
    this.memberIds.set(roomId, roomMembers);

    // ZTNET returns plain IPs (no CIDR suffix).
    return member.ipAssignments?.[0] ?? assigned;
  }

  async revokeMember(roomId: string, userId: string): Promise<void> {
    const networkId = this.networks.get(roomId);
    const memberId = this.memberIds.get(roomId)?.get(userId);
    if (!networkId || !memberId) return;
    this.memberIds.get(roomId)?.delete(userId);
    await this.fetchImpl(this.orgUrl(`/${networkId}/member/${memberId}`), {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async teardown(roomId: string, mesh?: PublicMeshInfo): Promise<void> {
    const networkId =
      (mesh?.backend === "zerotier" ? mesh.networkId : undefined) ??
      this.networks.get(roomId);
    this.memberIds.delete(roomId);
    if (!networkId) return;
    this.networks.delete(roomId);
    await this.fetchImpl(this.orgUrl(`/${networkId}`), {
      method: "DELETE",
      headers: this.headers(),
    });
  }
}
