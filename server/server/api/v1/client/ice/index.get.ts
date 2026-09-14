import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import { getIceConfig } from "~/server/internal/webrtc";

/**
 * ICE servers for the authenticated client's WebRTC peer connections:
 * configured STUN URLs and time-limited TURN credentials.
 */
export default defineClientEventHandler(async (_h3, { fetchUser }) => {
  const user = await fetchUser();
  return getIceConfig(user.id);
});
