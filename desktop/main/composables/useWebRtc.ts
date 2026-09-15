import { invoke } from "@tauri-apps/api/core";
import {
  PeerConnection,
  type IceConfigResponse,
  type PeerEvents,
} from "~/internal/webrtc/peer";

async function fetchIceConfig(): Promise<IceConfigResponse> {
  return await invoke<IceConfigResponse>("fetch_ice_config");
}

/**
 * WebRTC peer helper for the desktop webview. Fetches the ICE configuration
 * from the server and builds a `PeerConnection`; signaling messages are
 * exchanged through the federation relay.
 */
export function useWebRtc() {
  async function createPeer(events: PeerEvents = {}): Promise<PeerConnection> {
    const ice = await fetchIceConfig();
    return new PeerConnection(ice, events);
  }

  return { fetchIceConfig, createPeer };
}
