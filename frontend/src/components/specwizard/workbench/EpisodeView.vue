<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import type { SampleReport, SampleVideo, SpecDraftView } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { resultRows, type FlagEffect, type PreviewRow, type ResultRow, type Selection, type Verdict } from '@/utils/specSample'
import SampleSheet from '@/components/specwizard/SampleSheet.vue'
import VerdictExplain from '@/components/specwizard/workbench/VerdictExplain.vue'
import IconUp from '~icons/carbon/thumbs-up'
import IconDown from '~icons/carbon/thumbs-down'
import IconStop from '~icons/carbon/stop-filled-alt'
import IconTest from '~icons/carbon/play-outline'

/**
 * The middle of the workbench: one episode in full. Its camera videos, the
 * verdict the spec gives it right now and why, the person's own word on it,
 * and every result the critics produced for it: the model's overall word, each
 * success criterion with the model's score and reasoning, each technical check
 * with its score, flags and measurements. A click on a result opens its
 * settings on the right; the stop line of each result is drawn on its bar.
 * The episode can be tested alone with the spec on screen: the critics run
 * again on it, the language model included, and its results are those of
 * the test from then on.
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

// ---------------------------------------------------------------- results
const rows = computed(() => resultRows(props.report, props.form, props.episode))
const model = computed(() => rows.value.filter((r) => r.kind === 'model'))
const criteria = computed(() => rows.value.filter((r) => r.kind === 'criterion'))
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

    <!-- the verdict, why, and the person's word -->
    <div v-if="row" class="rounded-lg border border-surface-300 p-3 dark:border-surface-700">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-display text-lg font-semibold">E{{ episode }}</span>
        <Pill :tone="verdictTone(row.verdict)">{{ t(`verdict.${row.verdict}`) }}</Pill>
        <span v-if="row.verdict !== row.ranVerdict" class="text-xs text-surface-500 dark:text-surface-400">{{
          t('specWizard.bench.wasVerdict', { v: t(`verdict.${row.ranVerdict}`) })
        }}</span>
        <span class="font-mono text-sm tabular-nums">{{ fmt(row.total) }}</span>
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
      <div class="relative mt-2 h-2.5 rounded-full bg-surface-200 dark:bg-surface-800">
        <div
          class="h-full rounded-full"
          :class="row.verdict === 'accept' ? 'bg-ok' : row.verdict === 'review' ? 'bg-warn' : 'bg-bad'"
          :style="{ width: pct(row.total) }"
        />
        <span class="bg-warn absolute -top-1 h-4.5 w-0.5" :style="{ left: pct(form.scoring.reviewThreshold) }" />
        <span class="bg-ok absolute -top-1 h-4.5 w-0.5" :style="{ left: pct(form.scoring.acceptThreshold) }" />
      </div>
      <div
        class="mt-3 flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs"
        :class="
          tested === 'current' ? 'bg-primary/10' : tested === 'older' ? 'bg-warn/10' : 'bg-surface-50 dark:bg-surface-800/40'
        "
      >
        <span class="grow">
          <template v-if="testing">{{ t('specWizard.test.runningOne', { n: episode }) }}</template>
          <template v-else-if="tested === 'current'">{{ t('specWizard.test.fromCurrent') }}</template>
          <template v-else-if="tested === 'older'">{{ t('specWizard.test.fromOlder') }}</template>
          <template v-else>{{ t('specWizard.test.fromAnalysis') }}</template>
        </span>
        <SecondaryButton
          size="small"
          :label="t('specWizard.test.one', { n: episode })"
          :loading="testing"
          :disabled="testing"
          :title="t('specWizard.test.oneHint')"
          @click="emit('test')"
        >
          <template #icon><IconTest class="size-4" /></template>
        </SecondaryButton>
        <span v-if="testFailed != null && !testing" class="text-bad basis-full font-mono">
          {{ t('specWizard.test.failed') }} {{ testFailed }}
        </span>
      </div>
      <VerdictExplain :model-value="form" :report="report" :row="row" :judgment="judgment" @select="emit('select', $event)" />
      <p v-if="episodeData?.task" class="mt-1 text-xs text-surface-500 dark:text-surface-400">
        {{ t('specWizard.bench.task', { task: episodeData.task }) }} · {{ episodeData.duration_s.toFixed(1) }} s
      </p>
    </div>

    <!-- every result of the episode -->
    <section
      v-for="group in [
        { key: 'model', title: t('specWizard.bench.groupModel'), rows: [...model, ...criteria] },
        { key: 'checks', title: t('specWizard.bench.groupChecks'), rows: checks },
      ]"
      :key="group.key"
    >
      <template v-if="group.rows.length">
        <span class="gym-field">{{ group.title }}</span>
        <div class="gym-panel divide-y divide-surface-200 dark:divide-surface-800">
          <div
            v-for="r in group.rows"
            :key="`${r.kind}:${r.id}`"
            class="cursor-pointer p-2.5 transition-colors"
            :class="[
              isSelected(r) ? 'bg-primary/10 ring-1 ring-inset ring-primary' : 'hover:bg-surface-50 dark:hover:bg-surface-800/40',
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
</template>
