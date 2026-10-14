<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import type { SampleReport, SpecDraftView } from '@/types/gym'
import { cycleCounts, sampleTasks } from '@/utils/specSample'
import { formatEpisodes, parseEpisodes } from '@/utils/episodes'
import SampleSheet from '@/components/specwizard/SampleSheet.vue'
import EpisodePickField from './EpisodePickField.vue'
import IconRestart from '~icons/carbon/restart'

/**
 * Step 2 of the spec wizard: the critics in auto mode over the picked episodes
 * of the sample ("0-9", "1-3,6,8"); a new pick runs it again. While they run the step shows how far they are; afterwards what they
 * read from the data (task, robot, cameras, repetitions), how they judged the
 * sample with the spec they generated, and a contact sheet of every episode.
 * Everything here is the critics' word; the next steps turn it into the spec.
 */
const props = defineProps<{ draft: SpecDraftView; report: SampleReport | null; tenantId: string }>()
const emit = defineEmits<{ rerun: [pick?: string] }>()
const { t } = useI18n()

const running = computed(() => props.draft.analysisStatus === 'queued' || props.draft.analysisStatus === 'running')
/** the stage the critics are in and how far, for the bar */
const stage = computed(() => {
  const p = props.draft.analysisProgress
  const name = p.soft ? 'soft' : p.hard ? 'hard' : null
  const at = name ? p[name]! : null
  return { name, percent: at && at.total ? Math.round((at.done / at.total) * 100) : 0, at }
})

const tasks = computed(() => (props.report ? sampleTasks(props.report) : []))
const cycles = computed(() => (props.report ? cycleCounts(props.report) : { perEpisode: [], typical: null }))
const arms = computed(() => {
  const robot = (props.draft.spec?.robot ?? {}) as { active_arms?: string[] }
  return robot.active_arms ?? []
})
const topFlags = computed(() =>
  Object.entries(props.report?.flag_counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8),
)
/** the episodes the analysis ran over */
const analysed = computed(() => formatEpisodes(props.report?.episodes.map((e) => e.episode) ?? []))
/** the pick names episodes the run did not cover: the sample shown is not the one asked for */
const stale = computed(() => {
  if (!props.report) return false
  const parsed = parseEpisodes(props.draft.episodeSelection)
  const total = props.report.dataset_episodes ?? Infinity
  const ran = new Set(props.report.episodes.map((e) => e.episode))
  return parsed.ok && parsed.episodes.some((e) => e < total && !ran.has(e))
})
const pick = ref(props.draft.episodeSelection)
watch(
  () => props.draft.episodeSelection,
  (next) => (pick.value = next),
)
const pickField = ref<InstanceType<typeof EpisodePickField> | null>(null)
function repick() {
  const parsed = parseEpisodes(pick.value)
  if (parsed.ok && parsed.episodes.length) emit('rerun', formatEpisodes(parsed.episodes))
}
const verdictTone = (v: string) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
const sheet = (episode: number) => gymApi.specDraftSheetUrl(props.tenantId, props.draft.id, episode)
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">{{ t('specWizard.analysis.title') }}</h2>
    <p class="mt-1 mb-5 text-surface-600 dark:text-surface-300">
      {{ t('specWizard.analysis.lead', { pick: draft.episodeSelection }) }}
    </p>

    <!-- the run is going -->
    <div v-if="running" class="rounded-panel border border-surface-300 p-4 dark:border-surface-700">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="font-medium">{{
          stage.name ? t(`specWizard.analysis.stage.${stage.name}`) : t('specWizard.analysis.stage.preparing')
        }}</span>
        <span v-if="stage.at" class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400"
          >{{ stage.at.done }} / {{ stage.at.total }}</span
        >
      </div>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
        <div v-if="stage.name" class="h-full bg-primary transition-[width]" :style="{ width: `${stage.percent}%` }" />
        <div v-else class="h-full w-1/3 animate-pulse bg-primary/60" />
      </div>
      <p class="mt-3 text-sm text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.wait') }}</p>
    </div>

    <!-- it failed -->
    <div v-else-if="draft.analysisStatus === 'failed'" class="gym-note border-s-bad">
      <p class="font-medium">{{ t('specWizard.analysis.failed') }}</p>
      <p class="mt-1 font-mono text-xs break-words">{{ draft.analysisError }}</p>
      <SecondaryButton class="mt-3" size="small" :label="t('specWizard.analysis.retry')" @click="emit('rerun')">
        <template #icon><IconRestart class="size-4" /></template>
      </SecondaryButton>
    </div>

    <div v-else-if="draft.analysisStatus === 'none'" class="gym-empty">{{ t('specWizard.analysis.noSample') }}</div>

    <!-- what the critics read from the data -->
    <template v-else-if="report">
      <div v-if="stale" class="gym-note border-s-warn mb-4 flex flex-wrap items-center gap-3">
        <span class="grow">{{ t('specWizard.analysis.stale', { ran: analysed, want: draft.episodeSelection }) }}</span>
        <SecondaryButton size="small" :label="t('specWizard.analysis.rerun')" @click="emit('rerun')">
          <template #icon><IconRestart class="size-4" /></template>
        </SecondaryButton>
      </div>

      <!-- other episodes: a new pick, the analysis runs again -->
      <div class="mb-4 flex flex-wrap items-start gap-3">
        <div class="min-w-56 grow sm:max-w-sm">
          <span class="gym-field">{{ t('specWizard.analysis.pick') }}</span>
          <EpisodePickField ref="pickField" v-model="pick" :dataset-episodes="report.dataset_episodes ?? null" @submit="repick" />
        </div>
        <SecondaryButton
          class="mt-6"
          size="small"
          :label="t('specWizard.analysis.rerunPick')"
          :disabled="!pickField?.valid"
          @click="repick"
        >
          <template #icon><IconRestart class="size-4" /></template>
        </SecondaryButton>
      </div>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          :label="t('specWizard.analysis.episodes')"
          :value="String(report.n_episodes)"
          :sub="t('specWizard.analysis.ofTotal', { n: report.dataset_episodes ?? report.n_episodes })"
        />
        <KpiTile :label="t('specWizard.analysis.robot')" :value="report.robot_type || '?'" :sub="`${report.fps} fps`" small />
        <KpiTile :label="t('specWizard.analysis.cameras')" :value="String(report.cameras.length)" />
        <KpiTile
          :label="t('specWizard.analysis.cycles')"
          :value="cycles.typical == null ? '?' : String(cycles.typical)"
          :sub="t('specWizard.analysis.cyclesSub')"
        />
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <span class="gym-field">{{ t('specWizard.analysis.found') }}</span>
          <dl class="gym-panel grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-3 text-sm">
            <dt class="text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.task') }}</dt>
            <dd>
              <span v-for="row in tasks" :key="row.task" class="block">
                „{{ row.task }}“
                <span v-if="tasks.length > 1" class="text-xs text-surface-500">· {{ row.episodes }}</span>
              </span>
              <span v-if="!tasks.length" class="text-surface-500">{{ t('specWizard.analysis.noTask') }}</span>
            </dd>
            <dt class="text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.arms') }}</dt>
            <dd>{{ arms.length ? arms.join(', ') : t('specWizard.analysis.allArms') }}</dd>
            <dt class="text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.cameras') }}</dt>
            <dd class="font-mono text-xs">
              <span v-for="c in report.cameras" :key="c" class="block">{{ c }}</span>
            </dd>
          </dl>
        </div>
        <div>
          <span class="gym-field">{{ t('specWizard.analysis.verdicts') }}</span>
          <div class="gym-panel p-3">
            <div class="flex flex-wrap gap-2">
              <Pill tone="ok">{{ t('verdict.accept') }} · {{ report.counts.accept ?? 0 }}</Pill>
              <Pill tone="warn">{{ t('verdict.review') }} · {{ report.counts.review ?? 0 }}</Pill>
              <Pill tone="bad">{{ t('verdict.reject') }} · {{ report.counts.reject ?? 0 }}</Pill>
            </div>
            <div v-if="topFlags.length" class="mt-3 flex flex-wrap gap-1.5">
              <Pill v-for="[flag, n] in topFlags" :key="flag">{{ flag }} · {{ n }}</Pill>
            </div>
            <p class="mt-3 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.verdictsHint') }}</p>
          </div>
        </div>
      </div>

      <div class="mt-6">
        <span class="gym-field">{{ t('specWizard.analysis.sheets') }}</span>
        <p class="mb-3 text-sm text-surface-500 dark:text-surface-400">{{ t('specWizard.analysis.sheetsHint') }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <div v-for="e in report.episodes" :key="e.episode" class="flex flex-col gap-1">
            <SampleSheet :src="sheet(e.episode)" :episode="e.episode" :caption="`${e.duration_s.toFixed(1)} s`" />
            <div class="flex flex-wrap gap-1">
              <Pill :tone="verdictTone(e.score.verdict)">{{ t(`verdict.${e.score.verdict}`) }}</Pill>
              <Pill v-for="f in e.score.flags.slice(0, 4)" :key="f">{{ f }}</Pill>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
