<script setup lang="ts">
import { computed } from 'vue'

/**
 * The small status label used all over the app: a verdict, a wizard step, a
 * flag, a skill status, a block kind. `tone` follows the figure colours of design.md.
 */
const props = withDefaults(defineProps<{ tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' }>(), { tone: 'neutral' })

const tones = {
  neutral: 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-primary-50 text-primary dark:bg-primary-500/15 dark:text-primary-300',
} as const

const classes = computed(() => tones[props.tone])
</script>

<template>
  <span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap" :class="classes">
    <slot />
  </span>
</template>
