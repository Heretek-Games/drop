import { createError } from "h3";
import prisma from "../db/database";
import { applicationSettings } from "../config/application-configuration";
import pluginManager from "../plugins";
import type { AuthUser } from "../plugins/types";

/**
 * Outcome of an external (plugin `AuthProvider`) authentication attempt.
 *
 * - `disabled` — no provider is opted in or registered.
 * - `invalid` — the credentials were rejected by every reachable provider.
 * - `unavailable` — at least one provider could not be reached, so the caller
 *   must not report "invalid credentials" (fail closed).
 * - `success` — a local user id was resolved/created for the identity.
 */
export type ExternalAuthOutcome =
  | { type: "disabled" }
  | { type: "invalid" }
  | { type: "unavailable"; providerId?: string }
  | { type: "success"; userId: string };

/**
 * Authenticate against the plugin `AuthProvider`s the administrator has
 * explicitly trusted. Providers run in registration order; the first success
 * wins. When no provider is enabled this is a no-op (`disabled`) so the local
 * login path is unaffected.
 */
export async function authenticateExternalUser(
  username: string,
  password: string,
): Promise<ExternalAuthOutcome> {
  const allowed = (await applicationSettings.get("authProviders")) ?? [];
  if (allowed.length === 0) return { type: "disabled" };

  const providers = pluginManager
    .getAuthProviders()
    .filter((provider) => allowed.includes(provider.id));
  if (providers.length === 0) return { type: "disabled" };

  let unavailable: { providerId: string } | undefined;
  for (const provider of providers) {
    let result;
    try {
      result = await provider.authenticate({ username, password });
    } catch {
      unavailable = { providerId: provider.id };
      continue;
    }
    if (result.unavailable) {
      unavailable = { providerId: provider.id };
      continue;
    }
    if (!result.authenticated || !result.user) continue;

    const userId = await attachExternalUser(provider.id, result.user);
    return { type: "success", userId };
  }

  return unavailable
    ? { type: "unavailable", providerId: unavailable.providerId }
    : { type: "invalid" };
}

/** Resolve the local user for an external identity, creating one on first login. */
async function attachExternalUser(
  providerId: string,
  authUser: AuthUser,
): Promise<string> {
  const existing = await prisma.externalIdentity.findUnique({
    where: {
      providerId_externalId: {
        providerId,
        externalId: authUser.externalId,
      },
    },
    include: { user: { select: { id: true, enabled: true } } },
  });

  if (existing) {
    if (!existing.user.enabled) {
      throw createError({
        statusCode: 403,
        message: "errors.auth.disabled",
      });
    }
    return existing.userId;
  }

  const username = await uniqueUsername(
    authUser.username || authUser.externalId,
  );
  const user = await prisma.user.create({
    data: {
      username,
      email: authUser.email ?? "",
      displayName: authUser.displayName ?? username,
      profilePictureObjectId: "",
      externalIdentities: {
        create: { providerId, externalId: authUser.externalId },
      },
    },
    select: { id: true },
  });
  return user.id;
}

/** Derive a unique local username from an external identity's username. */
async function uniqueUsername(base: string): Promise<string> {
  const sanitized = base.trim().replace(/[^a-zA-Z0-9._-]/g, "-") || "user";
  let candidate = sanitized;
  let suffix = 1;
  while (
    await prisma.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    })
  ) {
    suffix += 1;
    candidate = `${sanitized}-${suffix}`;
  }
  return candidate;
}
