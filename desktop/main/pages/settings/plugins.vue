<template>
  <div class="border-b border-zinc-700 py-5 flex items-center justify-between">
    <div>
      <h3 class="text-base font-semibold font-display leading-6 text-zinc-100">
        Plugins &amp; Extensions
      </h3>
      <p class="mt-1 text-xs text-zinc-400">
        Manage installed server and client plugins, virtual mesh networks, and
        addon capabilities.
      </p>
    </div>
    <button
      type="button"
      @click="reloadPlugins"
      :disabled="isLoading"
      class="inline-flex items-center gap-x-1.5 rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition disabled:opacity-50"
    >
      <ArrowPathIcon class="size-4" :class="{ 'animate-spin': isLoading }" />
      <span>Reload Plugins</span>
    </button>
  </div>

  <div
    v-if="error"
    class="mt-4 rounded-md bg-red-600/10 p-4 border border-red-500/20"
  >
    <div class="flex items-center gap-x-2 text-red-400 text-sm">
      <XCircleIcon class="size-5 shrink-0" />
      <span>{{ error }}</span>
    </div>
  </div>

  <div
    class="mt-6 rounded-xl border border-zinc-800 bg-zinc-850/60 p-5 space-y-3"
  >
    <h4 class="text-sm font-semibold text-zinc-100">Install external bundle</h4>
    <p class="text-xs text-zinc-400">
      Paste a bundle as JSON:
      <code class="font-mono"
        >{ "manifest": {...}, "entry": "&lt;base64&gt;" }</code
      >.
    </p>
    <label for="install-plugin-bundle" class="sr-only"
      >External plugin bundle JSON</label
    >
    <textarea
      id="install-plugin-bundle"
      v-model="installJson"
      rows="4"
      class="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-purple-500"
      placeholder='{"manifest":{"id":"my-plugin","name":"My Plugin","version":"1.0.0","apiVersion":1,"capabilities":["routes"]},"entry":"<base64>"}'
    ></textarea>
    <button
      type="button"
      @click="handleInstallBundle"
      :disabled="isLoading || !installReady"
      class="inline-flex items-center rounded-md bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-500 transition disabled:opacity-50"
    >
      Install
    </button>
  </div>

  <div class="mt-6 space-y-4">
    <div
      v-if="plugins.length === 0 && !isLoading"
      class="rounded-lg border border-dashed border-zinc-700 p-8 text-center"
    >
      <PuzzlePieceIcon class="mx-auto size-12 text-zinc-600 mb-2" />
      <p class="text-sm font-medium text-zinc-300">No plugins detected</p>
      <p class="text-xs text-zinc-500 mt-1">
        Installed plugins will appear here automatically.
      </p>
    </div>

    <div
      v-for="plugin in plugins"
      :key="plugin.id"
      class="rounded-xl border border-zinc-800 bg-zinc-850/60 p-5 space-y-4"
    >
      <div class="flex items-start justify-between">
        <div class="space-y-1">
          <div class="flex items-center gap-x-2">
            <h4 class="text-base font-semibold text-zinc-100">
              {{ plugin.name }}
            </h4>
            <span
              v-if="plugin.builtin"
              class="rounded bg-purple-500/10 border border-purple-500/30 px-2 py-0.5 text-[10px] font-medium text-purple-300 uppercase tracking-wide"
            >
              Built-in
            </span>
            <span
              v-else
              class="rounded bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[10px] font-medium text-blue-300 uppercase tracking-wide"
            >
              External
            </span>
            <span
              :class="[
                plugin.status === 'active'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : plugin.status === 'disabled'
                    ? 'bg-zinc-700/20 text-zinc-400 border-zinc-700/30'
                    : 'bg-red-500/10 text-red-400 border-red-500/30',
                'rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              ]"
            >
              {{ plugin.status }}
            </span>
          </div>
          <p class="text-xs font-mono text-zinc-400">
            {{ plugin.id }} &bull; v{{ plugin.version }}
            <span v-if="plugin.author"> &bull; by {{ plugin.author }}</span>
          </p>
        </div>

        <div class="flex items-center gap-x-3">
          <button
            v-if="!plugin.builtin"
            type="button"
            @click="handleRemovePlugin(plugin.id)"
            :disabled="isLoading"
            class="text-xs font-medium text-red-400 hover:text-red-300 transition disabled:opacity-50"
          >
            Remove
          </button>
          <Switch
            :model-value="plugin.status === 'active'"
            @update:model-value="(val) => handleTogglePlugin(plugin.id, val)"
            :disabled="isLoading"
            :class="[
              plugin.status === 'active' ? 'bg-purple-600' : 'bg-zinc-700',
              'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
            ]"
          >
            <span
              :class="[
                plugin.status === 'active' ? 'translate-x-5' : 'translate-x-0',
                'pointer-events-none relative inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
              ]"
            />
          </Switch>
        </div>
      </div>

      <p v-if="plugin.description" class="text-sm text-zinc-300">
        {{ plugin.description }}
      </p>

      <div
        v-if="plugin.capabilities && plugin.capabilities.length > 0"
        class="pt-2 border-t border-zinc-800 flex items-center gap-x-2"
      >
        <span class="text-xs text-zinc-500 flex items-center gap-x-1">
          <ShieldCheckIcon class="size-3.5 text-zinc-400" />
          Capabilities:
        </span>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="cap in plugin.capabilities"
            :key="cap"
            class="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-zinc-300"
          >
            {{ cap }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Switch } from "@headlessui/vue";
import {
  ArrowPathIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "@heroicons/vue/20/solid";
import { invoke } from "@tauri-apps/api/core";

export interface PluginItem {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  builtin?: boolean;
  capabilities?: string[];
  status: "active" | "disabled" | "error";
  error?: string;
}

const plugins = ref<PluginItem[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

async function fetchPlugins() {
  isLoading.value = true;
  error.value = null;
  try {
    const res = await invoke<{ plugins: PluginItem[] }>("plugin_request", {
      pluginId: "",
      method: "GET",
      path: "",
    });
    plugins.value = res.plugins ?? [];
  } catch (e) {
    error.value = (e as string).toString();
  } finally {
    isLoading.value = false;
  }
}

async function handleTogglePlugin(id: string, enabled: boolean) {
  isLoading.value = true;
  error.value = null;
  try {
    await invoke("plugin_request", {
      pluginId: `${id}/state`,
      method: "PATCH",
      path: "",
      body: { enabled },
    });
    await fetchPlugins();
  } catch (e) {
    error.value = (e as string).toString();
  } finally {
    isLoading.value = false;
  }
}

async function reloadPlugins() {
  isLoading.value = true;
  error.value = null;
  try {
    await invoke("plugin_request", {
      pluginId: "reload",
      method: "POST",
      path: "",
    });
    await fetchPlugins();
  } catch (e) {
    error.value = (e as string).toString();
  } finally {
    isLoading.value = false;
  }
}

async function handleRemovePlugin(id: string) {
  isLoading.value = true;
  error.value = null;
  try {
    await invoke("plugin_request", {
      pluginId: `${id}/bundle`,
      method: "DELETE",
      path: "",
    });
    await fetchPlugins();
  } catch (e) {
    error.value = (e as string).toString();
  } finally {
    isLoading.value = false;
  }
}

const installJson = ref("");
const installReady = computed(() => installJson.value.trim().length > 0);

async function handleInstallBundle() {
  isLoading.value = true;
  error.value = null;
  try {
    const parsed = JSON.parse(installJson.value) as {
      manifest?: unknown;
      entry?: string;
    };
    if (!parsed?.manifest || typeof parsed.entry !== "string") {
      throw new Error(
        'Bundle must be { "manifest": {...}, "entry": "<base64>" }',
      );
    }
    await invoke("plugin_request", {
      pluginId: "install",
      method: "POST",
      path: "",
      body: parsed,
    });
    installJson.value = "";
    await fetchPlugins();
  } catch (e) {
    error.value = (e as string).toString();
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  fetchPlugins();
});
</script>
