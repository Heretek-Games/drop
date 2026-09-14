import { createError } from "h3";
import prisma from "../db/database";
import pluginManager from "../plugins";
import { CommerceManager, type CommerceDeps } from "./orders";
import { signReceipt, type PurchaseReceipt } from "./receipts";

export const RECEIPT_SIGNING_KEY_ENV = "DROP_RECEIPT_SIGNING_KEY";

/** Signs a receipt with the operator-supplied Ed25519 key (fail-closed). */
function signWithConfiguredKey(receipt: PurchaseReceipt): string {
  const key = process.env[RECEIPT_SIGNING_KEY_ENV];
  if (!key || key.trim().length === 0) {
    throw createError({
      statusCode: 500,
      statusMessage: "Receipt signing key is not configured",
    });
  }
  return signReceipt(receipt, key);
}

const deps: CommerceDeps = {
  prisma: prisma as unknown as CommerceDeps["prisma"],
  getPaymentGateway: (id) => pluginManager.getPaymentGateway(id),
  signReceipt: signWithConfiguredKey,
};

export const commerceManager = new CommerceManager(deps);
export { CommerceManager };
export type {
  CommerceDeps,
  CreateOrderInput,
  IssuedReceipt,
  OrderRecord,
} from "./orders";
export {
  canonicalizeReceipt,
  signReceipt,
  verifyReceipt,
  type PurchaseReceipt,
} from "./receipts";
export { dispatchPaymentWebhook } from "./webhooks";
export default commerceManager;
