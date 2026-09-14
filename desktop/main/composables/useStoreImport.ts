import { ref } from "vue";
import { clientPluginManager } from "~/internal/plugins/ClientPluginManager";
import {
  collectStoreGames,
  type StoreImportResult,
} from "~/internal/plugins/storeImport";

/**
 * Runs every plugin-provided `StoreScanner` (Steam, GOG, Epic, itch.io) and
 * exposes the aggregated result for the library import flow.
 */
export function useStoreImport() {
  const scanning = ref(false);
  const result = ref<StoreImportResult>({ games: [], failures: [] });

  async function scanAll(): Promise<StoreImportResult> {
    scanning.value = true;
    try {
      result.value = await collectStoreGames(
        clientPluginManager.getStoreScanners(),
      );
    } finally {
      scanning.value = false;
    }
    return result.value;
  }

  return { scanning, result, scanAll };
}
