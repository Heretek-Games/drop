import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import commerceManager from "~/server/internal/commerce";

export default defineClientEventHandler(async (_h3, { fetchUser }) => {
  const user = await fetchUser();
  const receipts = await commerceManager.listReceipts(user.id);
  return { receipts, count: receipts.length };
});
