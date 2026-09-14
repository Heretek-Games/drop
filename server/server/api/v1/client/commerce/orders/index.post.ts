import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import commerceManager from "~/server/internal/commerce";

interface CreateOrderBody {
  gameId?: string;
  amount?: number;
  currency?: string;
  gateway?: string;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  const body = ((await readBody<CreateOrderBody>(h3)) ?? {}) as CreateOrderBody;
  if (
    typeof body.gameId !== "string" ||
    typeof body.amount !== "number" ||
    typeof body.currency !== "string" ||
    typeof body.gateway !== "string"
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "gameId, amount, currency and gateway are required",
    });
  }

  const result = await commerceManager.createOrder({
    userId: user.id,
    gameId: body.gameId,
    amount: body.amount,
    currency: body.currency,
    gateway: body.gateway,
  });
  return { success: true, ...result };
});
