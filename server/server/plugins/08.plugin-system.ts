import { initPlugins, pluginManager } from "../internal/plugins";

export default defineNitroPlugin(async (nitro) => {
  await initPlugins();

  nitro.hooks.hookOnce("close", async () => {
    const plugins = pluginManager.listPlugins();
    for (const plugin of plugins) {
      await pluginManager.unregisterPlugin(plugin.id);
    }
  });
});
