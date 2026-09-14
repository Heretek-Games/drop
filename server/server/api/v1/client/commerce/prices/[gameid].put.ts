import { defineClientEventHandler } from "~/server/internal/clients/event-handler";
import { pricingManager } from "~/server/internal/commerce";

interface SetPriceBody {
  currency?: string;
  amount?: number;
  active?: boolean;
}

export default defineClientEventHandler(async (h3, { fetchUser }) => {
  const user = await fetchUser();
  if (!user.admin) {
    throw createError({
      statusCode: 403,
      statusMessage: "Admin access required to set prices",
    });
  }
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const body = ((await readBody<SetPriceBody>(h3)) ?? {}) as SetPriceBody;
  if (typeof body.currency !== "string" || typeof body.amount !== "number") {
    throw createError({
      statusCode: 400,
      statusMessage: "currency and amount are required",
    });
  }

  const price = await pricingManager.setPrice(
    gameId,
    body.currency,
    body.amount,
    body.active ?? true,
  );
  return { success: true, price };
});
