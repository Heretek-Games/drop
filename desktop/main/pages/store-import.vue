<template>
  <div class="mx-auto max-w-3xl px-8 py-12 text-zinc-100">
    <h1 class="text-3xl font-semibold">Import From Stores</h1>
    <p class="mt-2 text-sm text-zinc-400">
      Scans the installed-store plugins (Steam, GOG, Epic, itch.io) for local
      games.
    </p>

    <button
      type="button"
      :disabled="scanning"
      class="mt-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
      @click="scanAll"
    >
      {{ scanning ? "Scanning..." : "Scan libraries" }}
    </button>

    <ul class="mt-6 space-y-2">
      <li
        v-for="game in result.games"
        :key="`${game.store}:${game.externalId}`"
        class="rounded-lg bg-zinc-900/60 p-3 text-sm ring-1 ring-white/5"
      >
        <span class="font-medium">{{ game.title }}</span>
        <span class="ml-2 text-xs text-zinc-400">{{ game.store }}</span>
      </li>
      <li
        v-if="result.games.length === 0 && !scanning"
        class="text-sm text-zinc-500"
      >
        No games discovered.
      </li>
    </ul>

    <p
      v-for="failure in result.failures"
      :key="failure.store"
      class="mt-2 text-xs text-amber-400"
    >
      {{ failure.store }}: {{ failure.error }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { useStoreImport } from "~/composables/useStoreImport";

const { scanning, result, scanAll } = useStoreImport();
</script>
