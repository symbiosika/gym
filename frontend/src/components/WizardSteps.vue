<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BlockKind, BlockStep } from '@/types/gym'
import IconCheck from '~icons/carbon/checkmark'

/**
 * The step guide of a block: numbered chips, the current one highlighted.
 * Clickable steps emit `go`; the wizard shows that step to look at, it does
 * not move the block. An evaluation has no selection step.
 */
const props = defineProps<{
  current: BlockStep
  /** a step that is only looked at, not moved to */
  viewing?: BlockStep | null
  reachable: BlockStep[]
  kind?: BlockKind
}>()
const emit = defineEmits<{ go: [step: BlockStep] }>()
const { t } = useI18n()

const ORDER = computed<BlockStep[]>(() =>
  props.kind === 'evaluation'
    ? ['brief', 'plan', 'recording', 'upload', 'review', 'closed']
    : ['brief', 'plan', 'recording', 'upload', 'review', 'selection', 'closed'],
)
const items = computed(() =>
  ORDER.value.map((step, i) => ({
    step,
    n: String(i + 1).padStart(2, '0'),
    label: t(props.kind === 'evaluation' ? `block.evalSteps.${step}` : `day.steps.${step}`),
    active: step === props.current,
    viewed: step === props.viewing,
    done: ORDER.value.indexOf(step) < ORDER.value.indexOf(props.current),
    reachable: props.reachable.includes(step),
  })),
)
</script>

<template>
  <ol class="mb-5 flex snap-x gap-1.5 overflow-x-auto pb-1" aria-label="Steps">
    <li v-for="it in items" :key="it.step" class="snap-start">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors disabled:cursor-default"
        :class="
          it.viewed
            ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30'
            : it.active
              ? 'border-primary bg-primary text-white shadow-glow'
              : it.done
                ? 'border-surface-300 bg-surface-0 text-surface-600 hover:border-primary hover:text-primary dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300'
                : 'border-dashed border-surface-300 bg-transparent text-surface-400 dark:border-surface-700 dark:text-surface-500'
        "
        :disabled="!it.reachable || (it.active && !viewing) || it.viewed"
        :aria-current="it.active ? 'step' : undefined"
        @click="emit('go', it.step)"
      >
        <IconCheck v-if="it.done" class="text-ok size-3.5" aria-hidden="true" />
        <span v-else class="font-mono text-xs font-semibold" :class="it.active ? 'text-white/70' : 'opacity-70'">{{ it.n }}</span>
        <span class="font-medium">{{ it.label }}</span>
      </button>
    </li>
  </ol>
</template>
