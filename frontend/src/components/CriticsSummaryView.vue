<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CriticsSummary, ProfileIndicator } from '@/types/gym'
import { fmtPercent, fmtSecs } from '@/utils/time'
import FindingsOverrides from '@/components/FindingsOverrides.vue'
import IconChevronDown from '~icons/carbon/chevron-down'
import IconWarning from '~icons/carbon/warning-alt-filled'

/**
 * A critics run as the operator sees it: the verdict counts, the findings
 * that decided them, and the recording-session profile (only the indicators
 * that need attention, the rest on demand). The full report is a click away.
 */
const props = defineProps<{
  analysis: CriticsSummary
  reportUrl?: string
  /** with tenant and dataset the findings can be downgraded here */
  tenantId?: string
  datasetId?: string
}>()
const emit = defineEmits<{ changed: []; error: [message: string] }>()
const { t } = useI18n()
const showAll = ref(false)
const showFindings = ref(false)
/** the session profile, its indicators and the dataset findings: diagnosis for the specialist, folded */
const showDetails = ref(false)
/** a summary stored before these fields existed reads as empty, never as a crash */
const overrides = computed(() => props.analysis.overrides ?? { ignoreFlags: [], reviewFlags: [], disabledCritics: [] })
const overridden = computed(
  () => overrides.value.ignoreFlags.length + overrides.value.reviewFlags.length + overrides.value.disabledCritics.length,
)

const attention = computed(() =>
  props.analysis.profile
    .filter((i) => i.status === 'bad' || i.status === 'warn')
    .sort((a, b) => (a.status === 'bad' ? 0 : 1) - (b.status === 'bad' ? 0 : 1)),
)
/** what to do differently next time, straight from the indicators that need attention */
const tips = computed(() => attention.value.filter((i) => i.action).slice(0, 3))
const fine = computed(() => props.analysis.profile.filter((i) => i.status === 'good' || i.status === 'info'))

/** design.md: at least 80 % ok, at least 50 % warn, else bad. */
const rateTone = computed(() => {
  const r = props.analysis.acceptRatePercent
  return r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad'
})

/**
 * What the vision-language model did. A run whose model never answered is
 * "done" for the critics service, because the hard critics carried it, but
 * every verdict was decided without a look at the task: no task success, no
 * anomalies, no human in the workspace. That has to be loud, not a missing
 * suffix on a tile.
 */
const vlm = computed(() => {
  const a = props.analysis
  if (a.softCriticsFailed) return { state: 'failed' as const, label: t('review.vlmFailed') }
  if (a.softCriticsRan) return { state: 'ran' as const, label: 'VLM' }
  return { state: 'off' as const, label: t('review.vlmOff') }
})

const value = (i: ProfileIndicator) => `${i.display ?? ''}${i.unit && i.unit !== '%' ? ' ' + i.unit : (i.unit ?? '')}`
const tones = {
  bad: 'bad',
  warn: 'warn',
  good: 'ok',
  info: 'neutral',
} as const
const border = {
  bad: 'border-s-bad',
  warn: 'border-s-warn',
  good: 'border-s-ok',
  info: 'border-s-surface-400',
} as const
</script>

<template>
  <!--
    The one finding the operator must not scroll past: the model that judges
    what actually happened in the episode did not run.
  -->
  <div
    v-if="analysis.softCriticsFailed"
    class="mb-3.5 rounded-panel border border-s-[3px] border-bad/40 border-s-bad bg-bad-soft px-3.5 py-3"
    role="alert"
  >
    <div class="flex flex-wrap items-center gap-2">
      <IconWarning class="text-bad size-5 shrink-0" aria-hidden="true" />
      <b class="text-bad">{{ t('review.vlmFailedTitle') }}</b>
      <Pill tone="bad">{{ t('review.vlmFailedEpisodes', { n: analysis.softCriticsFailedEpisodes }) }}</Pill>
    </div>
    <p class="mt-1.5 text-sm text-surface-700 dark:text-surface-200">{{ t('review.vlmFailedLead') }}</p>
    <div
      v-if="analysis.softCriticsError"
      class="mt-2 overflow-x-auto rounded bg-surface-0/60 px-2.5 py-1.5 font-mono text-xs dark:bg-surface-950/40"
    >
      {{ analysis.softCriticsError }}
    </div>
    <p class="mt-1.5 text-xs text-surface-600 dark:text-surface-300">{{ t('review.vlmFailedHint') }}</p>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <KpiTile
      :label="t('review.episodes')"
      :value="String(analysis.episodes)"
      :sub="`${analysis.counts.accept} ${t('verdict.accept')} · ${analysis.counts.review} ${t('verdict.review')} · ${analysis.counts.reject} ${t('verdict.reject')}`"
      hero
    />
    <KpiTile
      :label="t('review.acceptRate')"
      :value="fmtPercent(analysis.acceptRatePercent)"
      :sub="t('review.acceptRateHint')"
      :bar="analysis.acceptRatePercent"
      :tone="rateTone"
    />
    <KpiTile
      :label="t('review.median')"
      :value="fmtSecs(analysis.medianDurationSeconds)"
      :sub="`${fmtSecs(analysis.acceptedDurationSeconds)} ${t('review.acceptedTime')}`"
    />
    <KpiTile
      :label="t('review.spec')"
      :value="analysis.specName"
      small
      :tone="vlm.state === 'failed' ? 'bad' : undefined"
      :sub="`${analysis.robotType || '–'} · ${analysis.fps} fps · ${analysis.cameras.length} ${t('review.cameras')} · ${vlm.label}`"
    />
  </div>

  <div v-if="analysis.flagCounts.length || overridden" class="mt-3 flex flex-wrap items-center gap-1.5">
    <Pill
      v-for="f in analysis.flagCounts"
      :key="f.flag"
      :tone="
        overrides.reviewFlags.includes(f.flag) ? 'warn' : analysis.switchable.some((s) => s.flag === f.flag) ? 'bad' : 'neutral'
      "
      :title="analysis.switchable.find((s) => s.flag === f.flag)?.effect ?? ''"
    >
      {{ f.count }} × {{ f.flag }}
    </Pill>
    <Pill v-if="overridden" tone="accent">{{ t('findings.overridden', { n: overridden }) }}</Pill>
    <button
      v-if="tenantId && datasetId && (analysis.rawFlagCounts?.length || analysis.critics?.length)"
      type="button"
      class="text-primary ms-1 flex cursor-pointer items-center gap-1 text-sm hover:underline"
      @click="showFindings = !showFindings"
    >
      <IconChevronDown class="size-3.5 transition-transform" :class="showFindings ? 'rotate-180' : ''" />
      {{ showFindings ? t('findings.hide') : t('findings.show') }}
    </button>
  </div>
  <FindingsOverrides
    v-if="showFindings && tenantId && datasetId"
    class="mt-3"
    :analysis="analysis"
    :tenant-id="tenantId"
    :dataset-id="datasetId"
    @changed="emit('changed')"
    @error="emit('error', $event)"
  />

  <!-- the operator's part of the diagnosis: what to change in the next session -->
  <div v-if="tips.length" class="gym-note border-s-warn mt-3.5">
    <b class="text-surface-900 dark:text-surface-0">{{ t('review.tipsTitle') }}</b>
    <ul class="mt-1 flex list-none flex-col gap-1 p-0">
      <li v-for="i in tips" :key="i.id">
        <b class="font-medium">{{ i.label }}:</b> {{ i.action }}
      </li>
    </ul>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-3">
    <button
      v-if="analysis.profileHeadline || attention.length || fine.length || analysis.datasetFlags.length"
      type="button"
      class="text-primary flex cursor-pointer items-center gap-1 text-sm hover:underline"
      :aria-expanded="showDetails"
      @click="showDetails = !showDetails"
    >
      <IconChevronDown class="size-3.5 transition-transform" :class="showDetails ? 'rotate-180' : ''" />
      {{ showDetails ? t('review.detailsHide') : t('review.detailsShow') }}
    </button>
    <a v-if="reportUrl" :href="reportUrl" target="_blank" rel="noopener" class="text-primary text-sm hover:underline">{{
      t('review.visualReport')
    }}</a>
  </div>

  <div v-if="showDetails" class="mt-1">
    <div v-if="analysis.profileHeadline" class="gym-note mt-3.5" :class="attention.length ? 'border-s-warn' : ''">
      <b class="text-surface-900 dark:text-surface-0">{{ t('review.profile') }}</b>
      <div class="mt-1">{{ analysis.profileHeadline }}</div>
    </div>

    <div v-if="attention.length" class="mt-2.5 flex flex-col gap-1.5">
      <div
        v-for="i in attention"
        :key="i.id"
        class="flex gap-2.5 rounded-panel border border-s-[3px] border-surface-300 bg-surface-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-800/30"
        :class="border[i.status]"
      >
        <Pill :tone="tones[i.status]">{{ i.status }}</Pill>
        <div class="min-w-0">
          <b class="text-sm">{{ i.label }}</b>
          <span class="ms-1.5 font-mono text-xs text-surface-600 dark:text-surface-300">{{ value(i) }}</span>
          <div v-if="i.display_extra" class="text-xs text-surface-500 dark:text-surface-400">
            {{ i.display_extra }}
          </div>
          <div v-if="i.so_what" class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
            {{ i.so_what }}
          </div>
          <div v-if="i.action" class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
            <b>{{ t('review.action') }}:</b> {{ i.action }}
          </div>
        </div>
      </div>
    </div>

    <button
      v-if="fine.length"
      type="button"
      class="text-primary mt-2 flex cursor-pointer items-center gap-1 text-sm hover:underline"
      @click="showAll = !showAll"
    >
      <IconChevronDown class="size-3.5 transition-transform" :class="showAll ? 'rotate-180' : ''" />
      {{ showAll ? t('review.hideFine') : t('review.showFine', { n: fine.length }) }}
    </button>

    <div v-if="showAll" class="mt-2 flex flex-col gap-1.5">
      <div
        v-for="i in fine"
        :key="i.id"
        class="flex gap-2.5 rounded-panel border border-s-[3px] border-surface-300 bg-surface-50 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-800/30"
        :class="border[i.status]"
      >
        <Pill :tone="tones[i.status]">{{ i.status }}</Pill>
        <div class="min-w-0">
          <b class="text-sm">{{ i.label }}</b>
          <span class="ms-1.5 font-mono text-xs text-surface-600 dark:text-surface-300">{{ value(i) }}</span>
          <div v-if="i.what" class="text-xs text-surface-500 dark:text-surface-400">
            {{ i.what }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="analysis.datasetFlags.length" class="mt-3.5">
      <div class="gym-field">{{ t('review.datasetFlags') }}</div>
      <div v-for="f in analysis.datasetFlags" :key="f.flag" class="gym-note mt-2">
        <b class="text-surface-900 dark:text-surface-0">{{ f.flag }}</b>
        <div class="mt-0.5">{{ f.text }}</div>
      </div>
    </div>
  </div>
</template>
