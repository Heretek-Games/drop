import { pluginManager } from "./manager";
import { dropGseServerPlugin } from "./builtin/drop-gse";

export * from "./types";
export * from "./storage";
export * from "./manager";
export { dropGseServerPlugin } from "./builtin/drop-gse";

export async function initPlugins(): Promise<void> {
  // Register default built-in plugins
  await pluginManager.registerPlugin(dropGseServerPlugin);
  // Discover and load external plugins from data directory
  await pluginManager.discoverAndLoadExternalPlugins();
}

export default pluginManager;
