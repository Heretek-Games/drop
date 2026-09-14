import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import presenceManager from "~/server/internal/presence";

export default defineClientEventHandler(async (_h3, { fetchUser }) => {
  const user = await fetchUser();
  const cleared = await presenceManager.clear(user.id);
  return { success: true, cleared };
});
