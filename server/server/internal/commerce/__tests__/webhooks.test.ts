import test from "node:test";
import assert from "node:assert/strict";
import { dispatchPaymentWebhook } from "../webhooks";
import type { PaymentGateway } from "../../plugins/types";

const gateway: PaymentGateway = {
  id: "stripe",
  name: "Stripe",
  createPaymentIntent: async () => ({ intentId: "pi", status: "pending" }),
  handleWebhook: async (payload) => ({
    orderId: "order-1",
    status: "succeeded",
    transactionId: "txn-1",
    payload: payload as Record<string, unknown>,
  }),
};

const lookup = {
  getPaymentGateway: (id: string) => (id === "stripe" ? gateway : undefined),
};

test("dispatches to the registered gateway and returns its result", async () => {
  const result = await dispatchPaymentWebhook(
    lookup,
    "stripe",
    { type: "checkout.completed" },
    { "stripe-signature": "sig" },
  );
  assert.equal(result.orderId, "order-1");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.payload, { type: "checkout.completed" });
});

test("rejects unknown gateways", async () => {
  await assert.rejects(
    () => dispatchPaymentWebhook(lookup, "paypal", {}, {}),
    /Unknown payment gateway/,
  );
});
