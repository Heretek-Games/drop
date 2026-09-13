<template>
  <div>
    <div class="sm:flex sm:items-center">
      <div class="sm:flex-auto">
        <h1
          class="inline-flex items-center gap-x-2 text-base font-semibold text-white"
        >
          <SquaresPlusIcon class="size-6" /> Bulk Auto-Import
        </h1>
        <p class="mt-2 text-sm text-zinc-300">
          Scan your libraries for unimported games and import them in a single
          pass. Drop classifies each release and generates its install recipe
          automatically.
        </p>
      </div>
      <div class="mt-4 flex gap-x-3 sm:mt-0 sm:ml-16 sm:flex-none">
        <LoadingButton :loading="scanning" @click="startScan">
          {{ scanning ? "Scanning..." : "Scan Libraries" }}
        </LoadingButton>
        <LoadingButton
          :loading="importing"
          :disabled="!hasSelected"
          @click="importSelected"
        >
          Import Selected
        </LoadingButton>
      </div>
    </div>

    <div
      v-if="loadError"
      class="mt-4 rounded-md bg-red-600/10 p-3 text-sm text-red-400"
    >
      {{ loadError }}
    </div>

    <div class="mt-8 flow-root">
      <div class="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
        <div class="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
          <div class="group/table relative">
            <table
              class="relative min-w-full table-fixed divide-y divide-white/15"
            >
              <thead>
                <tr>
                  <th scope="col" class="relative px-7 sm:w-12 sm:px-6">
                    <div
                      class="group absolute top-1/2 left-4 -mt-2 grid size-4 grid-cols-1"
                    >
                      <input
                        v-model="globalState"
                        :indeterminate="globalState === 'indeterminate'"
                        type="checkbox"
                        aria-label="Select all discovered games"
                        class="col-start-1 row-start-1 appearance-none rounded-sm border border-white/20 bg-zinc-800/50 checked:border-blue-500 checked:bg-blue-500 indeterminate:border-blue-500 indeterminate:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                      />
                    </div>
                  </th>
                  <th
                    scope="col"
                    class="w-full py-3.5 pr-3 text-left text-sm font-semibold text-white whitespace-nowrap"
                  >
                    Name
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-white whitespace-nowrap"
                  >
                    Library
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-white whitespace-nowrap"
                  >
                    Path
                  </th>
                  <th
                    scope="col"
                    class="px-3 py-3.5 text-left text-sm font-semibold text-white whitespace-nowrap"
                  >
                    Detected Type
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/10 bg-zinc-900">
                <tr
                  v-for="game in rows"
                  :key="game.id"
                  class="group has-checked:bg-zinc-800/50"
                >
                  <td class="relative px-7 sm:w-12 sm:px-6">
                    <div
                      class="absolute top-1/2 left-4 -mt-2 grid size-4 grid-cols-1"
                    >
                      <input
                        v-model="selected"
                        :value="game.id"
                        type="checkbox"
                        aria-label="Select game"
                        class="col-start-1 row-start-1 appearance-none rounded-sm border border-white/20 bg-zinc-800/50 checked:border-blue-500 checked:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                      />
                    </div>
                  </td>
                  <td
                    class="py-4 pr-3 text-sm font-medium whitespace-nowrap text-white group-has-checked:text-blue-400"
                  >
                    {{ game.suggestedName || game.libraryPath }}
                  </td>
                  <td class="px-3 py-4 text-sm whitespace-nowrap text-zinc-400">
                    {{ game.libraryName }}
                  </td>
                  <td
                    class="max-w-md truncate px-3 py-4 text-sm whitespace-nowrap text-zinc-400"
                    :title="game.libraryPath"
                  >
                    {{ game.libraryPath }}
                  </td>
                  <td class="px-3 py-4 text-sm whitespace-nowrap">
                    <span
                      class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="typeClass(game.inferredType)"
                    >
                      {{ game.inferredType }}
                    </span>
                  </td>
                </tr>
                <tr v-if="rows.length === 0">
                  <td
                    colspan="5"
                    class="py-12 text-center text-sm text-zinc-400"
                  >
                    No unimported games discovered yet. Click "Scan Libraries"
                    to look for games.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="rows.length > 0"
      class="mt-4 flex items-center justify-between text-xs text-zinc-400"
    >
      <span>{{ rows.length }} unimported game(s) awaiting review</span>
      <button
        type="button"
        class="text-zinc-400 hover:text-zinc-200"
        :disabled="!hasSelected"
        @click="ignoreSelected"
      >
        Ignore selected
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SquaresPlusIcon } from "@heroicons/vue/24/outline";

definePageMeta({
  layout: "admin",
});

interface DiscoveredGameRow {
  id: string;
  libraryId: string;
  libraryName: string;
  libraryPath: string;
  inferredType: string;
  suggestedName: string | null;
}

const rows = ref<DiscoveredGameRow[]>([]);
const selected = ref<string[]>([]);
const scanning = ref(false);
const importing = ref(false);
const loadError = ref<string | undefined>();

const router = useRouter();

async function load() {
  try {
    rows.value = await $dropFetch<DiscoveredGameRow[]>(
      "/api/v1/admin/import/discover",
    );
    selected.value = [];
    loadError.value = undefined;
  } catch (e) {
    loadError.value = String(e);
  }
}

async function startScan() {
  scanning.value = true;
  loadError.value = undefined;
  try {
    const { taskId } = await $dropFetch<{ taskId: string }>(
      "/api/v1/admin/import/discover",
      { method: "POST" },
    );
    await waitForTask(taskId);
    await load();
  } catch (e) {
    loadError.value = String(e);
  } finally {
    scanning.value = false;
  }
}

async function waitForTask(taskId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { runningTasks } = await $dropFetch<{ runningTasks: string[] }>(
      "/api/v1/admin/task",
    );
    if (!runningTasks.includes(taskId)) return;
  }
}

async function importSelected() {
  if (!hasSelected.value) return;
  importing.value = true;
  try {
    const { taskId } = await $dropFetch<{ taskId: string }>(
      "/api/v1/admin/import/bulk",
      { method: "POST", body: { ids: selected.value } },
    );
    router.push(`/admin/task/${taskId}`);
  } catch (e) {
    loadError.value = String(e);
  } finally {
    importing.value = false;
  }
}

async function ignoreSelected() {
  if (!hasSelected.value) return;
  await $dropFetch("/api/v1/admin/import/discover", {
    method: "PATCH",
    body: { ids: selected.value, decision: "Ignored" },
  });
  await load();
}

const hasSelected = computed(() => selected.value.length > 0);

const globalState = computed({
  get() {
    if (rows.value.length === 0) return false;
    if (selected.value.length === 0) return false;
    if (selected.value.length === rows.value.length) return true;
    return "indeterminate" as const;
  },
  set(v) {
    if (typeof v !== "boolean") return;
    selected.value = v ? rows.value.map((row) => row.id) : [];
  },
});

function typeClass(inferredType: string) {
  switch (inferredType) {
    case "SceneRelease":
      return "bg-purple-500/20 text-purple-300";
    case "GogInstaller":
      return "bg-blue-500/20 text-blue-300";
    case "FitGirlRepack":
    case "KaOsRepack":
    case "DodiRepack":
      return "bg-amber-500/20 text-amber-300";
    case "ArchiveBundle":
      return "bg-cyan-500/20 text-cyan-300";
    case "LoosePortable":
      return "bg-green-500/20 text-green-300";
    default:
      return "bg-zinc-700/40 text-zinc-400";
  }
}

await load();
</script>
