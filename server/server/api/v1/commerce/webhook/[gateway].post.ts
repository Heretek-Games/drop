import pluginManager from "~/server/internal/plugins";
import commerceManager from "~/server/internal/commerce";
import { dispatchPaymentWebhook } from "~/server/internal/commerce/webhooks";

/**
 * Provider-facing payment webhook endpoint. Public by design: each gateway
 * verifies its own signature inside `handleWebhook`.
 */
export default defineEventHandler(async (h3) => {
  const gatewayId = getRouterParam(h3, "gateway");
  if (!gatewayId) {
    throw createError({
      statusCode: 400,
      statusMessage: "No gateway in route",
    });
  }

  const raw = (await readRawBody(h3, "utf8")) ?? "";
  let payload: unknown = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Leave `payload` as the raw body for gateways that verify raw bytes.
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(h3.node.req.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    }
  }

  const result = await dispatchPaymentWebhook(
    pluginManager,
    gatewayId,
    payload,
    headers,
  );

  // Mark the order paid and issue the ownership receipt. An unknown order (for
  // example a sandbox event) must not fail the provider's webhook delivery.
  try {
    await commerceManager.settleOrder(result);
  } catch (error) {
    console.warn("commerce webhook could not settle order:", error);
  }

  return result;
});
