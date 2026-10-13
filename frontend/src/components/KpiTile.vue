<script setup lang="ts">
import { computed } from 'vue'

/** One key figure: label, big value, sub line, optional progress bar. */
const props = withDefaults(
  defineProps<{
    label: string
    value: string
    sub?: string
    hero?: boolean
    /** long text values (names) instead of a figure */
    small?: boolean
    /** 0..100 progress bar; pass null for "no value yet" */
    bar?: number | null
    tone?: 'neutral' | 'ok' | 'warn' | 'bad'
  }>(),
  { tone: 'neutral' },
)

const width = computed(() => `${Math.min(100, Math.max(0, props.bar ?? 0))}%`)
const barTone = computed(() => ({ neutral: 'bg-primary', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' })[props.tone])
// the tone has to read without a bar as well: a tile that says something is
// wrong should not look the same as one that says nothing
const subTone = computed(
  () =>
    ({ neutral: 'text-surface-500 dark:text-surface-400', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad font-medium' })[
      props.tone
    ],
)
</script>

<template>
  <div class="gym-panel flex flex-col gap-1 p-3.5" :class="hero ? 'sm:p-4' : ''">
    <span class="text-xs font-semibold tracking-wide text-surface-500 uppercase dark:text-surface-400">{{ label }}</span>
    <span
      class="font-display leading-tight font-semibold"
      :class="small ? 'text-base' : hero ? 'text-3xl tabular-nums' : 'text-2xl tabular-nums'"
      >{{ value }}</span
    >
    <span v-if="sub" class="text-xs" :class="subTone">{{ sub }}</span>
    <div v-if="bar !== undefined" class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
      <i class="block h-full rounded-full transition-[width] duration-300" :class="barTone" :style="{ width }"></i>
    </div>
  </div>
</template>
