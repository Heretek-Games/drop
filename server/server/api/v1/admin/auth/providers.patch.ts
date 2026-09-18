import { readBody, createError } from "h3";
import aclManager from "~/server/internal/acls";
import { applicationSettings } from "~/server/internal/config/application-configuration";
import pluginManager from "~/server/internal/plugins";

/**
 * Set the administrator's trusted plugin AuthProvider allow-list. External
 * authentication is fail-closed: a provider not listed here is never consulted
 * by the login flow.
 */
export default defineEventHandler(async (event) => {
  const allowed = await aclManager.allowSystemACL(event, []);
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: "Admin privileges required to manage authentication",
    });
  }

  const body = await readBody<{ providers?: unknown }>(event);
  if (
    !Array.isArray(body?.providers) ||
    !body.providers.every((id) => typeof id === "string")
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: "Field 'providers' (string[]) is required in request body",
    });
  }

  const registered = new Set(
    pluginManager.getAuthProviders().map((provider) => provider.id),
  );
  const providers = [...new Set(body.providers)];
  const unknown = providers.filter((id) => !registered.has(id));
  if (unknown.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `Unknown auth provider(s): ${unknown.join(", ")}`,
    });
  }

  await applicationSettings.set("authProviders", providers);
  return { providers };
});
