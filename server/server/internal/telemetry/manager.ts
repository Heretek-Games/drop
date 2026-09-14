import { createError } from "h3";

/**
 * Developer-portal crash telemetry (#21).
 *
 * Crash reports are bounded and stripped of NUL bytes before storage so a
 * misbehaving client cannot store unbounded blobs. `userId` is optional:
 * reports can arrive anonymously or after sign-in.
 */

export interface CrashReportRecord {
  id: string;
  gameId: string;
  userId?: string | null;
  versionName?: string | null;
  platform?: string | null;
  message: string;
  stack?: string | null;
  createdAt: Date;
}

export interface CrashReportInput {
  gameId: string;
  userId?: string;
  versionName?: string;
  platform?: string;
  message: string;
  stack?: string;
}

export const MAX_CRASH_MESSAGE_LENGTH = 4_000;
export const MAX_CRASH_STACK_LENGTH = 16_000;
export const MAX_CRASH_PLATFORM_LENGTH = 64;
export const MAX_CRASH_VERSION_LENGTH = 200;

export interface TelemetryDeps {
  prisma: {
    crashReport: {
      create(args: {
        data: {
          gameId: string;
          userId?: string;
          versionName?: string;
          platform?: string;
          message: string;
          stack?: string;
        };
      }): Promise<CrashReportRecord>;
      findMany(args: {
        where: { gameId: string };
        orderBy: { createdAt: "desc" };
        take?: number;
      }): Promise<CrashReportRecord[]>;
      count(args: { where: { gameId: string } }): Promise<number>;
    };
  };
}

function sanitize(value: string, maxLength: number, field: string): string {
  const cleaned = value.replaceAll("\u0000", "").trim();
  if (cleaned.length > maxLength) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be at most ${maxLength} characters`,
    });
  }
  return cleaned;
}

function required(
  value: string | undefined,
  maxLength: number,
  field: string,
): string {
  const cleaned = sanitize(value ?? "", maxLength, field);
  if (cleaned.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `${field} is required`,
    });
  }
  return cleaned;
}

function optional(
  value: string | undefined,
  maxLength: number,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const cleaned = sanitize(value, maxLength, field);
  return cleaned.length > 0 ? cleaned : undefined;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 500);
}

export class TelemetryManager {
  constructor(private readonly deps: TelemetryDeps) {}

  async report(input: CrashReportInput): Promise<CrashReportRecord> {
    const versionName = optional(
      input.versionName,
      MAX_CRASH_VERSION_LENGTH,
      "versionName",
    );
    const platform = optional(
      input.platform,
      MAX_CRASH_PLATFORM_LENGTH,
      "platform",
    );
    const stack = optional(input.stack, MAX_CRASH_STACK_LENGTH, "stack");

    return this.deps.prisma.crashReport.create({
      data: {
        gameId: required(input.gameId, 64, "gameId"),
        message: required(input.message, MAX_CRASH_MESSAGE_LENGTH, "message"),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(versionName ? { versionName } : {}),
        ...(platform ? { platform } : {}),
        ...(stack ? { stack } : {}),
      },
    });
  }

  async listForGame(gameId: string, limit = 100): Promise<CrashReportRecord[]> {
    return this.deps.prisma.crashReport.findMany({
      where: { gameId },
      orderBy: { createdAt: "desc" },
      take: clampLimit(limit),
    });
  }

  async countForGame(gameId: string): Promise<number> {
    return this.deps.prisma.crashReport.count({ where: { gameId } });
  }
}
