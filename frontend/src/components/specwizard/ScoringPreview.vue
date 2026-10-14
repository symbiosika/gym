<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import {
  blockerSummary,
  countVerdicts,
  indicatorEvidence,
  previewVerdicts,
  runFlags,
  setFlagEffect,
  type Blocker,
  type BlockerGroup,
  type Verdict,
} from '@/utils/specSample'
import IconArrow from '~icons/carbon/arrow-right'
import IconStop from '~icons/carbon/stop-filled-alt'
import IconFlag from '~icons/carbon/flag'
import IconScore from '~icons/carbon/chart-bar'
import IconWarning from '~icons/carbon/warning-alt'
import IconLive from '~icons/carbon/dot-mark'

/**
 * How the sample would come out with the spec as it stands, live: every
 * episode as a bar of its total score with the two thresholds drawn in, and
 * the verdict it gets.
 *
 * Above the episodes stands what holds them back, grouped over the sample:
 * a stop (a check or a success criterion that rejects an episode whatever its
 * total score), a flag, or a score below "accept from". A stop is named first
 * and said plainly, because no threshold moves an episode that is stopped.
 * Each reason comes with the changes that would let the episodes through, as
 * buttons that change the spec right here, and for a success criterion with
 * what the model saw in each episode: when the model is right the episode did
 * fail, and the stop is doing its job.
 *
 * A preview from the results of the run: what a changed parameter or a
 * reworded criterion would measure only the test run on the last step shows.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{ report: SampleReport }>()
const emit = defineEmits<{ goto: [step: 'success' | 'checks'] }>()
const { t, te } = useI18n()

const rows = computed(() => previewVerdicts(props.report, form.value, runFlags(props.report)))
const counts = computed(() => countVerdicts(rows.value))
const changed = computed(() => rows.value.filter((r) => r.verdict !== r.ranVerdict).length)
const groups = computed(() => blockerSummary(rows.value))
const evidence = computed(() => indicatorEvidence(props.report))
const n = computed(() => rows.value.length)

const tone = (v: Verdict) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
const barTone = (v: Verdict) => (v === 'accept' ? 'bg-ok' : v === 'review' ? 'bg-warn' : 'bg-bad')
const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`
const fmt = (v: number | null | undefined) => (v == null ? '?' : v.toFixed(2))
const range = (scores: number[]) =>
  !scores.length
    ? '?'
    : Math.min(...scores) === Math.max(...scores)
      ? fmt(scores[0])
      : t('specWizard.scoring.range', { min: fmt(Math.min(...scores)), max: fmt(Math.max(...scores)) })
/** a value just below the lowest score, on a 0.05 grid: a line there lets every one of them pass */
const below = (scores: number[]) => Math.floor((Math.min(...scores) - 1e-9) * 20) / 20

const indicatorOf = (id: string) => form.value.soft.indicators.find((i) => i.id === id)
const checkOf = (id: string) => form.value.hardCritics.find((c) => c.id === id)
const checkLabel = (id: string) => (te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : id)
const criterionLabel = (id: string) => indicatorOf(id)?.description.trim() || id
/** the criterion was reworded after the model judged it: its scores belong to the old words */
const reworded = (id: string) => {
  const judged = evidence.value[id]?.judgedText
  const now = indicatorOf(id)?.description.trim()
  return !!judged && !!now && judged.trim() !== now
}

function sentence(g: BlockerGroup): string {
  const b = g.blocker
  const of = { n: g.episodes.length, of: n.value }
  if (b.kind === 'gate' && b.source === 'soft') {
    return t('specWizard.scoring.why.softGate', { ...of, scores: range(g.scores), limit: fmt(b.limit) })
  }
  if (b.kind === 'gate' && b.flag) return t('specWizard.scoring.why.flagGate', { ...of, flag: b.flag, check: checkLabel(b.id) })
  if (b.kind === 'gate') {
    return t('specWizard.scoring.why.hardGate', { ...of, check: checkLabel(b.id), scores: range(g.scores), limit: fmt(b.limit) })
  }
  if (b.kind === 'rejectFlag') return t('specWizard.scoring.why.rejectFlag', { ...of, flag: b.flag })
  if (b.kind === 'reviewFlag') return t('specWizard.scoring.why.reviewFlag', { ...of, flag: b.flag })
  if (b.kind === 'score') return t('specWizard.scoring.why.score', { ...of, scores: range(g.scores), limit: fmt(b.limit) })
  return t('specWizard.scoring.why.error', of)
}

const icon = (b: Blocker) =>
  b.kind === 'gate' ? IconStop : b.kind === 'score' ? IconScore : b.kind === 'error' ? IconWarning : IconFlag

// ------------------------------------------------------------------ the fixes
/** switched off the way the flag list below does it, so the two never disagree */
const ignoreFlag = (flag: string) => setFlagEffect(form.value, flag, 'ignore', runFlags(props.report))
function liftSoftGate(id: string) {
  const ind = indicatorOf(id)
  if (ind) ind.gate = false
}
function lowerSoftGate(id: string, to: number) {
  const ind = indicatorOf(id)
  if (ind) ind.gateBelow = to
}
function liftHardGate(id: string, flag?: string) {
  const c = checkOf(id)
  if (!c) return
  if (flag) c.gateFlags = c.gateFlags.filter((f) => f !== flag)
  else c.gate = false
}
function lowerAccept(to: number) {
  form.value.scoring.acceptThreshold = to
  if (form.value.scoring.reviewThreshold > to)
    form.value.scoring.reviewThreshold = Math.max(0, Math.round((to - 0.1) * 100) / 100)
}

/** the reasons of one episode as short labels */
function reasonLabel(b: Blocker): string {
  if (b.kind === 'gate' && b.source === 'soft')
    return t('specWizard.scoring.tag.softGate', { name: criterionLabel(b.id), score: fmt(b.score) })
  if (b.kind === 'gate' && b.flag) return t('specWizard.scoring.tag.flagGate', { flag: b.flag })
  if (b.kind === 'gate') return t('specWizard.scoring.tag.hardGate', { name: checkLabel(b.id), score: fmt(b.score) })
  if (b.kind === 'rejectFlag' || b.kind === 'reviewFlag') return b.flag
  if (b.kind === 'score') return t('specWizard.scoring.tag.score', { total: fmt(b.total), limit: fmt(b.limit) })
  return t('specWizard.scoring.tag.error')
}
const shortened = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <span class="gym-field mb-0!">{{ t('specWizard.scoring.preview') }}</span>
      <span class="text-ok flex items-center gap-1 text-xs font-medium" :title="t('specWizard.scoring.liveHint')">
        <IconLive class="size-3 animate-pulse" />{{ t('specWizard.scoring.live') }}
      </span>
      <Pill tone="ok">{{ t('verdict.accept') }} · {{ counts.accept }}</Pill>
      <Pill tone="warn">{{ t('verdict.review') }} · {{ counts.review }}</Pill>
      <Pill tone="bad">{{ t('verdict.reject') }} · {{ counts.reject }}</Pill>
      <span v-if="changed" class="text-xs text-surface-500 dark:text-surface-400">{{
        t('specWizard.scoring.changed', { n: changed })
      }}</span>
    </div>

    <!-- what holds the episodes back, and what would let them through -->
    <div v-if="groups.length" class="gym-panel flex flex-col divide-y divide-surface-200 dark:divide-surface-800">
      <div class="px-3 py-2 text-sm font-semibold">{{ t('specWizard.scoring.whyTitle') }}</div>
      <div v-for="g in groups" :key="g.key" class="flex flex-col gap-2 p-3">
        <div class="flex items-start gap-2">
          <component
            :is="icon(g.blocker)"
            class="mt-0.5 size-4 shrink-0"
            :class="g.blocker.kind === 'gate' || g.blocker.kind === 'rejectFlag' ? 'text-bad' : 'text-warn'"
          />
          <div class="min-w-0 grow text-sm">
            <p>{{ sentence(g) }}</p>
            <p
              v-if="g.blocker.kind === 'gate' && g.blocker.source === 'soft'"
              class="mt-1 italic text-surface-600 dark:text-surface-300"
            >
              „{{ criterionLabel(g.blocker.id) }}“
            </p>
            <p class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
              {{ t('specWizard.scoring.episodes', { list: g.episodes.join(', ') }) }}
            </p>
          </div>
        </div>

        <!-- a success criterion: what the model saw, and whether its words still hold -->
        <template v-if="g.blocker.kind === 'gate' && g.blocker.source === 'soft'">
          <div v-if="reworded(g.blocker.id)" class="gym-note border-s-warn text-xs">
            {{ t('specWizard.scoring.reworded', { old: evidence[g.blocker.id]!.judgedText }) }}
          </div>
          <details v-if="evidence[g.blocker.id]" class="group ms-6" open>
            <summary class="cursor-pointer text-xs text-surface-600 select-none dark:text-surface-300">
              {{ t('specWizard.scoring.modelSaw') }}
            </summary>
            <ul class="mt-1.5 flex flex-col gap-1.5">
              <li
                v-for="ep in evidence[g.blocker.id]!.episodes.filter((x) => g.episodes.includes(x.episode))"
                :key="ep.episode"
                class="text-xs"
              >
                <span class="font-mono">{{ t('specWizard.episodeShort', { n: ep.episode }) }} · {{ fmt(ep.score) }}</span>
                <span class="text-surface-600 dark:text-surface-300">
                  {{ ep.evidence || t('specWizard.scoring.noEvidence') }}</span
                >
              </li>
            </ul>
            <p class="mt-1.5 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.scoring.modelRight') }}</p>
          </details>
        </template>

        <div class="ms-6 flex flex-wrap gap-2">
          <template v-if="g.blocker.kind === 'gate' && g.blocker.source === 'soft'">
            <SecondaryButton
              v-if="g.scores.length && below(g.scores) > 0"
              size="small"
              :label="t('specWizard.scoring.fix.lowerGate', { v: below(g.scores).toFixed(2) })"
              @click="lowerSoftGate((g.blocker as { id: string }).id, below(g.scores))"
            />
            <SecondaryButton
              size="small"
              :label="t('specWizard.scoring.fix.liftGate')"
              @click="liftSoftGate((g.blocker as { id: string }).id)"
            />
            <SecondaryButton size="small" :label="t('specWizard.scoring.fix.editCriterion')" @click="emit('goto', 'success')" />
          </template>
          <template v-else-if="g.blocker.kind === 'gate'">
            <SecondaryButton
              v-if="g.blocker.flag"
              size="small"
              :label="t('specWizard.scoring.fix.ignoreFlag', { flag: g.blocker.flag })"
              @click="ignoreFlag((g.blocker as { flag: string }).flag)"
            />
            <SecondaryButton
              size="small"
              :label="t('specWizard.scoring.fix.liftGate')"
              @click="liftHardGate((g.blocker as { id: string }).id, (g.blocker as { flag?: string }).flag)"
            />
            <SecondaryButton size="small" :label="t('specWizard.scoring.fix.editCheck')" @click="emit('goto', 'checks')" />
          </template>
          <SecondaryButton
            v-else-if="g.blocker.kind === 'rejectFlag' || g.blocker.kind === 'reviewFlag'"
            size="small"
            :label="t('specWizard.scoring.fix.ignoreFlag', { flag: g.blocker.flag })"
            @click="ignoreFlag((g.blocker as { flag: string }).flag)"
          />
          <SecondaryButton
            v-else-if="g.blocker.kind === 'score' && g.scores.length && below(g.scores) > 0"
            size="small"
            :label="t('specWizard.scoring.fix.lowerAccept', { v: below(g.scores).toFixed(2) })"
            @click="lowerAccept(below(g.scores))"
          />
        </div>
      </div>
    </div>
    <div v-else class="gym-note border-s-ok text-sm">{{ t('specWizard.scoring.allThrough') }}</div>

    <!-- the episodes -->
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
          <span class="font-mono text-xs tabular-nums">{{ fmt(r.total) }}</span>
          <template v-if="r.verdict !== r.ranVerdict">
            <Pill :tone="tone(r.ranVerdict)" class="opacity-60">{{ t(`verdict.${r.ranVerdict}`) }}</Pill>
            <IconArrow class="size-3.5 text-surface-500" />
          </template>
          <Pill :tone="tone(r.verdict)">{{ t(`verdict.${r.verdict}`) }}</Pill>
        </div>
        <div v-if="r.blockers.length" class="flex flex-wrap gap-1 sm:col-span-2 sm:col-start-2">
          <Pill
            v-for="(b, i) in r.blockers"
            :key="i"
            :tone="b.kind === 'gate' || b.kind === 'rejectFlag' ? 'bad' : 'warn'"
            :title="b.kind === 'gate' && b.evidence ? b.evidence : undefined"
            >{{ shortened(reasonLabel(b)) }}</Pill
          >
        </div>
      </div>
    </div>
    <p class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.scoring.previewHint') }}</p>
  </div>
</template>
