import { createError } from "h3";

/**
 * Dropworks game SDK service (#19).
 *
 * Native games authenticate with a Drop API token (User or Client mode) and an
 * `appId` that resolves to a Drop game. The reference TypeScript and Rust
 * clients in `Heretek-Games/dropworks-sdk` speak this contract:
 *
 *   POST /api/v1/dropworks/session      -> { userId }
 *   POST /api/v1/dropworks/achievement  -> unlock an achievement
 *
 * The authenticated user is always derived from the token; a client-supplied
 * `userId` is only accepted when it matches, so one game session cannot unlock
 * achievements on another user's behalf.
 */

export interface DropworksSession {
  userId: string;
  gameId: string;
  appId: string;
}

export interface UnlockResult {
  unlocked: boolean;
  alreadyUnlocked: boolean;
}

/** Dependency surface kept structural so the service is unit-testable. */
export interface DropworksDeps {
  /** Resolve a User/Client API token to its owning user id. */
  resolveUserByToken(token: string): Promise<string | undefined>;
  /** Resolve a client `appId` (Drop game id or external metadata id). */
  findGameId(appId: string): Promise<string | undefined>;
  /** Unlock an achievement by its stable key. */
  unlockAchievement(
    userId: string,
    gameId: string,
    key: string,
  ): Promise<{ alreadyUnlocked: boolean }>;
}

export class DropworksManager {
  constructor(private readonly deps: DropworksDeps) {}

  /** Exchange an app id + API token for a game session. */
  async openSession(appId: string, token: string): Promise<DropworksSession> {
    if (!appId || !token) {
      throw createError({
        statusCode: 400,
        statusMessage: "appId and authToken are required",
      });
    }
    const userId = await this.deps.resolveUserByToken(token);
    if (!userId) {
      throw createError({
        statusCode: 401,
        statusMessage: "Invalid Dropworks auth token",
      });
    }
    const gameId = await this.deps.findGameId(appId);
    if (!gameId) {
      throw createError({
        statusCode: 404,
        statusMessage: "Unknown appId",
      });
    }
    return { userId, gameId, appId };
  }

  /**
   * Unlock an achievement for the authenticated user. `claimUserId`, when
   * provided, must match the authenticated user.
   */
  async unlockAchievement(
    token: string,
    appId: string,
    achievementId: string,
    claimUserId?: string,
  ): Promise<UnlockResult> {
    if (!appId || !achievementId) {
      throw createError({
        statusCode: 400,
        statusMessage: "appId and achievementId are required",
      });
    }
    const userId = await this.deps.resolveUserByToken(token);
    if (!userId) {
      throw createError({
        statusCode: 401,
        statusMessage: "Invalid Dropworks auth token",
      });
    }
    if (claimUserId && claimUserId !== userId) {
      throw createError({
        statusCode: 403,
        statusMessage: "userId does not match the authenticated session",
      });
    }
    const gameId = await this.deps.findGameId(appId);
    if (!gameId) {
      throw createError({ statusCode: 404, statusMessage: "Unknown appId" });
    }

    const { alreadyUnlocked } = await this.deps.unlockAchievement(
      userId,
      gameId,
      achievementId,
    );
    return { unlocked: true, alreadyUnlocked };
  }
}
