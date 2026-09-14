<template>
  <div
    class="fixed inset-x-0 bottom-0 z-40 bg-zinc-900/95 p-6 ring-1 ring-white/10 backdrop-blur"
  >
    <div class="mx-auto flex max-w-4xl flex-wrap justify-center gap-2">
      <button
        v-for="key in keys"
        :key="key"
        type="button"
        class="h-12 w-12 rounded-lg bg-white/5 text-sm font-medium text-zinc-100 hover:bg-white/10"
        @click="emit('input', key)"
      >
        {{ key }}
      </button>
      <button
        type="button"
        class="h-12 rounded-lg bg-white/5 px-4 text-sm font-medium text-zinc-100 hover:bg-white/10"
        @click="emit('input', 'Backspace')"
      >
        Backspace
      </button>
      <button
        type="button"
        class="h-12 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500"
        @click="emit('close')"
      >
        Done
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const keys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

const emit = defineEmits<{
  (e: "input", key: string): void;
  (e: "close"): void;
}>();
</script>
