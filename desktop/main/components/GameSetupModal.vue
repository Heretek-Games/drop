<template>
  <ModalTemplate v-model="isOpen" size-class="sm:max-w-2xl">
    <template #default>
      <div class="sm:flex sm:items-start gap-x-4">
        <div
          class="mx-auto flex size-12 shrink-0 items-center justify-center rounded-full bg-yellow-600/20 sm:mx-0 sm:size-10"
        >
          <WrenchIcon class="size-6 text-yellow-400" aria-hidden="true" />
        </div>
        <div class="mt-3 flex-1 text-center sm:mt-0 sm:text-left">
          <h3 class="text-base font-semibold text-zinc-100">
            Installing {{ gameName }}
          </h3>
          <p class="mt-1 text-xs text-zinc-400">
            Drop is unpacking the downloaded release into your install
            directory.
          </p>
        </div>
      </div>

      <!-- Running -->
      <div v-if="isRunning" class="mt-5 space-y-4">
        <div>
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="truncate text-zinc-300">
              {{ currentStep?.description || "Preparing..." }}
            </span>
            <span class="font-mono text-zinc-400">
              {{ overallPercentage }}%
            </span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              class="h-full rounded-full bg-yellow-500 transition-all duration-300"
              :style="{ width: `${overallPercentage}%` }"
            />
          </div>
          <p class="mt-1 text-[11px] text-zinc-500">
            Step {{ currentStepNumber }} of {{ totalSteps || "?" }}
          </p>
        </div>

        <ol v-if="orderedSteps.length > 0" class="space-y-1">
          <li
            v-for="step in orderedSteps"
            :key="step.index"
            class="flex items-center gap-x-2 text-xs"
          >
            <CheckCircleIcon
              v-if="step.status === 'done'"
              class="size-4 shrink-0 text-green-500"
            />
            <span
              v-else-if="step.status === 'active'"
              class="relative flex size-4 shrink-0 items-center justify-center"
            >
              <span
                class="absolute inline-flex size-3 animate-ping rounded-full bg-yellow-400 opacity-60"
              />
              <span
                class="relative inline-flex size-2 rounded-full bg-yellow-500"
              />
            </span>
            <span
              v-else
              class="size-4 shrink-0 rounded-full border border-zinc-600"
            />
            <span
              :class="
                step.status === 'pending' ? 'text-zinc-500' : 'text-zinc-200'
              "
            >
              {{ step.description }}
            </span>
            <span
              v-if="step.status === 'active' && step.percentage > 0"
              class="font-mono text-zinc-500"
            >
              {{ step.percentage }}%
            </span>
          </li>
        </ol>

        <details class="group rounded-md bg-zinc-950/60 ring-1 ring-zinc-800">
          <summary
            class="flex cursor-pointer items-center gap-x-2 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
          >
            <DocumentTextIcon class="size-4" />
            Setup log
            <ChevronRightIcon
              class="ml-auto size-3 transition-transform group-open:rotate-90"
            />
          </summary>
          <pre
            class="custom-scrollbar max-h-48 overflow-y-auto border-t border-zinc-800 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-400"
            >{{ logText || "Waiting for output..." }}</pre>
        </details>
      </div>

      <!-- Completed -->
      <div v-else-if="status === 'completed'" class="mt-5 space-y-4">
        <div class="rounded-lg border border-green-500/30 bg-green-950/20 p-4">
          <div class="flex items-start gap-x-3">
            <CheckCircleIcon class="size-5 shrink-0 text-green-400" />
            <div>
              <p class="text-sm font-semibold text-green-300">Setup complete</p>
              <p class="mt-1 text-xs text-green-200/80">
                {{ gameName }} is ready to play.
              </p>
            </div>
          </div>
        </div>

        <div
          v-if="isResolving"
          class="rounded-lg border border-blue-500/30 bg-blue-950/20 p-4"
        >
          <p class="text-xs text-blue-200">
            Scanning the installed files to find the game's launch executable...
          </p>
        </div>

        <div
          v-else-if="targetCandidates.length > 0"
          class="rounded-lg border border-yellow-500/30 bg-yellow-950/20 p-4"
        >
          <h4 class="text-sm font-semibold text-zinc-200">
            Choose your launch executable
          </h4>
          <p class="mt-1 text-xs text-zinc-400">
            The installer created {{ targetCandidates.length }} possible game
            executables. Pick the one that starts the game.
          </p>
          <ul class="mt-3 max-h-56 space-y-1 overflow-y-auto custom-scrollbar">
            <li v-for="candidate in targetCandidates" :key="candidate.path">
              <button
                type="button"
                class="flex w-full items-center justify-between rounded-md bg-zinc-800/60 px-3 py-2 text-left text-xs text-zinc-200 ring-1 ring-inset ring-zinc-700 transition hover:bg-zinc-700/80"
                @click="adoptTarget(candidate.path)"
              >
                <span class="truncate font-mono">{{ candidate.path }}</span>
                <span class="ml-3 shrink-0 font-mono text-zinc-500">
                  {{ Math.round(candidate.score) }}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <p v-else-if="resolveError" class="text-xs text-red-400">
          {{ resolveError }}
        </p>

        <div
          v-if="reclaimableBytes > 0 && !reclaimed"
          class="rounded-lg border border-zinc-700 bg-zinc-800/40 p-4 space-y-3"
        >
          <div>
            <h4 class="text-sm font-semibold text-zinc-200">
              Reclaim your disk space
            </h4>
            <p class="mt-1 text-xs text-zinc-400">
              The downloaded archives are no longer needed and can be safely
              removed, freeing
              <span class="font-semibold text-zinc-200">
                {{ formatBytes(reclaimableBytes) }}
              </span>
              of disk space.
            </p>
          </div>
          <div class="flex gap-x-3">
            <button
              type="button"
              :disabled="isReclaiming"
              class="inline-flex items-center gap-x-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
              @click="reclaim()"
            >
              <TrashIcon class="size-4" />
              {{ isReclaiming ? "Cleaning up..." : "Clean Up Archives" }}
            </button>
            <button
              type="button"
              :disabled="isReclaiming"
              class="inline-flex items-center rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-200 ring-1 ring-inset ring-zinc-700 transition hover:bg-zinc-700 disabled:opacity-50"
              @click="keepArchives()"
            >
              Keep Archives
            </button>
          </div>
        </div>

        <div
          v-else-if="reclaimed"
          class="rounded-lg border border-blue-500/30 bg-blue-950/20 p-4"
        >
          <p class="text-xs text-blue-200">
            Reclaimed {{ formatBytes(reclaimedBytes) }} of disk space.
          </p>
        </div>
      </div>

      <!-- Failed / cancelled -->
      <div v-else class="mt-5">
        <div
          class="rounded-md border p-4"
          :class="
            status === 'cancelled'
              ? 'border-zinc-700 bg-zinc-800/40'
              : 'border-red-600/30 bg-red-600/10'
          "
        >
          <div class="flex items-start gap-x-3">
            <ExclamationTriangleIcon
              class="size-5 shrink-0"
              :class="status === 'cancelled' ? 'text-zinc-400' : 'text-red-500'"
            />
            <div>
              <p
                class="text-sm font-medium"
                :class="
                  status === 'cancelled' ? 'text-zinc-300' : 'text-red-400'
                "
              >
                {{
                  status === "cancelled" ? "Setup cancelled" : "Setup failed"
                }}
              </p>
              <p
                v-if="error"
                class="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-400"
              >
                {{ error }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #buttons>
      <button
        v-if="isRunning"
        type="button"
        class="inline-flex w-full justify-center rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-red-400 shadow-sm ring-1 ring-inset ring-zinc-700 hover:bg-zinc-700 hover:text-red-300 sm:w-auto"
        @click="cancel()"
      >
        Cancel
      </button>
      <button
        v-else-if="status === 'completed'"
        type="button"
        class="inline-flex w-full justify-center items-center gap-x-2 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-500 sm:w-auto"
        @click="play()"
      >
        <PlayIcon class="size-4" />
        Play Now
      </button>
      <button
        v-else
        type="button"
        class="inline-flex w-full justify-center rounded-md bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-100 shadow-sm ring-1 ring-inset ring-zinc-700 hover:bg-zinc-700 sm:w-auto"
        @click="close()"
      >
        Close
      </button>
    </template>
  </ModalTemplate>
</template>

<script lang="ts"></script>

<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  PlayIcon,
  TrashIcon,
  WrenchIcon,
} from "@heroicons/vue/20/solid";
import type {
  ExecutableCandidate,
  PipelineCompletedEvent,
  PipelineProgressEvent,
} from "~/types";
const runningPipelines = new Set<string>();

const props = defineProps<{
  gameId: string;
  gameName: string;
}>();

const emit = defineEmits<{
  play: [];
  fallback: [];
}>();

const isOpen = defineModel<boolean>({ default: false });

type SetupStatus = "running" | "completed" | "failed" | "cancelled";

type StepState = {
  index: number;
  id: string;
  description: string;
  percentage: number;
  status: "pending" | "active" | "done";
};

const status = ref<SetupStatus>("running");
const steps = ref<StepState[]>([]);
const currentStepIndex = ref(0);
const logLines = ref<string[]>([]);
const reclaimableBytes = ref(0);
const reclaimedBytes = ref(0);
const reclaimed = ref(false);
const isReclaiming = ref(false);
const error = ref<string | null>(null);

let unlistenProgress: UnlistenFn | undefined;
let unlistenCompleted: UnlistenFn | undefined;

const isRunning = computed(() => status.value === "running");

const isResolving = ref(false);
const targetCandidates = ref<ExecutableCandidate[]>([]);
const resolveError = ref<string | null>(null);
const resolvedTarget = ref<string | null>(null);

async function applyCompletedAsync(event: PipelineCompletedEvent) {
  if (event.success && event.preemptScan) await resolveTarget(null);
}

async function resolveTarget(chosen: string | null): Promise<void> {
  isResolving.value = true;
  if (chosen === null) {
    targetCandidates.value = [];
    resolveError.value = null;
  }
  try {
    const result = await invoke<{
      adopted: string | null;
      candidates: ExecutableCandidate[];
    }>("resolve_launch_target", {
      gameId: props.gameId,
      chosen: chosen ?? undefined,
    });
    resolvedTarget.value = result.adopted ?? resolvedTarget.value;
    if (result.adopted) {
      targetCandidates.value = [];
      resolveError.value = null;
    } else {
      targetCandidates.value = result.candidates;
      if (result.candidates.length === 0) {
        resolveError.value =
          "No game executables were found in the install directory.";
      }
    }
  } catch (e) {
    console.error("launch target resolution failed:", e);
    resolveError.value = String(e);
  } finally {
    isResolving.value = false;
  }
}

async function adoptTarget(path: string) {
  isResolving.value = true;
  try {
    await invoke("resolve_launch_target", {
      gameId: props.gameId,
      chosen: path,
    });
    resolvedTarget.value = path;
    targetCandidates.value = [];
    resolveError.value = null;
  } catch (e) {
    console.error("failed to adopt launch target:", e);
    resolveError.value = String(e);
  } finally {
    isResolving.value = false;
  }
}

const totalSteps = computed(() => steps.value.length);
const currentStep = computed(() => steps.value[currentStepIndex.value]);
const currentStepNumber = computed(() =>
  Math.min(currentStepIndex.value + 1, Math.max(totalSteps.value, 1)),
);
const orderedSteps = computed(() =>
  [...steps.value].sort((a, b) => a.index - b.index),
);
const logText = computed(() => logLines.value.join("\n"));

const overallPercentage = computed(() => {
  if (!totalSteps.value) return 0;
  const current = steps.value[currentStepIndex.value];
  const currentFraction = current ? current.percentage / 100 : 0;
  const fraction =
    (currentStepIndex.value + currentFraction) / totalSteps.value;
  return Math.min(100, Math.round(fraction * 100));
});

function pushLog(line: string) {
  logLines.value.push(line);
  if (logLines.value.length > 500) {
    logLines.value.splice(0, logLines.value.length - 500);
  }
}

function applyProgress(event: PipelineProgressEvent) {
  if (event.gameId !== props.gameId) return;

  const existing = steps.value[event.stepIndex];
  const step: StepState = existing ?? {
    index: event.stepIndex,
    id: event.stepId,
    description: event.description,
    percentage: 0,
    status: "active",
  };
  step.id = event.stepId;
  step.description = event.description || step.description;
  step.percentage = event.percentage;
  step.status = event.percentage >= 100 ? "done" : "active";
  steps.value[event.stepIndex] = step;

  for (const other of steps.value) {
    if (other.index < event.stepIndex) other.status = "done";
  }

  currentStepIndex.value = event.stepIndex;
  if (event.logLine) pushLog(event.logLine);
}

function applyCompleted(event: PipelineCompletedEvent) {
  if (event.gameId !== props.gameId) return;

  runningPipelines.delete(props.gameId);
  reclaimableBytes.value = event.reclaimableBytes;
  error.value = event.error ?? null;

  if (event.success) {
    status.value = "completed";
    for (const step of steps.value) step.status = "done";
  } else if (event.error?.toLowerCase().includes("cancel")) {
    status.value = "cancelled";
  } else {
    status.value = "failed";
  }

  if (status.value === "completed") {
    void applyCompletedAsync(event);
  }
}

async function begin() {
  status.value = "running";
  if (runningPipelines.has(props.gameId)) return;

  runningPipelines.add(props.gameId);
  try {
    await invoke("start_pipeline_setup", { gameId: props.gameId });
  } catch (e) {
    runningPipelines.delete(props.gameId);
    console.error("pipeline setup unavailable, falling back:", e);
    isOpen.value = false;
    emit("fallback");
  }
}

async function cancel() {
  try {
    await invoke("cancel_pipeline_setup", { gameId: props.gameId });
  } catch (e) {
    console.error("failed to cancel pipeline:", e);
  }
}

async function reclaim() {
  isReclaiming.value = true;
  try {
    reclaimedBytes.value = await invoke<number>("reclaim_pipeline_space", {
      gameId: props.gameId,
    });
    reclaimed.value = true;
    reclaimableBytes.value = 0;
  } catch (e) {
    error.value = String(e);
  } finally {
    isReclaiming.value = false;
  }
}

function keepArchives() {
  reclaimableBytes.value = 0;
}

function play() {
  isOpen.value = false;
  emit("play");
}

function close() {
  isOpen.value = false;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

onMounted(async () => {
  unlistenProgress = await listen<PipelineProgressEvent>(
    "pipeline_progress",
    (event) => applyProgress(event.payload),
  );
  unlistenCompleted = await listen<PipelineCompletedEvent>(
    "pipeline_completed",
    (event) => applyCompleted(event.payload),
  );

  if (isOpen.value) await begin();
});

onBeforeUnmount(() => {
  unlistenProgress?.();
  unlistenCompleted?.();
});

watch(isOpen, async (open) => {
  if (open && status.value !== "completed") await begin();
});
</script>

<style scoped>
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: rgb(82 82 91) transparent;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background-color: rgb(82 82 91);
}
</style>
