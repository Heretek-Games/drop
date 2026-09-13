import { defineDropTask } from "..";
import libraryManager from "../../library";

export default defineDropTask({
  buildId: () => `import:discover:${new Date().toISOString()}`,
  name: "Discover unimported games",
  acls: ["system:import:game:read"],
  taskGroup: "import:discover",
  async run({ progress, logger }) {
    logger.info("Scanning libraries for unimported game directories...");
    progress(0);

    const count = await libraryManager.discoverUnimportedGames();

    logger.info(`Discovered ${count} unimported game directories`);
    progress(100);
  },
});
