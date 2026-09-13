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

  private async send(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<Awaited<ReturnType<FetchLike>>> {
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
    return response;
  }

  /** Send a request and discard any body (used for DELETE). */
  private async request(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<void> {
    await this.send(url, init);
  }

  private async json<T>(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<T> {
    const response = await this.send(url, init);
    return (await response.json()) as T;
  }

  /**
   * Resolve a room's network id from live state or persisted mesh info, caching
   * it so a restarted coordinator can still authorize/revoke/tear down.
   */
  private networkIdFor(
    roomId: string,
    mesh?: PublicMeshInfo,
  ): string | undefined {
    const persisted = mesh?.backend === "zerotier" ? mesh.networkId : undefined;
    const networkId = this.networks.get(roomId) ?? persisted;
    if (networkId) this.networks.set(roomId, networkId);
    return networkId;
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
    mesh?: PublicMeshInfo,
  ): Promise<string | undefined> {
    const networkId = this.networkIdFor(roomId, mesh);
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

  async revokeMember(
    roomId: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void> {
    const networkId = this.networkIdFor(roomId, mesh);
    // Prefer the persisted node id so revocation survives a coordinator restart.
    const nodeId = memberId ?? this.memberIds.get(roomId)?.get(userId);
    this.memberIds.get(roomId)?.delete(userId);
    if (!networkId || !nodeId) return;
    await this.request(this.orgUrl(`/${networkId}/member/${nodeId}`), {
      method: "DELETE",
    });
  }

  async teardown(roomId: string, mesh?: PublicMeshInfo): Promise<void> {
    const networkId = this.networkIdFor(roomId, mesh);
    this.memberIds.delete(roomId);
    if (!networkId) return;
    this.networks.delete(roomId);
    await this.request(this.orgUrl(`/${networkId}`), { method: "DELETE" });
  }
}
