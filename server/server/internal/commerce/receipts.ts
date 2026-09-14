import { sign, verify } from "node:crypto";

/**
 * Ed25519 purchase receipts (#21). The server signs an order receipt so a
 * client or federated instance can verify a purchase without trusting the
 * transport. Receipts are canonicalised before signing so both sides agree on
 * the exact bytes.
 */
export interface PurchaseReceipt {
  orderId: string;
  userId: string;
  gameId: string;
  amount: number;
  currency: string;
  issuedAt: string;
}

/** Deterministic JSON with sorted keys, used as the signed payload. */
export function canonicalizeReceipt(receipt: PurchaseReceipt): string {
  return JSON.stringify({
    amount: receipt.amount,
    currency: receipt.currency,
    gameId: receipt.gameId,
    issuedAt: receipt.issuedAt,
    orderId: receipt.orderId,
    userId: receipt.userId,
  });
}

/** Returns a base64 Ed25519 signature over the canonical receipt. */
export function signReceipt(
  receipt: PurchaseReceipt,
  privateKeyPem: string,
): string {
  const signature = sign(
    null,
    Buffer.from(canonicalizeReceipt(receipt)),
    privateKeyPem,
  );
  return signature.toString("base64");
}

/** Verifies a base64 Ed25519 signature against the canonical receipt. */
export function verifyReceipt(
  receipt: PurchaseReceipt,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalizeReceipt(receipt)),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
