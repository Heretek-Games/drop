import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import workshopManager from "~/server/internal/workshop";

export default defineClientEventHandler(async (_h3, { fetchUser }) => {
  const user = await fetchUser();
  const subscriptions = await workshopManager.listSubscriptions(user.id);
  return { subscriptions, count: subscriptions.length };
});
