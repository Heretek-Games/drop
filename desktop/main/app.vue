<template>
  <NuxtLoadingIndicator color="#2563eb" />
  <NuxtLayout class="select-none w-full h-full min-h-screen overflow-hidden">
    <NuxtPage />
    <ModalStack />
    <AchievementToast
      :toasts="achievementToasts"
      @dismiss="dismissAchievementToast"
    />
  </NuxtLayout>
</template>

<script setup lang="ts">
import "~/composables/downloads.js";

import { invoke } from "@tauri-apps/api/core";
import { useAppState } from "./composables/app-state.js";
import {
  initialNavigation,
  setupHooks,
} from "./composables/state-navigation.js";
import { useAchievementToasts } from "./composables/useAchievementToasts.js";
import { listen } from "@tauri-apps/api/event";
import type { AppState } from "./types.js";

const { toasts: achievementToasts, dismiss: dismissAchievementToast } =
  useAchievementToasts();

const state = useAppState();

async function fetchState() {
  try {
    state.value = JSON.parse(await invoke("fetch_state"));
    if (!state.value)
      throw createError({
        statusCode: 500,
        statusMessage: `App state is: ${state.value}`,
        fatal: true,
      });
  } catch (e) {
    console.error("failed to parse state", e);
    throw e;
  }
}
await fetchState();

listen("update_state", (event) => {
  state.value = event.payload as AppState;
});

listen("window_visibility_change", () => {
  document.dispatchEvent(new Event("visibilitychange"));
});

setupHooks();
initialNavigation(state);

useHead({
  title: "Drop",
});
</script>
