<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RecordingPlan, RecordingProgress } from '@/types/gym'
import { activeStep, currentVariation, stepDone } from '@/utils/plan'

/**
 * The plan as a checklist while recording: steps, their variations, what is
 * done. A step that is not finished can be clicked to work on it next.
 */
const props = defineProps<{
  plan: RecordingPlan
  progress: RecordingProgress | null
  compact?: boolean
  /** url of a variation's reference image, when the view can show one */
  imageUrl?: (stepId: string, index: number, ref: string) => string
}>()
const emit = defineEmits<{ count: [stepId: string, delta: number]; select: [stepId: string] }>()
const { t } = useI18n()
const current = computed(() => activeStep(props.plan, props.progress))
const doneOf = (id: string) => props.progress?.completed[id] ?? 0
const isDone = (s: RecordingPlan['steps'][number]) => stepDone(props.progress, s) >= s.episodes
/** finished steps cannot be picked: "next" would have nothing to count on */
const selectable = (s: RecordingPlan['steps'][number]) => !isDone(s) && current.value?.id !== s.id
/** Episodes counted on one variation: the variations of a step are worked in order. */
function variationDone(s: RecordingPlan['steps'][number], j: number): number {
  const before = s.variations.slice(0, j).reduce((a, v) => a + v.episodes, 0)
  return Math.max(0, Math.min(s.variations[j]!.episodes, stepDone(props.progress, s) - before))
}
/**
 * The count of a step is typed as well as clicked: after a pause, or when the
 * counting was forgotten for a while, the operator sets where the step stands
 * instead of pressing +1 a dozen times. Sent as the difference to the count.
 */
function setCount(s: RecordingPlan['steps'][number], ev: Event) {
  const input = ev.target as HTMLInputElement
  const wanted = Math.round(Number(input.value))
  const now = doneOf(s.id)
  if (input.value.trim() === '' || Number.isNaN(wanted)) {
    input.value = String(now)
    return
  }
  const next = Math.max(0, Math.min(s.episodes, wanted))
  input.value = String(next)
  if (next !== now) emit('count', s.id, next - now)
}
function select(s: RecordingPlan['steps'][number]) {
  if (selectable(s)) emit('select', s.id)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-for="(s, i) in plan.steps"
      :key="s.id"
      class="rounded-panel border p-3 transition-colors"
      :class="[
        current?.id === s.id
          ? 'border-primary bg-primary/5'
          : isDone(s)
            ? 'border-ok/30 bg-ok-soft/40'
            : 'border-surface-300 bg-surface-50 dark:border-surface-800 dark:bg-surface-800/30',
        selectable(s) ? 'hover:border-primary cursor-pointer' : '',
      ]"
      :role="selectable(s) ? 'button' : undefined"
      :tabindex="selectable(s) ? 0 : undefined"
      :title="selectable(s) ? t('recording.selectStep') : undefined"
      @click="select(s)"
      @keydown.enter.self.prevent="select(s)"
      @keydown.space.self.prevent="select(s)"
    >
      <h4 class="flex items-center gap-2 text-sm font-semibold">
        <span class="font-mono text-xs text-surface-500 dark:text-surface-400">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="min-w-0 grow truncate">{{ s.title }}</span>
        <span class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400"
          >{{ doneOf(s.id) }} / {{ s.episodes }}</span
        >
      </h4>
      <p v-if="s.instructions && !compact" class="mt-1 text-sm text-surface-600 dark:text-surface-300">
        {{ s.instructions }}
      </p>

      <div class="mt-2 flex flex-wrap gap-1.5">
        <div
          v-for="(v, j) in s.variations"
          :key="j"
          class="flex items-center gap-1.5 rounded-full border py-0.5 ps-0.5 pe-2.5 text-xs"
          :class="
            current?.id === s.id && currentVariation(s, stepDone(progress, s)).index === j
              ? 'border-primary text-primary font-medium'
              : variationDone(s, j) >= v.episodes
                ? 'border-ok/40 text-ok'
                : 'border-surface-300 text-surface-600 dark:border-surface-700 dark:text-surface-300'
          "
        >
          <img v-if="v.image && imageUrl" class="size-5 rounded-full object-cover" :src="imageUrl(s.id, j, v.image.ref)" alt="" />
          <span v-else class="size-5"></span>
          <span>{{ v.label }}</span>
          <span class="tabular-nums opacity-70"
            ><template v-if="variationDone(s, j)">{{ variationDone(s, j) }} / </template>{{ v.episodes }}</span
          >
        </div>
      </div>

      <div v-if="!compact" class="mt-2.5 flex flex-wrap items-center gap-2">
        <SecondaryButton
          size="small"
          label="−1"
          :aria-label="t('recording.minusOne')"
          :disabled="!doneOf(s.id)"
          @click.stop="emit('count', s.id, -1)"
        />
        <label class="flex items-center gap-1.5 text-sm" @click.stop>
          <input
            :key="doneOf(s.id)"
            type="number"
            inputmode="numeric"
            :min="0"
            :max="s.episodes"
            :value="doneOf(s.id)"
            class="w-16 rounded-md border border-surface-300 bg-surface-0 px-2 py-1 text-end tabular-nums focus:border-primary focus:outline-none dark:border-surface-700 dark:bg-surface-900"
            :aria-label="t('recording.setCount', { step: s.title })"
            :title="t('recording.setCountHint')"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            @change="setCount(s, $event)"
          />
          <span class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400">/ {{ s.episodes }}</span>
        </label>
        <SecondaryButton
          size="small"
          label="+1"
          :aria-label="t('recording.plusOne')"
          :disabled="doneOf(s.id) >= s.episodes"
          @click.stop="emit('count', s.id, 1)"
        />
        <Pill v-if="isDone(s)" tone="ok">{{ t('recording.completed') }}</Pill>
      </div>
    </div>
  </div>
</template>
