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

    <section class="mt-12">
      <h2 class="text-xl font-semibold">Screenshots</h2>
      <div
        v-if="screenshots.length > 0"
        class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        <img
          v-for="shot in screenshots"
          :key="shot.id"
          :src="useObject(shot.objectId)"
          alt="Game screenshot"
          class="h-32 w-full rounded-lg object-cover ring-1 ring-white/10"
        />
      </div>
      <p v-else-if="!loading" class="mt-2 text-sm text-zinc-500">
        No screenshots yet.
      </p>
    </section>

    <section class="mt-12">
      <h2 class="text-xl font-semibold">Discussion</h2>
      <ul class="mt-4 space-y-2">
        <li v-for="thread in threads" :key="thread.id">
          <button
            type="button"
            class="w-full rounded-lg bg-zinc-900/60 px-4 py-3 text-left ring-1 ring-white/5 hover:ring-blue-500/40"
            @click="openThread(thread.id)"
          >
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{{ thread.title }}</span>
              <span
                v-if="thread.locked"
                class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 ring-1 ring-amber-500/20"
              >
                Locked
              </span>
            </div>
            <p class="mt-1 line-clamp-2 text-xs text-zinc-400">
              {{ thread.body }}
            </p>
          </button>
        </li>
        <li
          v-if="threads.length === 0 && !loading"
          class="text-sm text-zinc-500"
        >
          No threads yet.
        </li>
      </ul>

      <div
        v-if="threadDetail"
        class="mt-6 rounded-xl bg-zinc-900/60 p-5 ring-1 ring-white/5"
      >
        <h3 class="text-sm font-semibold">{{ threadDetail.thread.title }}</h3>
        <p class="mt-2 text-sm text-zinc-300">{{ threadDetail.thread.body }}</p>
        <ul class="mt-4 space-y-3">
          <li
            v-for="post in threadDetail.posts"
            :key="post.id"
            class="rounded-lg bg-zinc-950/60 p-3 text-sm text-zinc-300"
          >
            {{ post.body }}
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useObject } from "~/composables/use-object";

interface ReviewView {
  id: string;
  userId: string;
  rating: number;
  body: string;
  verified: boolean;
  createdAt?: string;
}

interface ForumThreadView {
  id: string;
  userId: string;
  title: string;
  body: string;
  locked: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface ForumPostView {
  id: string;
  userId: string;
  body: string;
  createdAt?: string;
}

interface ForumThreadDetail {
  thread: ForumThreadView;
  posts: ForumPostView[];
}

interface ScreenshotView {
  id: string;
  userId: string;
  objectId: string;
  createdAt?: string;
}

const gameId = ref("");
const reviews = ref<ReviewView[]>([]);
const threads = ref<ForumThreadView[]>([]);
const screenshots = ref<ScreenshotView[]>([]);
const threadDetail = ref<ForumThreadDetail>();
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
  threadDetail.value = undefined;
  try {
    const [reviewList, threadList, shotList] = await Promise.all([
      invoke<ReviewView[]>("fetch_game_reviews", { gameId: trimmed }),
      invoke<ForumThreadView[]>("fetch_forum_threads", { gameId: trimmed }),
      invoke<ScreenshotView[]>("fetch_game_screenshots", { gameId: trimmed }),
    ]);
    reviews.value = reviewList;
    threads.value = threadList;
    screenshots.value = shotList;
  } catch (e) {
    console.warn("Failed to load community data:", e);
    error.value = "Could not load community data.";
    reviews.value = [];
    threads.value = [];
    screenshots.value = [];
  } finally {
    loading.value = false;
  }
}

async function openThread(threadId: string) {
  try {
    threadDetail.value = await invoke<ForumThreadDetail>("fetch_forum_thread", {
      threadId,
    });
  } catch (e) {
    console.warn("Failed to load thread:", e);
  }
}
</script>
