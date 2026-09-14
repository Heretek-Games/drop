import { createError } from "h3";

export interface ReviewRecord {
  id: string;
  gameId: string;
  userId: string;
  rating: number;
  body: string;
  verified: boolean;
  createdAt: Date;
}

export interface ReviewDeps {
  prisma: {
    playtime: {
      findUnique(args: {
        where: { gameId_userId: { gameId: string; userId: string } };
      }): Promise<{ seconds: number } | null>;
    };
    gameReview: {
      findUnique(args: {
        where: { gameId_userId: { gameId: string; userId: string } };
      }): Promise<ReviewRecord | null>;
      create(args: {
        data: {
          gameId: string;
          userId: string;
          rating: number;
          body: string;
          verified: boolean;
        };
      }): Promise<ReviewRecord>;
      findMany(args: {
        where: { gameId: string };
        orderBy?: { createdAt: "asc" | "desc" };
      }): Promise<ReviewRecord[]>;
    };
  };
  /** Playtime needed for a review to count as "verified". */
  verifiedPlaytimeSeconds?: number;
}

export const DEFAULT_VERIFIED_PLAYTIME_SECONDS = 60 * 60;

export function isVerifiedReview(seconds: number, threshold: number): boolean {
  return seconds >= threshold;
}

export class ReviewManager {
  private readonly threshold: number;

  constructor(private readonly deps: ReviewDeps) {
    this.threshold =
      deps.verifiedPlaytimeSeconds ?? DEFAULT_VERIFIED_PLAYTIME_SECONDS;
  }

  async create(
    userId: string,
    gameId: string,
    rating: number,
    body: string,
  ): Promise<ReviewRecord> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw createError({
        statusCode: 400,
        statusMessage: "rating must be an integer from 1 to 5",
      });
    }

    const existing = await this.deps.prisma.gameReview.findUnique({
      where: { gameId_userId: { gameId, userId } },
    });
    if (existing) {
      throw createError({
        statusCode: 409,
        statusMessage: "You have already reviewed this game",
      });
    }

    const playtime = await this.deps.prisma.playtime.findUnique({
      where: { gameId_userId: { gameId, userId } },
    });
    const verified = isVerifiedReview(playtime?.seconds ?? 0, this.threshold);

    return this.deps.prisma.gameReview.create({
      data: { gameId, userId, rating, body, verified },
    });
  }

  async listForGame(gameId: string): Promise<ReviewRecord[]> {
    return this.deps.prisma.gameReview.findMany({
      where: { gameId },
      orderBy: { createdAt: "desc" },
    });
  }
}
