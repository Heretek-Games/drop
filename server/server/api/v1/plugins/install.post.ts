import { type } from "arktype";
import { readDropValidatedBody, throwingArktype } from "~/server/arktype";
import aclManager from "~/server/internal/acls";
import pluginManager from "~/server/internal/plugins";
import type { PluginManifest } from "~/server/internal/plugins";

const InstallBundle = type({
  manifest: {
    id: "string>0",
    name: "string>0",
    version: "string>0",
    apiVersion: "number",
    "entry?": "string",
    "capabilities?": "string[]",
    "checksum?": "string",
    "signature?": "string",
  },
  entry: "string>0",
}).configure(throwingArktype);

export default defineEventHandler(async (h3) => {
  const allowed = await aclManager.allowSystemACL(h3, []);
  if (!allowed) {
    throw createError({
      statusCode: 403,
      statusMessage: "Admin privileges required to install plugins",
    });
  }

  const body = await readDropValidatedBody(h3, InstallBundle);
  try {
    await pluginManager.installBundle(
      body.manifest as PluginManifest,
      body.entry,
    );
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: String(err) });
  }

  return { success: true, plugins: pluginManager.listPlugins() };
});
