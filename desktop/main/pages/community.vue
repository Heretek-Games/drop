<template>
  <div class="mx-auto max-w-3xl px-8 py-12 text-zinc-100">
    <h1 class="text-3xl font-semibold">Community Reviews</h1>
    <p class="mt-2 text-sm text-zinc-400">
      Reviews marked Verified come from players who passed the playtime
      threshold.
    </p>

    <div class="mt-6 flex gap-3">
      <label for="community-game-id" class="sr-only">Game ID</label>
      <input
        id="community-game-id"
        v-model="gameId"
        type="text"
        placeholder="Game ID"
        class="flex-1 rounded-lg bg-zinc-900 px-4 py-2 ring-1 ring-white/10 focus:outline-none focus:ring-blue-500"
      />
      <button
        type="button"
        :disabled="loading"
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
        @click="load"
      >
        {{ loading ? "Loading..." : "Load" }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400">{{ error }}</p>

    <ul class="mt-6 space-y-4">
      <li
        v-for="review in reviews"
        :key="review.id"
        class="rounded-xl bg-zinc-900/60 p-5 ring-1 ring-white/5"
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{{ review.rating }} / 5</span>
          <span
            v-if="review.verified"
            class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/20"
          >
            Verified
          </span>
        </div>
        <p class="mt-2 text-sm text-zinc-300">{{ review.body }}</p>
      </li>
      <li v-if="reviews.length === 0 && !loading" class="text-sm text-zinc-500">
        No reviews yet.
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

interface ReviewView {
  id: string;
  userId: string;
  rating: number;
  body: string;
  verified: boolean;
  createdAt?: string;
}

const gameId = ref("");
const reviews = ref<ReviewView[]>([]);
const loading = ref(false);
const error = ref<string>();

async function load() {
  const trimmed = gameId.value.trim();
  if (!trimmed) {
    error.value = "Enter a game ID";
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    reviews.value = await invoke<ReviewView[]>("fetch_game_reviews", {
      gameId: trimmed,
    });
  } catch (e) {
    console.warn("Failed to load reviews:", e);
    error.value = "Could not load reviews.";
    reviews.value = [];
  } finally {
    loading.value = false;
  }
}
</script>
