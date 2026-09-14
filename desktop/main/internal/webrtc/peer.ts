/**
 * Client-side WebRTC peer connection (#19 zero-config multiplayer).
 *
 * The desktop webview ships a WebRTC implementation (WebView2 on Windows,
 * WebKitGTK on Linux), so peer connections use the standard `RTCPeerConnection`
 * API rather than a native stack. Signaling messages are exchanged through the
 * federation relay; ICE servers come from `GET /api/v1/client/ice`.
 */

export const SIGNALING_KINDS = ["offer", "answer", "candidate", "bye"] as const;
export type SignalingKind = (typeof SIGNALING_KINDS)[number];

export interface SignalingMessage {
  kind: SignalingKind;
  payload: unknown;
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  iceServers: IceServerConfig[];
  expiresAt?: number;
}

export function isSignalingKind(value: unknown): value is SignalingKind {
  return (
    typeof value === "string" &&
    (SIGNALING_KINDS as readonly string[]).includes(value)
  );
}

/** Build a signaling message, rejecting an empty payload. */
export function buildSignalingMessage(
  kind: SignalingKind,
  payload: unknown,
): SignalingMessage {
  if (payload === undefined || payload === null) {
    throw new Error("signaling payload is required");
  }
  return { kind, payload };
}

/** Map the server ICE response onto the browser `RTCIceServer` shape. */
export function toRtcIceServers(
  config: IceConfigResponse | undefined,
): RTCIceServer[] {
  const servers = config?.iceServers ?? [];
  return servers.map((server) => {
    const mapped: RTCIceServer = { urls: server.urls };
    if (server.username) mapped.username = server.username;
    if (server.credential) mapped.credential = server.credential;
    return mapped;
  });
}

export interface PeerEvents {
  onIceCandidate?: (candidate: RTCIceCandidateInit) => void;
  onData?: (data: string) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

/** A single peer connection with one data channel. */
export class PeerConnection {
  private readonly pc: RTCPeerConnection;
  private readonly channel: RTCDataChannel;

  constructor(config: IceConfigResponse | undefined, events: PeerEvents = {}) {
    this.pc = new RTCPeerConnection({ iceServers: toRtcIceServers(config) });
    this.channel = this.pc.createDataChannel("drop");
    this.pc.onicecandidate = (event) => {
      if (event.candidate) events.onIceCandidate?.(event.candidate.toJSON());
    };
    this.pc.onconnectionstatechange = () => {
      events.onStateChange?.(this.pc.connectionState);
    };
    this.channel.onmessage = (event) => {
      events.onData?.(
        typeof event.data === "string" ? event.data : String(event.data),
      );
    };
  }

  /** Initiator: create and store a local offer. */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Responder: accept the remote offer and return the local answer. */
  async acceptOffer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Initiator: accept the remote answer. */
  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  send(data: string): void {
    this.channel.send(data);
  }

  close(): void {
    this.channel.close();
    this.pc.close();
  }
}
