<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { countVerdicts, previewVerdicts, runFlags, type Verdict } from '@/utils/specSample'
import IconArrow from '~icons/carbon/arrow-right'

/**
 * How the sample would come out with the spec as it stands: every episode as
 * a bar of its total score with the two thresholds drawn in, and the verdict
 * it gets. It follows the form as it is edited, so a threshold or a weight is
 * set by watching the episodes move, not by guessing a number. A preview from
 * the results of the run: what a changed parameter or a new indicator would
 * measure only the test run on the last step shows.
 */
const props = defineProps<{ form: SpecForm; report: SampleReport }>()
const { t } = useI18n()

const rows = computed(() => previewVerdicts(props.report, props.form, runFlags(props.report)))
const counts = computed(() => countVerdicts(rows.value))
const changed = computed(() => rows.value.filter((r) => r.verdict !== r.ranVerdict).length)
const tone = (v: Verdict) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
const barTone = (v: Verdict) => (v === 'accept' ? 'bg-ok' : v === 'review' ? 'bg-warn' : 'bg-bad')
const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="gym-field mb-0!">{{ t('specWizard.scoring.preview') }}</span>
      <Pill tone="ok">{{ t('verdict.accept') }} · {{ counts.accept }}</Pill>
      <Pill tone="warn">{{ t('verdict.review') }} · {{ counts.review }}</Pill>
      <Pill tone="bad">{{ t('verdict.reject') }} · {{ counts.reject }}</Pill>
      <span v-if="changed" class="text-xs text-surface-500 dark:text-surface-400">{{
        t('specWizard.scoring.changed', { n: changed })
      }}</span>
    </div>
    <div class="gym-panel divide-y divide-surface-200 dark:divide-surface-800">
      <div v-for="r in rows" :key="r.episode" class="grid items-center gap-x-3 gap-y-1 p-2.5 sm:grid-cols-[6rem_1fr_auto]">
        <span class="font-mono text-xs">{{ t('specWizard.episode', { n: r.episode }) }}</span>
        <div class="relative h-3 rounded-full bg-surface-200 dark:bg-surface-800" :title="r.total?.toFixed(3) ?? ''">
          <div class="h-full rounded-full" :class="barTone(r.verdict)" :style="{ width: pct(r.total ?? 0) }" />
          <span
            class="bg-warn absolute -top-1 h-5 w-0.5"
            :style="{ left: pct(form.scoring.reviewThreshold) }"
            aria-hidden="true"
          />
          <span class="bg-ok absolute -top-1 h-5 w-0.5" :style="{ left: pct(form.scoring.acceptThreshold) }" aria-hidden="true" />
        </div>
        <div class="flex items-center gap-1.5 justify-self-end">
          <span class="font-mono text-xs tabular-nums">{{ r.total == null ? '?' : r.total.toFixed(2) }}</span>
          <template v-if="r.verdict !== r.ranVerdict">
            <Pill :tone="tone(r.ranVerdict)" class="opacity-60">{{ t(`verdict.${r.ranVerdict}`) }}</Pill>
            <IconArrow class="size-3.5 text-surface-500" />
          </template>
          <Pill :tone="tone(r.verdict)">{{ t(`verdict.${r.verdict}`) }}</Pill>
        </div>
        <div v-if="r.gates.length || r.flags.length" class="flex flex-wrap gap-1 sm:col-span-3 sm:col-start-2">
          <Pill v-for="g in r.gates" :key="g" tone="bad">{{ t('specWizard.scoring.gate', { id: g }) }}</Pill>
          <Pill v-for="f in r.flags" :key="f">{{ f }}</Pill>
        </div>
      </div>
    </div>
    <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.scoring.previewHint') }}</p>
  </div>
</template>
