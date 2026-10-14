<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import type { SampleReport, SampleVideo, SpecDraftView } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import {
  questionRows,
  resultRows,
  type FlagEffect,
  type PreviewRow,
  type ResultRow,
  type Selection,
  type Verdict,
} from '@/utils/specSample'
import SampleSheet from '@/components/specwizard/SampleSheet.vue'
import VerdictExplain from '@/components/specwizard/workbench/VerdictExplain.vue'
import QuestionList from '@/components/specwizard/workbench/QuestionList.vue'
import Button from '@/volt/Button.vue'
import SecondaryButton from '@/volt/SecondaryButton.vue'
import IconChevron from '~icons/carbon/chevron-right'
import IconUp from '~icons/carbon/thumbs-up'
import IconDown from '~icons/carbon/thumbs-down'
import IconStop from '~icons/carbon/stop-filled-alt'
import IconTest from '~icons/carbon/play-outline'

/**
 * The middle of the workbench: one episode, kept short. Its camera videos,
 * the verdict with one sentence why, the person's own word on it, and the
 * questions to the model with ✓ or ✗ (or "not tested yet" for words changed
 * since). The button asks the model the questions as they are now, on this
 * episode alone. Everything else (the calculation, the ways to accept, the
 * technical checks with their measurements) is under "Details", closed.
 */
const props = defineProps<{
  draft: SpecDraftView
  report: SampleReport
  form: SpecForm
  episode: number
  row: PreviewRow | null
  selection: Selection
  tenantId: string
  /** its results are from a test: of the spec on screen, or of an earlier state */
  tested: 'current' | 'older' | null
  testing: boolean
  /** the error of a failed test run of this episode */
  testFailed: string | null
}>()
const emit = defineEmits<{
  select: [selection: Selection]
  judge: [judgment: 'accept' | 'reject' | null]
  test: []
}>()
const { t, te } = useI18n()

// ------------------------------------------------------------------ video
const videos = ref<SampleVideo[]>([])
const camera = ref('')
const videoError = ref(false)
watch(
  () => props.episode,
  async (episode) => {
    videoError.value = false
    try {
      videos.value = (await gymApi.specEpisodeVideos(props.tenantId, props.draft.id, episode)).filter((v) => v.available)
    } catch {
      videos.value = []
    }
    const primary = props.form.robot.primaryCamera
    if (!videos.value.some((v) => v.camera === camera.value)) {
      camera.value = videos.value.find((v) => v.camera === primary)?.camera ?? videos.value[0]?.camera ?? ''
    }
  },
  { immediate: true },
)
const current = computed(() => videos.value.find((v) => v.camera === camera.value) ?? null)
const src = computed(() =>
  current.value ? gymApi.specEpisodeVideoUrl(props.tenantId, props.draft.id, props.episode, current.value) : '',
)
const cameraName = (key: string) =>
  key
    .split('.')
    .filter((p) => !['observation', 'images', 'video', 'color', 'addons'].includes(p))
    .pop() ?? key
const sheet = computed(() => gymApi.specDraftSheetUrl(props.tenantId, props.draft.id, props.episode))

// -------------------------------------------------------------- questions
const questions = computed(() => questionRows(props.report, props.form, props.episode))
const untested = computed(() => questions.value.filter((q) => q.answer === 'untested').length)
const questionText = (id: string) => props.form.soft.indicators.find((i) => i.id === id)?.description.trim() || id

/** the verdict in one sentence: the rule that decided it, named in plain words */
const why = computed(() => {
  const r = props.row
  if (!r) return ''
  const s = props.form.scoring
  const gate = r.blockers.find((b) => b.kind === 'gate')
  switch (r.decidedBy) {
    case 'stop':
      if (gate?.kind === 'gate' && gate.source === 'soft') return t('specWizard.why.mustNo', { q: questionText(gate.id) })
      if (gate?.kind === 'gate' && gate.flag) return t('specWizard.why.checkFlag', { c: checkLabel(gate.id), flag: gate.flag })
      return t('specWizard.why.check', { c: gate?.kind === 'gate' ? checkLabel(gate.id) : '?' })
    case 'rejectFlag':
      return t('specWizard.why.rejectFlag', { flag: r.rejects.join(', ') })
    case 'cap':
      return t('specWizard.why.cap', { flag: r.caps.join(', ') })
    case 'accept':
      return t('specWizard.why.accept', { total: fmt(r.total), accept: fmt(s.acceptThreshold) })
    case 'review':
      return t('specWizard.why.review', { total: fmt(r.total), accept: fmt(s.acceptThreshold) })
    case 'belowReview':
      return t('specWizard.why.low', { total: fmt(r.total), review: fmt(s.reviewThreshold) })
    case 'noScore':
      return t('specWizard.why.noScore')
    default:
      return t('specWizard.why.error')
  }
})
const sourceText = computed(() =>
  props.tested === 'current'
    ? t('specWizard.test.fromCurrent')
    : props.tested === 'older'
      ? t('specWizard.test.fromOlder')
      : t('specWizard.test.fromAnalysis'),
)

// the details stay open or closed as the person left them
const DETAILS_KEY = 'gym.specWizard.details'
const detailsOpen = ref(false)
try {
  detailsOpen.value = localStorage.getItem(DETAILS_KEY) === '1'
} catch {
  /* private window: closed */
}
watch(detailsOpen, (open) => {
  try {
    localStorage.setItem(DETAILS_KEY, open ? '1' : '0')
  } catch {
    /* the choice lasts for the page */
  }
})

// ---------------------------------------------------------------- results
const rows = computed(() => resultRows(props.report, props.form, props.episode))
const checks = computed(() => rows.value.filter((r) => r.kind === 'check'))
const episodeData = computed(() => props.report.episodes.find((e) => e.episode === props.episode))

const judgment = computed(() => props.draft.judgments[String(props.episode)])
const verdictTone = (v: Verdict) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
const effectTone = (e: FlagEffect) => (e === 'stop' || e === 'reject' ? 'bad' : e === 'review' ? 'warn' : 'neutral')
const pct = (v: number | null) => `${Math.round(Math.min(1, Math.max(0, v ?? 0)) * 100)}%`
const fmt = (v: number | null | undefined) => (v == null ? '?' : v.toFixed(2))

const checkLabel = (id: string) => (te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : id)
const criterionText = (id: string) => props.form.soft.indicators.find((i) => i.id === id)?.description || id
const label = (r: ResultRow) =>
  r.kind === 'check' ? checkLabel(r.id) : r.kind === 'criterion' ? criterionText(r.id) : t('specWizard.bench.modelOverall')
const isSelected = (r: ResultRow) => props.selection?.kind === r.kind && props.selection.id === r.id
const barTone = (r: ResultRow) =>
  r.stopped ? 'bg-bad' : r.score == null ? 'bg-surface-300' : r.score < 0.5 ? 'bg-warn' : 'bg-ok'
const flagMeaning = (flag: string) => props.report.flag_docs?.[flag] ?? ''

/** the measurements of a check worth showing: numbers with their documented label and unit */
function metricsOf(r: ResultRow): { key: string; label: string; value: string }[] {
  return Object.entries(r.metrics)
    .filter(([key, value]) => !key.startsWith('_') && (typeof value === 'number' || typeof value === 'boolean'))
    .slice(0, 12)
    .map(([key, value]) => {
      const doc = props.report.metric_docs?.[`${r.id}.${key}`] as { label?: string; unit?: string } | undefined
      const shown = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : String(value)
      return { key, label: doc?.label ?? key, value: doc?.unit ? `${shown} ${doc.unit}` : shown }
    })
}
const open = ref<string | null>(null)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <!-- the videos -->
    <div>
      <div v-if="videos.length > 1" class="mb-2 flex flex-wrap gap-1">
        <button
          v-for="v in videos"
          :key="v.camera"
          type="button"
          class="cursor-pointer rounded-md border px-2 py-0.5 text-xs capitalize"
          :class="
            v.camera === camera ? 'border-primary bg-primary/10 text-primary' : 'border-surface-300 dark:border-surface-700'
          "
          :title="v.camera"
          @click="camera = v.camera"
        >
          {{ cameraName(v.camera).replace(/_/g, ' ') }}
        </button>
      </div>
      <video
        v-if="src && !videoError"
        :key="src"
        :src="src"
        controls
        autoplay
        muted
        loop
        playsinline
        class="max-h-[50vh] w-full rounded-lg bg-black object-contain"
        @error="videoError = true"
      />
      <div v-else class="max-w-xl">
        <SampleSheet :src="sheet" :episode="episode" :caption="t('specWizard.bench.noVideo')" />
      </div>
    </div>

    <!-- the verdict in one sentence, and the person's word -->
    <div v-if="row" class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-display text-xl font-semibold">E{{ episode }}</span>
        <Pill :tone="verdictTone(row.verdict)" class="text-sm!">{{ t(`verdict.${row.verdict}`) }}</Pill>
        <span class="grow" />
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.yourWord') }}</span>
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs"
          :class="judgment === 'accept' ? 'border-ok bg-ok-soft text-ok' : 'border-surface-300 dark:border-surface-700'"
          :aria-pressed="judgment === 'accept'"
          @click="emit('judge', judgment === 'accept' ? null : 'accept')"
        >
          <IconUp class="size-3.5" />{{ t('specWizard.bench.good') }}
        </button>
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs"
          :class="judgment === 'reject' ? 'border-bad bg-bad-soft text-bad' : 'border-surface-300 dark:border-surface-700'"
          :aria-pressed="judgment === 'reject'"
          @click="emit('judge', judgment === 'reject' ? null : 'reject')"
        >
          <IconDown class="size-3.5" />{{ t('specWizard.bench.bad') }}
        </button>
      </div>
      <p class="text-sm" :class="row.verdict === 'accept' ? 'text-ok' : row.verdict === 'review' ? 'text-warn' : 'text-bad'">
        {{ why }}
      </p>
    </div>

    <!-- the questions to the model -->
    <section v-if="questions.length">
      <div class="mb-1 flex flex-wrap items-center gap-2">
        <span class="gym-field mb-0!">{{ t('specWizard.q.title') }}</span>
        <span class="grow" />
        <span v-if="testing" class="animate-pulse text-xs text-primary">{{
          t('specWizard.test.runningOne', { n: episode })
        }}</span>
        <component
          :is="untested ? Button : SecondaryButton"
          v-else
          size="small"
          :label="t('specWizard.test.one', { n: episode })"
          @click="emit('test')"
        >
          <template #icon><IconTest class="size-4" /></template>
        </component>
        <InfoButton k="wbTest" />
      </div>
      <p v-if="untested" class="mb-1 text-xs text-surface-500 dark:text-surface-400">
        {{ t('specWizard.q.untestedCount', { n: untested }) }}
      </p>
      <p v-if="testFailed != null && !testing" class="text-bad mb-1 font-mono text-xs">
        {{ t('specWizard.test.failed') }} {{ testFailed }}
      </p>
      <QuestionList
        :rows="questions"
        :active="selection?.kind === 'criterion' ? selection.id : null"
        @select="emit('select', $event === 'summary' ? { kind: 'model', id: 'summary' } : { kind: 'criterion', id: $event })"
      />
    </section>

    <!-- everything else, one click away -->
    <details
      class="group rounded-lg border border-surface-300 dark:border-surface-700"
      :open="detailsOpen"
      @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium">
        <IconChevron class="size-4 transition-transform group-open:rotate-90" />
        {{ t('specWizard.q.details') }}
        <span class="text-xs font-normal text-surface-500 dark:text-surface-400">{{ t('specWizard.q.detailsHint') }}</span>
      </summary>
      <div v-if="detailsOpen" class="flex flex-col gap-4 border-t border-surface-200 p-3 dark:border-surface-800">
        <div v-if="row">
          <span class="font-mono text-sm tabular-nums">{{ t('specWizard.q.total', { v: fmt(row.total) }) }}</span>
          <span v-if="row.verdict !== row.ranVerdict" class="ms-2 text-xs text-surface-500 dark:text-surface-400">{{
            t('specWizard.bench.wasVerdict', { v: t(`verdict.${row.ranVerdict}`) })
          }}</span>
          <span class="ms-2 text-xs text-surface-500 dark:text-surface-400">{{ sourceText }}</span>
          <VerdictExplain :model-value="form" :report="report" :row="row" :judgment="judgment" @select="emit('select', $event)" />
          <p v-if="episodeData?.task" class="mt-1 text-xs text-surface-500 dark:text-surface-400">
            {{ t('specWizard.bench.task', { task: episodeData.task }) }} · {{ episodeData.duration_s.toFixed(1) }} s
          </p>
        </div>

        <!-- every result of the episode -->
        <section v-for="group in [{ key: 'checks', title: t('specWizard.bench.groupChecks'), rows: checks }]" :key="group.key">
          <template v-if="group.rows.length">
            <span class="gym-field">{{ group.title }}</span>
            <div class="gym-panel divide-y divide-surface-200 dark:divide-surface-800">
              <div
                v-for="r in group.rows"
                :key="`${r.kind}:${r.id}`"
                class="cursor-pointer p-2.5 transition-colors"
                :class="[
                  isSelected(r)
                    ? 'bg-primary/10 ring-1 ring-inset ring-primary'
                    : 'hover:bg-surface-50 dark:hover:bg-surface-800/40',
                  r.enabled ? '' : 'opacity-50',
                ]"
                role="button"
                tabindex="0"
                @click="emit('select', { kind: r.kind, id: r.id })"
                @keydown.enter="emit('select', { kind: r.kind, id: r.id })"
              >
                <div class="flex items-center gap-2">
                  <IconStop v-if="r.stopped" class="text-bad size-3.5 shrink-0" :title="t('specWizard.bench.stops')" />
                  <span
                    class="min-w-0 grow truncate text-sm"
                    :class="r.kind === 'criterion' ? 'italic' : 'font-medium'"
                    :title="label(r)"
                    >{{ label(r) }}</span
                  >
                  <template v-if="r.kind !== 'model'">
                    <div class="relative h-1.5 w-24 shrink-0 rounded-full bg-surface-200 dark:bg-surface-800">
                      <div class="h-full rounded-full" :class="barTone(r)" :style="{ width: pct(r.score) }" />
                      <span
                        v-if="r.stopBelow != null"
                        class="bg-bad absolute -top-1 h-3.5 w-0.5"
                        :style="{ left: pct(r.stopBelow) }"
                      />
                    </div>
                    <span class="w-9 shrink-0 text-end font-mono text-xs tabular-nums">{{ fmt(r.score) }}</span>
                  </template>
                  <Pill v-else :tone="r.score === 0 ? 'bad' : r.score === 1 ? 'ok' : 'neutral'">{{
                    r.score === 1 ? t('specWizard.bench.taskDone') : r.score === 0 ? t('specWizard.bench.taskFailed') : '?'
                  }}</Pill>
                </div>
                <div v-if="r.flags.length" class="mt-1 flex flex-wrap gap-1">
                  <Pill v-for="f in r.flags" :key="f.flag" :tone="effectTone(f.effect)" :title="flagMeaning(f.flag)"
                    ><span :class="f.effect === 'ignore' ? 'line-through' : ''">{{ f.flag }}</span></Pill
                  >
                </div>
                <p v-if="r.evidence && r.kind !== 'check'" class="mt-1 text-xs text-surface-600 dark:text-surface-300">
                  {{ r.evidence }}
                </p>
                <p v-if="r.error" class="text-bad mt-1 font-mono text-xs">{{ r.error.split('\n')[0] }}</p>
                <template v-if="r.kind === 'check'">
                  <button
                    type="button"
                    class="mt-1 cursor-pointer text-xs text-primary hover:underline"
                    @click.stop="open = open === r.id ? null : r.id"
                  >
                    {{ open === r.id ? t('specWizard.bench.lessDetail') : t('specWizard.bench.moreDetail') }}
                  </button>
                  <dl v-if="open === r.id" class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" @click.stop>
                    <template v-for="m in metricsOf(r)" :key="m.key">
                      <dt class="text-surface-500 dark:text-surface-400">{{ m.label }}</dt>
                      <dd class="font-mono">{{ m.value }}</dd>
                    </template>
                    <template v-if="r.evidence">
                      <dt class="text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.evidence') }}</dt>
                      <dd>{{ r.evidence }}</dd>
                    </template>
                  </dl>
                </template>
              </div>
            </div>
          </template>
        </section>
      </div>
    </details>
  </div>
</template>
