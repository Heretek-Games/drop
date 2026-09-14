import test from "node:test";
import assert from "node:assert/strict";
import {
  CommerceManager,
  type CommerceDeps,
  type OrderRecord,
} from "../orders";
import type { PaymentGateway } from "../../plugins/types";

function createHarness() {
  const orders = new Map<string, OrderRecord>();
  let next = 1;

  const gateway: PaymentGateway = {
    id: "stripe",
    name: "Stripe",
    createPaymentIntent: async ({ orderId }) => ({
      intentId: `pi_${orderId}`,
      checkoutUrl: "https://pay.example/session",
      status: "pending",
    }),
    handleWebhook: async () => ({
      orderId: "",
      status: "succeeded",
      transactionId: "",
    }),
  };

  const deps: CommerceDeps = {
    prisma: {
      purchaseOrder: {
        create: async ({ data }) => {
          const record: OrderRecord = {
            id: `order-${next++}`,
            ...data,
            gatewayRef: null,
            status: "pending",
            receipt: null,
            signature: null,
            createdAt: new Date(),
            paidAt: null,
          };
          orders.set(record.id, record);
          return record;
        },
        findUnique: async ({ where }) => orders.get(where.id) ?? null,
        findMany: async ({ where }) =>
          [...orders.values()].filter((order) => order.userId === where.userId),
        update: async ({ where, data }) => {
          const order = orders.get(where.id);
          if (!order) throw new Error("missing order");
          const updated: OrderRecord = { ...order, ...data };
          orders.set(updated.id, updated);
          return updated;
        },
      },
    },
    getPaymentGateway: (id) => (id === "stripe" ? gateway : undefined),
    signReceipt: (receipt) => `sig:${receipt.orderId}:${receipt.amount}`,
  };

  return { manager: new CommerceManager(deps), orders };
}

test("createOrder validates input and creates a payment intent", async () => {
  const { manager } = createHarness();

  await assert.rejects(
    () =>
      manager.createOrder({
        userId: "u1",
        gameId: "g1",
        amount: 0,
        currency: "USD",
        gateway: "stripe",
      }),
    /positive integer/,
  );
  await assert.rejects(
    () =>
      manager.createOrder({
        userId: "u1",
        gameId: "g1",
        amount: 100,
        currency: "us",
        gateway: "stripe",
      }),
    /3-letter/,
  );
  await assert.rejects(
    () =>
      manager.createOrder({
        userId: "u1",
        gameId: "g1",
        amount: 100,
        currency: "USD",
        gateway: "unknown",
      }),
    /Unknown payment gateway/,
  );

  const result = await manager.createOrder({
    userId: "u1",
    gameId: "g1",
    amount: 1999,
    currency: "usd",
    gateway: "stripe",
  });
  assert.equal(result.order.currency, "USD");
  assert.equal(result.order.gatewayRef, `pi_${result.order.id}`);
  assert.equal(result.checkoutUrl, "https://pay.example/session");
});

test("settleOrder issues a receipt once and is idempotent", async () => {
  const { manager } = createHarness();
  const { order } = await manager.createOrder({
    userId: "u1",
    gameId: "g1",
    amount: 500,
    currency: "USD",
    gateway: "stripe",
  });

  const settled = await manager.settleOrder({
    orderId: order.id,
    status: "succeeded",
    transactionId: "txn-1",
  });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.gatewayRef, "txn-1");
  assert.equal(settled.signature, `sig:${order.id}:500`);
  assert.ok(settled.receipt);

  // Re-delivery keeps the original receipt.
  const again = await manager.settleOrder({
    orderId: order.id,
    status: "succeeded",
    transactionId: "txn-2",
  });
  assert.equal(again.signature, settled.signature);
  assert.equal(again.gatewayRef, "txn-1");
});

test("settleOrder records non-success statuses without a receipt", async () => {
  const { manager } = createHarness();
  const { order } = await manager.createOrder({
    userId: "u1",
    gameId: "g1",
    amount: 100,
    currency: "USD",
    gateway: "stripe",
  });

  const failed = await manager.settleOrder({
    orderId: order.id,
    status: "failed",
    transactionId: "txn-x",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.signature, null);
});

test("receipts are listed and scoped to their owner", async () => {
  const { manager } = createHarness();
  const { order } = await manager.createOrder({
    userId: "u1",
    gameId: "g1",
    amount: 100,
    currency: "USD",
    gateway: "stripe",
  });
  await manager.settleOrder({
    orderId: order.id,
    status: "succeeded",
    transactionId: "txn-1",
  });

  const receipts = await manager.listReceipts("u1");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt.gameId, "g1");

  const fetched = await manager.getReceipt("u1", order.id);
  assert.equal(fetched.signature, `sig:${order.id}:100`);

  await assert.rejects(
    () => manager.getReceipt("someone-else", order.id),
    /Unknown receipt/,
  );
  await assert.rejects(
    () => manager.getReceipt("u1", "missing"),
    /Unknown receipt/,
  );
});
