<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CriticsHardCriticInfo, SampleReport, SpecDraftView } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { agreement, countVerdicts, previewVerdicts, questionRows, runFlags, type Selection } from '@/utils/specSample'
import EpisodeList from '@/components/specwizard/workbench/EpisodeList.vue'
import EpisodeView from '@/components/specwizard/workbench/EpisodeView.vue'
import SettingsPanel from '@/components/specwizard/workbench/SettingsPanel.vue'
import QuestionsPanel from '@/components/specwizard/workbench/QuestionsPanel.vue'
import IconLive from '~icons/carbon/dot-mark'

/**
 * The workbench of the spec wizard: the whole sample in one live view.
 *
 *   left    the episodes with the verdict the spec gives them now, the
 *           person's word on them, and a field to open any episode by number
 *   middle  the open episode: its videos, its verdict and why, every result
 *           of the critics for it
 *   right   the questions to the model, written and tested here; under
 *           "Details" the rest: the result clicked, thresholds, all flags
 *
 * Every change on the right moves the verdicts on the left and in the middle
 * at once (`previewVerdicts`, from the results of the run). What a changed
 * parameter or a reworded criterion would measure only a test run shows: one
 * episode can be tested from the list or the middle, and an episode tested
 * is worked on with the results of its latest test from then on.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{
  draft: SpecDraftView
  report: SampleReport
  /** the merged results of all test runs, the latest per episode */
  test: SampleReport | null
  /** the fingerprint of the spec on screen */
  specHash: string
  critics: CriticsHardCriticInfo[]
  tenantId: string
}>()
const emit = defineEmits<{
  judge: [judgments: Record<string, 'accept' | 'reject'>]
  add: [pick: string]
  test: [episodes: string]
}>()
const { t } = useI18n()

/** the analysis, with each tested episode's results taken from its latest test */
const effective = computed<SampleReport>(() => {
  const tested = new Map((props.test?.episodes ?? []).map((e) => [e.episode, e]))
  if (!tested.size) return props.report
  return { ...props.report, episodes: props.report.episodes.map((e) => tested.get(e.episode) ?? e) }
})
/** per episode: whether its results are from a test, and of the spec on screen or an earlier state */
const testState = computed<Record<number, 'current' | 'older'>>(() => {
  const out: Record<number, 'current' | 'older'> = {}
  for (const e of props.test?.episodes ?? []) {
    const hash = props.draft.testSpecs[String(e.episode)]
    if (hash) out[e.episode] = hash === props.specHash ? 'current' : 'older'
  }
  return out
})
const testing = computed(() =>
  props.draft.testRuns.filter((r) => r.status === 'queued' || r.status === 'running').flatMap((r) => r.episodes),
)
const failedTest = computed(() => {
  const last = props.draft.testRuns.at(-1)
  return last?.status === 'failed' ? last : null
})

const rows = computed(() => previewVerdicts(effective.value, form.value, runFlags(effective.value)))
const counts = computed(() => countVerdicts(rows.value))
const stats = computed(() => agreement(rows.value, props.draft.judgments))
const episode = ref<number | null>(props.report.episodes[0]?.episode ?? null)
const selection = ref<Selection>(null)
const row = computed(() => rows.value.find((r) => r.episode === episode.value) ?? null)
const questions = computed(() => (episode.value == null ? [] : questionRows(effective.value, form.value, episode.value)))

/** the right side: the questions, or the details; a check or the model's overall word clicked opens the details */
const side = ref<'questions' | 'details'>('questions')
watch(selection, (s) => {
  if (s) side.value = s.kind === 'criterion' ? 'questions' : 'details'
})

// an episode picked by number opens as soon as its analysis is in
const waitingFor = ref<number | null>(null)
watch(
  () => props.report.episodes.map((e) => e.episode).join(','),
  () => {
    if (waitingFor.value != null && props.report.episodes.some((e) => e.episode === waitingFor.value)) {
      episode.value = waitingFor.value
      waitingFor.value = null
    }
    if (episode.value == null || !props.report.episodes.some((e) => e.episode === episode.value)) {
      episode.value = props.report.episodes[0]?.episode ?? null
    }
  },
)
function add(pick: string, first: number) {
  waitingFor.value = first
  emit('add', pick)
}
function judge(value: 'accept' | 'reject' | null) {
  if (episode.value == null) return
  const next = { ...props.draft.judgments }
  if (value) next[String(episode.value)] = value
  else delete next[String(episode.value)]
  emit('judge', next)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      class="flex flex-wrap items-center gap-2 rounded-panel border border-surface-300 bg-surface-0 px-3 py-2 dark:border-surface-700 dark:bg-surface-900"
    >
      <span class="text-ok flex items-center gap-1 text-xs font-medium" :title="t('specWizard.scoring.liveHint')">
        <IconLive class="size-3 animate-pulse" />{{ t('specWizard.scoring.live') }}
      </span>
      <Pill tone="ok">{{ t('verdict.accept') }} · {{ counts.accept }}</Pill>
      <Pill tone="warn">{{ t('verdict.review') }} · {{ counts.review }}</Pill>
      <Pill tone="bad">{{ t('verdict.reject') }} · {{ counts.reject }}</Pill>
      <span v-if="stats.judged" class="text-sm" :class="stats.differ.length ? 'text-warn' : 'text-ok'">
        {{ t('specWizard.bench.agree', { n: stats.agree, of: stats.judged }) }}
      </span>
      <InfoButton k="wbLive" />
    </div>

    <div class="grid items-start gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_22rem]">
      <aside class="gym-panel p-3 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
        <EpisodeList
          :draft="draft"
          :rows="rows"
          :selected="episode"
          :dataset-episodes="report.dataset_episodes ?? null"
          :tested="testState"
          :testing="testing"
          @select="episode = $event"
          @add="add"
          @test="emit('test', String($event))"
        />
      </aside>

      <main class="gym-panel min-w-0 p-3">
        <EpisodeView
          v-if="episode != null"
          :draft="draft"
          :report="effective"
          :form="form"
          :episode="episode"
          :row="row"
          :tested="testState[episode] ?? null"
          :testing="testing.includes(episode)"
          :test-failed="failedTest?.episodes.includes(episode) ? (failedTest.error ?? '') : null"
          :selection="selection"
          :tenant-id="tenantId"
          @select="selection = $event"
          @judge="judge"
          @test="emit('test', String(episode))"
        />
        <div v-else class="gym-empty">{{ t('specWizard.bench.noEpisode') }}</div>
      </main>

      <aside class="gym-panel p-3 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
        <div class="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-surface-100 p-1 text-sm dark:bg-surface-800" role="tablist">
          <button
            v-for="s in ['questions', 'details'] as const"
            :key="s"
            type="button"
            role="tab"
            :aria-selected="side === s"
            class="cursor-pointer rounded-md px-2 py-1 font-medium"
            :class="side === s ? 'bg-surface-0 shadow-sm dark:bg-surface-950' : 'text-surface-500 dark:text-surface-400'"
            @click="side = s"
          >
            {{ t(`specWizard.q.side.${s}`) }}
          </button>
        </div>
        <QuestionsPanel
          v-if="side === 'questions'"
          v-model="form"
          :episode="episode"
          :rows="questions"
          :active="selection?.kind === 'criterion' ? selection.id : null"
          :testing="episode != null && testing.includes(episode)"
          @select="selection = { kind: 'criterion', id: $event }"
          @test="episode != null && emit('test', String(episode))"
        />
        <SettingsPanel
          v-else
          v-model="form"
          :report="effective"
          :critics="critics"
          :rows="rows"
          :selection="selection"
          :episode="episode"
          :judgments="draft.judgments"
          @pick="episode = $event"
          @select="selection = $event"
        />
      </aside>
    </div>
  </div>
</template>
