import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import commerceManager from "~/server/internal/commerce";

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const orderId = getRouterParam(h3, "orderid");
  if (!orderId)
    throw createError({
      statusCode: 400,
      statusMessage: "orderId is required",
    });

  return await commerceManager.getReceipt(user.id, orderId);
});
