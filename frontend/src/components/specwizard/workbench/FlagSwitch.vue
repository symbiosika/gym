<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { flagEffect, runFlags, setFlagEffect, type FlagEffect } from '@/utils/specSample'

/**
 * What one flag does to an episode, as four buttons: rejects, review, note
 * only, off. For a flag of a technical check "rejects" is that check's stop on
 * the flag; for any other it is scoring.reject_flags. Writes the spec at once.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{ report: SampleReport; flag: string; checkId?: string | null }>()
const { t } = useI18n()

type Choice = 'out' | 'review' | 'info' | 'ignore'
const CHOICES: Choice[] = ['out', 'review', 'info', 'ignore']
const run = computed(() => runFlags(props.report))
const effect = computed(() => flagEffect(props.flag, form.value, run.value, props.checkId ?? null))
const choice = computed<Choice>(() => (effect.value === 'stop' || effect.value === 'reject' ? 'out' : (effect.value as Choice)))
function choose(c: Choice) {
  const next: FlagEffect = c === 'out' ? (props.checkId ? 'stop' : 'reject') : c
  setFlagEffect(form.value, props.flag, next, run.value, props.checkId ?? null)
}
const tone = (c: Choice, on: boolean) =>
  !on
    ? 'border-surface-300 text-surface-600 hover:border-primary dark:border-surface-700 dark:text-surface-300'
    : c === 'out'
      ? 'border-bad bg-bad-soft text-bad'
      : c === 'review'
        ? 'border-warn bg-warn-soft text-warn'
        : c === 'info'
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-surface-400 bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300'
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-baseline gap-2">
      <span class="font-mono text-xs font-semibold" :class="effect === 'ignore' ? 'line-through opacity-60' : ''">{{
        flag
      }}</span>
      <span class="truncate text-[11px] text-surface-500 dark:text-surface-400" :title="report.flag_docs?.[flag]">{{
        report.flag_docs?.[flag] ?? ''
      }}</span>
    </div>
    <div class="flex flex-wrap gap-1" role="radiogroup" :aria-label="flag">
      <button
        v-for="c in CHOICES"
        :key="c"
        type="button"
        role="radio"
        :aria-checked="choice === c"
        class="cursor-pointer rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors"
        :class="tone(c, choice === c)"
        :title="t(`specWizard.flags.choiceHint.${c}`)"
        @click="choose(c)"
      >
        {{ t(`specWizard.flags.choice.${c}`) }}
      </button>
    </div>
  </div>
</template>
