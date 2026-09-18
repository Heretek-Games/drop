import { AuthMec } from "~/prisma/client/enums";
import aclManager from "~/server/internal/acls";
import authManager from "~/server/internal/auth";
import { applicationSettings } from "~/server/internal/config/application-configuration";
import pluginManager from "~/server/internal/plugins";

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, ["auth:read", "setup"]);
  if (!allowed) throw createError({ statusCode: 403 });

  const enabledAuthManagers = authManager.getAuthProviders();

  const authData = {
    [AuthMec.Simple]: enabledAuthManagers.Simple,
    [AuthMec.OpenID]: enabledAuthManagers.OpenID?.generateConfiguration(),
  };

  // Plugin AuthProviders are opt-in; expose which registered providers the
  // administrator has trusted so the admin UI can toggle them.
  const trusted = (await applicationSettings.get("authProviders")) ?? [];
  const pluginProviders = pluginManager.getAuthProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: trusted.includes(provider.id),
  }));

  return { ...authData, pluginProviders };
});
