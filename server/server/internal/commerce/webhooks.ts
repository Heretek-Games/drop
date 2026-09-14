import { createError } from "h3";
import type { PaymentGateway, PaymentWebhookResult } from "../plugins/types";

/** Minimal lookup surface so the dispatcher is unit-testable. */
export interface PaymentGatewayLookup {
  getPaymentGateway(id: string): PaymentGateway | undefined;
}

/**
 * Routes an inbound provider webhook to the plugin-registered payment gateway.
 * Signature verification happens inside the gateway's `handleWebhook`, which is
 * why this stays a thin dispatch.
 */
export async function dispatchPaymentWebhook(
  lookup: PaymentGatewayLookup,
  gatewayId: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<PaymentWebhookResult> {
  const gateway = lookup.getPaymentGateway(gatewayId);
  if (!gateway) {
    throw createError({
      statusCode: 404,
      statusMessage: `Unknown payment gateway '${gatewayId}'`,
    });
  }
  return gateway.handleWebhook(payload, headers);
}
