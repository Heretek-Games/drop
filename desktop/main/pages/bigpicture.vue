<template>
  <div class="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
    <header class="flex items-center justify-between px-12 py-8">
      <h1 class="text-3xl font-semibold tracking-tight">Drop Big Picture</h1>
      <button
        type="button"
        class="rounded-lg bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
        @click="keyboardOpen = !keyboardOpen"
      >
        {{ keyboardOpen ? "Hide Keyboard" : "Search" }}
      </button>
    </header>

    <main class="flex-1 px-12 pb-12" aria-label="Game library">
      <div class="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-4">
        <button
          v-for="(tile, index) in tiles"
          :key="tile.id"
          type="button"
          class="group flex aspect-video items-end rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 p-6 text-left ring-2 transition"
          :class="
            index === focusedIndex
              ? 'ring-blue-500 scale-[1.02]'
              : 'ring-transparent'
          "
          :aria-current="index === focusedIndex ? 'true' : undefined"
          @click="focusedIndex = index"
        >
          <span class="text-xl font-medium">{{ tile.title }}</span>
        </button>
      </div>
    </main>

    <OnScreenKeyboard
      v-if="keyboardOpen"
      @input="appendSearch"
      @close="keyboardOpen = false"
    />

    <p class="px-12 pb-6 text-sm text-zinc-500">Search: {{ search || "—" }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

interface Tile {
  id: string;
  title: string;
}

const props = withDefaults(defineProps<{ games?: Tile[] }>(), {
  games: () => [],
});

const tiles = computed<Tile[]>(() => props.games);
const focusedIndex = ref(0);
const keyboardOpen = ref(false);
const search = ref("");
const columns = 4;

function moveFocus(delta: number) {
  if (tiles.value.length === 0) return;
  const next = focusedIndex.value + delta;
  focusedIndex.value = Math.min(Math.max(next, 0), tiles.value.length - 1);
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowRight":
      moveFocus(1);
      break;
    case "ArrowLeft":
      moveFocus(-1);
      break;
    case "ArrowDown":
      moveFocus(columns);
      break;
    case "ArrowUp":
      moveFocus(-columns);
      break;
    case "Enter":
      keyboardOpen.value = true;
      break;
    default:
      return;
  }
  event.preventDefault();
}

// Big-picture navigation is global: arrow keys work without first focusing
// the tile area, so the keydown listener lives on the window instead of on
// a static container element (which would be poor a11y semantics).
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

function appendSearch(key: string) {
  if (key === "Backspace") {
    search.value = search.value.slice(0, -1);
  } else {
    search.value += key;
  }
}
</script>
