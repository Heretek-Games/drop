import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalizeReceipt,
  signReceipt,
  verifyReceipt,
  type PurchaseReceipt,
} from "../receipts";

const receipt: PurchaseReceipt = {
  orderId: "order-1",
  userId: "user-1",
  gameId: "game-1",
  amount: 1999,
  currency: "USD",
  issuedAt: "2026-09-14T00:00:00.000Z",
};

test("canonicalizeReceipt is key-order independent", () => {
  const reordered = {
    issuedAt: receipt.issuedAt,
    currency: receipt.currency,
    orderId: receipt.orderId,
    amount: receipt.amount,
    gameId: receipt.gameId,
    userId: receipt.userId,
  } as PurchaseReceipt;
  assert.equal(canonicalizeReceipt(receipt), canonicalizeReceipt(reordered));
});

test("sign and verify round-trip", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const signature = signReceipt(receipt, privatePem);
  assert.equal(verifyReceipt(receipt, signature, publicPem), true);
});

test("tampered receipts fail verification", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();

  const signature = signReceipt(receipt, privatePem);
  const tampered = { ...receipt, amount: 1 };
  assert.equal(verifyReceipt(tampered, signature, publicPem), false);
  assert.equal(verifyReceipt(receipt, "not-base64", publicPem), false);
});
