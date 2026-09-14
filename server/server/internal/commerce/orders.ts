import { createError } from "h3";
import type { PurchaseReceipt } from "./receipts";
import type { PaymentGateway, PaymentWebhookResult } from "../plugins/types";

/**
 * Indie commerce purchase orders (#21).
 *
 * An order is created before payment and handed to a plugin-registered
 * `PaymentGateway` for a payment intent. When the provider webhook reports
 * success, the server issues an Ed25519-signed ownership receipt (see
 * `receipts.ts`) and marks the order paid. The receipt is portable and can be
 * verified offline against the server's public key.
 */

export interface OrderRecord {
  id: string;
  userId: string;
  gameId: string;
  amount: number;
  currency: string;
  gateway: string;
  gatewayRef?: string | null;
  status: string;
  receipt?: string | null;
  signature?: string | null;
  createdAt: Date;
  paidAt?: Date | null;
}

export interface IssuedReceipt {
  orderId: string;
  receipt: PurchaseReceipt;
  signature: string;
}

export interface CreateOrderInput {
  userId: string;
  gameId: string;
  amount: number;
  currency: string;
  gateway: string;
}

/** Dependency surface kept structural so the manager is unit-testable. */
export interface CommerceDeps {
  prisma: {
    purchaseOrder: {
      create(args: {
        data: {
          userId: string;
          gameId: string;
          amount: number;
          currency: string;
          gateway: string;
        };
      }): Promise<OrderRecord>;
      findUnique(args: { where: { id: string } }): Promise<OrderRecord | null>;
      findMany(args: {
        where: { userId: string };
        orderBy: { createdAt: "asc" | "desc" };
      }): Promise<OrderRecord[]>;
      update(args: {
        where: { id: string };
        data: {
          status?: string;
          gatewayRef?: string | null;
          receipt?: string | null;
          signature?: string | null;
          paidAt?: Date | null;
        };
      }): Promise<OrderRecord>;
    };
  };
  getPaymentGateway(id: string): PaymentGateway | undefined;
  signReceipt(receipt: PurchaseReceipt): string;
}

function parseReceipt(order: OrderRecord): IssuedReceipt {
  if (!order.receipt || !order.signature) {
    throw createError({
      statusCode: 500,
      statusMessage: "Paid order is missing its receipt",
    });
  }
  return {
    orderId: order.id,
    receipt: JSON.parse(order.receipt) as PurchaseReceipt,
    signature: order.signature,
  };
}

export class CommerceManager {
  constructor(private readonly deps: CommerceDeps) {}

  async createOrder(input: CreateOrderInput): Promise<{
    order: OrderRecord;
    checkoutUrl?: string;
    clientSecret?: string;
  }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw createError({
        statusCode: 400,
        statusMessage: "amount must be a positive integer in minor units",
      });
    }
    if (!/^[A-Za-z]{3}$/.test(input.currency)) {
      throw createError({
        statusCode: 400,
        statusMessage: "currency must be a 3-letter ISO code",
      });
    }
    const gateway = this.deps.getPaymentGateway(input.gateway);
    if (!gateway) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown payment gateway '${input.gateway}'`,
      });
    }

    const currency = input.currency.toUpperCase();
    const order = await this.deps.prisma.purchaseOrder.create({
      data: {
        userId: input.userId,
        gameId: input.gameId,
        amount: input.amount,
        currency,
        gateway: input.gateway,
      },
    });

    const intent = await gateway.createPaymentIntent({
      orderId: order.id,
      amount: input.amount,
      currency,
      metadata: { userId: input.userId, gameId: input.gameId },
    });

    const updated = await this.deps.prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { gatewayRef: intent.intentId, status: intent.status },
    });

    return {
      order: updated,
      checkoutUrl: intent.checkoutUrl,
      clientSecret: intent.clientSecret,
    };
  }

  /**
   * Apply a provider webhook result. On success the ownership receipt is issued
   * exactly once; repeat deliveries are idempotent.
   */
  async settleOrder(result: PaymentWebhookResult): Promise<OrderRecord> {
    const order = await this.deps.prisma.purchaseOrder.findUnique({
      where: { id: result.orderId },
    });
    if (!order) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown order '${result.orderId}'`,
      });
    }

    if (result.status !== "succeeded") {
      return this.deps.prisma.purchaseOrder.update({
        where: { id: order.id },
        data: { status: result.status },
      });
    }

    if (order.status === "succeeded" && order.signature) {
      return order;
    }

    const receipt: PurchaseReceipt = {
      orderId: order.id,
      userId: order.userId,
      gameId: order.gameId,
      amount: order.amount,
      currency: order.currency,
      issuedAt: new Date().toISOString(),
    };
    const signature = this.deps.signReceipt(receipt);

    return this.deps.prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: "succeeded",
        gatewayRef: result.transactionId || order.gatewayRef,
        receipt: JSON.stringify(receipt),
        signature,
        paidAt: new Date(),
      },
    });
  }

  /** All signed ownership receipts for a user's paid orders. */
  async listReceipts(userId: string): Promise<IssuedReceipt[]> {
    const orders = await this.deps.prisma.purchaseOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return orders
      .filter((order) => order.status === "succeeded" && order.signature)
      .map(parseReceipt);
  }

  /** One receipt, scoped to its owner (404 for anyone else or unpaid orders). */
  async getReceipt(userId: string, orderId: string): Promise<IssuedReceipt> {
    const order = await this.deps.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
    });
    if (!order || order.userId !== userId || order.status !== "succeeded") {
      throw createError({ statusCode: 404, statusMessage: "Unknown receipt" });
    }
    return parseReceipt(order);
  }
}
