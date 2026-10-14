<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CriticsHardCriticInfo, SampleReport, SpecDraftView } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { agreement, countVerdicts, previewVerdicts, runFlags, type Selection } from '@/utils/specSample'
import EpisodeList from '@/components/specwizard/workbench/EpisodeList.vue'
import EpisodeView from '@/components/specwizard/workbench/EpisodeView.vue'
import SettingsPanel from '@/components/specwizard/workbench/SettingsPanel.vue'
import IconLive from '~icons/carbon/dot-mark'

/**
 * The workbench of the spec wizard: the whole sample in one live view.
 *
 *   left    the episodes with the verdict the spec gives them now, the
 *           person's word on them, and a field to open any episode by number
 *   middle  the open episode: its videos, its verdict and why, every result
 *           of the critics for it
 *   right   the settings: the result clicked in the middle, the thresholds,
 *           the success criteria, all flags
 *
 * Every change on the right moves the verdicts on the left and in the middle
 * at once (`previewVerdicts`, from the results of the run). What a changed
 * parameter or a reworded criterion would measure only the test run shows.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{ draft: SpecDraftView; report: SampleReport; critics: CriticsHardCriticInfo[]; tenantId: string }>()
const emit = defineEmits<{ judge: [judgments: Record<string, 'accept' | 'reject'>]; add: [episode: number] }>()
const { t } = useI18n()

const rows = computed(() => previewVerdicts(props.report, form.value, runFlags(props.report)))
const counts = computed(() => countVerdicts(rows.value))
const stats = computed(() => agreement(rows.value, props.draft.judgments))
const episode = ref<number | null>(props.report.episodes[0]?.episode ?? null)
const selection = ref<Selection>(null)
const row = computed(() => rows.value.find((r) => r.episode === episode.value) ?? null)

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
function add(n: number) {
  waitingFor.value = n
  emit('add', n)
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
      <span class="grow" />
      <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.previewNote') }}</span>
    </div>

    <div class="grid items-start gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_22rem]">
      <aside class="gym-panel p-3 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
        <EpisodeList
          :draft="draft"
          :rows="rows"
          :selected="episode"
          :dataset-episodes="report.dataset_episodes ?? null"
          @select="episode = $event"
          @add="add"
        />
      </aside>

      <main class="gym-panel min-w-0 p-3">
        <EpisodeView
          v-if="episode != null"
          :draft="draft"
          :report="report"
          :form="form"
          :episode="episode"
          :row="row"
          :selection="selection"
          :tenant-id="tenantId"
          @select="selection = $event"
          @judge="judge"
        />
        <div v-else class="gym-empty">{{ t('specWizard.bench.noEpisode') }}</div>
      </main>

      <aside class="gym-panel p-3 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-6rem)] xl:flex-col">
        <SettingsPanel
          v-model="form"
          :report="report"
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
