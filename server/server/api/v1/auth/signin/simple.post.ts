import { createError, type H3Event } from "h3";
import { AuthMec } from "~/prisma/client/enums";
import type { JsonArray } from "@prisma/client/runtime/client";
import { type } from "arktype";
import prisma from "~/server/internal/db/database";
import sessionHandler from "~/server/internal/session";
import authManager, {
  checkHashArgon2,
  checkHashBcrypt,
} from "~/server/internal/auth";
import { authenticateExternalUser } from "~/server/internal/auth/external";
import { logger } from "~/server/internal/logging";

type Translator = (key: string) => string;

const signinValidator = type({
  username: "string",
  password: "string",
  "rememberMe?": "boolean | undefined",
});

export default defineEventHandler<{
  body: typeof signinValidator.infer;
}>(async (h3) => {
  const t = (await useTranslation(h3)) as Translator;

  if (!authManager.getAuthProviders().Simple)
    throw createError({
      statusCode: 403,
      message: t("errors.auth.method.signinDisabled"),
    });

  const body = signinValidator(await readBody(h3));
  if (body instanceof type.errors) {
    // hover out.summary to see validation errors
    logger.error(body.summary);

    throw createError({
      statusCode: 400,
      message: body.summary,
    });
  }

  const authMek = await prisma.linkedAuthMec.findFirst({
    where: {
      mec: AuthMec.Simple,
      enabled: true,
      user: {
        username: body.username,
      },
    },
    include: {
      user: {
        select: {
          enabled: true,
        },
      },
    },
  });

  if (authMek && !authMek.user.enabled)
    throw createError({
      statusCode: 403,
      message: t("errors.auth.disabled"),
    });

  // Try the local password first when the account has a local mechanism.
  const localValid = authMek
    ? await checkLocalPassword(authMek, body.password, t)
    : false;

  if (authMek && localValid) {
    return await completeSignin(h3, authMek.userId, body.rememberMe);
  }

  // Fall back to providers an administrator has explicitly trusted. This covers
  // both "no local account" and "local password did not match" so a directory
  // account can supersede a stale local password.
  const external = await authenticateExternalUser(body.username, body.password);
  if (external.type === "success") {
    return await completeSignin(h3, external.userId, body.rememberMe);
  }

  // Distinguish an unreachable provider from invalid credentials.
  if (external.type === "unavailable")
    throw createError({
      statusCode: 503,
      message: t("errors.auth.providerUnavailable"),
    });

  throw createError({
    statusCode: 401,
    message: t("errors.auth.invalidUserOrPass"),
  });
});

interface LocalAuthMek {
  userId: string;
  version: number;
  credentials: unknown;
}

/** Verify a local password hash, preserving the legacy bcrypt path. */
async function checkLocalPassword(
  authMek: LocalAuthMek,
  password: string,
  t: Translator,
): Promise<boolean> {
  // LEGACY bcrypt
  if (authMek.version == 1) {
    const credentials = authMek.credentials as JsonArray | null;
    const hash = credentials?.at(1)?.toString();

    if (!hash)
      throw createError({
        statusCode: 500,
        message: t("errors.auth.invalidPassState"),
      });

    return await checkHashBcrypt(password, hash);
  }

  // V2: argon2
  const hash = authMek.credentials as string | undefined;
  if (!hash || typeof hash !== "string")
    throw createError({
      statusCode: 500,
      message: t("errors.auth.invalidPassState"),
    });

  return await checkHashArgon2(password, hash);
}

async function completeSignin(
  h3: H3Event,
  userId: string,
  rememberMe: boolean | undefined,
) {
  const result = await sessionHandler.signin(h3, userId, {
    rememberMe: rememberMe ?? false,
  });
  if (result === "fail")
    throw createError({
      statusCode: 500,
      message: "Failed to create session",
    });

  return { result, userId };
}
