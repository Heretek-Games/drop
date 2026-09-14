import { createError } from "h3";

/**
 * Storefront price tiers (#21 developer publishing).
 *
 * Prices are stored per game and currency in minor units (e.g. cents); an
 * amount of `0` marks a free title. Only active prices are resolvable, so a
 * price can be withdrawn without deleting its history.
 */

export interface PriceRecord {
  id: string;
  gameId: string;
  currency: string;
  amount: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Dependency surface kept structural so the manager is unit-testable. */
export interface PricingDeps {
  prisma: {
    gamePrice: {
      findUnique(args: {
        where: { gameId_currency: { gameId: string; currency: string } };
      }): Promise<PriceRecord | null>;
      create(args: {
        data: {
          gameId: string;
          currency: string;
          amount: number;
          active: boolean;
        };
      }): Promise<PriceRecord>;
      update(args: {
        where: { id: string };
        data: { amount?: number; active?: boolean };
      }): Promise<PriceRecord>;
      findMany(args: {
        where: { gameId: string };
        orderBy?: { currency: "asc" | "desc" };
      }): Promise<PriceRecord[]>;
    };
  };
}

function normalizeCurrency(currency: string): string {
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw createError({
      statusCode: 400,
      statusMessage: "currency must be a 3-letter ISO code",
    });
  }
  return currency.toUpperCase();
}

function validateAmount(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "amount must be a non-negative integer in minor units",
    });
  }
  return amount;
}

export class PricingManager {
  constructor(private readonly deps: PricingDeps) {}

  /** Create or update a game's price for a currency. */
  async setPrice(
    gameId: string,
    currency: string,
    amount: number,
    active = true,
  ): Promise<PriceRecord> {
    const code = normalizeCurrency(currency);
    const value = validateAmount(amount);
    const existing = await this.deps.prisma.gamePrice.findUnique({
      where: { gameId_currency: { gameId, currency: code } },
    });
    if (existing) {
      return this.deps.prisma.gamePrice.update({
        where: { id: existing.id },
        data: { amount: value, active },
      });
    }
    return this.deps.prisma.gamePrice.create({
      data: { gameId, currency: code, amount: value, active },
    });
  }

  async listPrices(gameId: string): Promise<PriceRecord[]> {
    return this.deps.prisma.gamePrice.findMany({
      where: { gameId },
      orderBy: { currency: "asc" },
    });
  }

  /** The active price for a currency, or `null` when none is set. */
  async resolvePrice(
    gameId: string,
    currency: string,
  ): Promise<PriceRecord | null> {
    const record = await this.deps.prisma.gamePrice.findUnique({
      where: {
        gameId_currency: { gameId, currency: normalizeCurrency(currency) },
      },
    });
    return record?.active ? record : null;
  }
}
