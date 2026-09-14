<template>
  <div class="mx-auto max-w-3xl px-8 py-12 text-zinc-100">
    <h1 class="text-3xl font-semibold">Workshop Mods</h1>
    <p class="mt-2 text-sm text-zinc-400">
      Plans your subscribed mods: load order, missing dependencies, and file
      conflicts.
    </p>

    <button
      type="button"
      :disabled="loading"
      class="mt-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
      @click="load"
    >
      {{ loading ? "Loading..." : "Plan mod load order" }}
    </button>

    <p v-if="error" class="mt-4 text-sm text-red-400">{{ error }}</p>

    <ol class="mt-6 list-decimal space-y-1 pl-6 text-sm">
      <li v-for="id in plan.order" :key="id">{{ names[id] ?? id }}</li>
    </ol>
    <p
      v-if="!loading && plan.order.length === 0 && !error"
      class="mt-4 text-sm text-zinc-500"
    >
      No subscribed mods.
    </p>

    <p v-if="plan.missing.length > 0" class="mt-4 text-sm text-amber-400">
      Missing dependencies: {{ plan.missing.join(", ") }}
    </p>

    <ul
      v-if="plan.conflicts.length > 0"
      class="mt-4 space-y-1 text-sm text-red-400"
    >
      <li v-for="conflict in plan.conflicts" :key="conflict.path">
        Conflict on {{ conflict.path }}: {{ conflict.mods.join(", ") }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useWorkshopMods } from "~/composables/useWorkshopMods";

const { loading, error, plan, mods, load } = useWorkshopMods();
const names = computed<Record<string, string>>(() =>
  Object.fromEntries(mods.value.map((mod) => [mod.id, mod.name])),
);
</script>
