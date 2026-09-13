import pluginManager from "~/server/internal/plugins";

export default defineEventHandler(() => {
  return {
    plugins: pluginManager.listPlugins(),
  };
});
