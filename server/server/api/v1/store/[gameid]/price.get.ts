import { pricingManager } from "~/server/internal/commerce";

export default defineEventHandler(async (h3) => {
  const gameId = getRouterParam(h3, "gameid");
  if (!gameId)
    throw createError({ statusCode: 400, statusMessage: "gameId is required" });

  const currency = (getQuery(h3).currency as string | undefined) ?? "USD";
  const price = await pricingManager.resolvePrice(gameId, currency);
  return { gameId, currency: currency.toUpperCase(), price };
});
