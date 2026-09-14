import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  planModLoad,
  type ModLoadPlan,
  type ModManifest,
} from "~/internal/workshop/planner";

interface SubscriptionView {
  modId: string;
  pinnedVersion?: string | null;
  mod?: { id: string; gameId: string; key: string; name: string } | null;
}

interface ModDetail {
  releases: Array<{ parsed: ModManifest }>;
  latest: { parsed: ModManifest } | null;
}

/**
 * Loads the user's Workshop subscriptions, reads each mod manifest, and
 * computes a load plan (order, missing dependencies, file conflicts).
 */
export function useWorkshopMods() {
  const loading = ref(false);
  const error = ref<string>();
  const plan = ref<ModLoadPlan>({ order: [], missing: [], conflicts: [] });
  const mods = ref<ModManifest[]>([]);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = undefined;
    try {
      const { subscriptions } = await invoke<{
        subscriptions: SubscriptionView[];
      }>("fetch_workshop_subscriptions");

      const manifests: ModManifest[] = [];
      for (const subscription of subscriptions) {
        if (!subscription.mod) continue;
        const detail = await invoke<ModDetail>("fetch_workshop_mod", {
          gameId: subscription.mod.gameId,
          key: subscription.mod.key,
        });
        const manifest =
          detail.latest?.parsed ?? detail.releases[0]?.parsed ?? null;
        if (manifest) manifests.push(manifest);
      }

      mods.value = manifests;
      plan.value = planModLoad(manifests);
    } catch (e) {
      console.warn("Failed to load workshop mods:", e);
      error.value = "Could not load workshop subscriptions.";
      plan.value = { order: [], missing: [], conflicts: [] };
      mods.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { loading, error, plan, mods, load };
}
