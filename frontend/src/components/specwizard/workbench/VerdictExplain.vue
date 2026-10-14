<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import {
  allFixes,
  applyFix,
  fixesFor,
  fixImpact,
  runFlags,
  scoresOf,
  type Fix,
  type PreviewRow,
  type ScorePart,
  type Verdict,
} from '@/utils/specSample'
import IconOk from '~icons/carbon/checkmark-filled'
import IconNo from '~icons/carbon/close-filled'
import IconWarn from '~icons/carbon/warning-alt-filled'
import IconChevron from '~icons/carbon/chevron-down'
import ScoreFormula from '@/components/specwizard/workbench/ScoreFormula.vue'

/**
 * How the verdict of one episode comes about, in two views: the calculation
 * with every number plugged in (ScoreFormula, the default), or in short as the four steps the critics
 * take (lerobot_critics.scoring.aggregate), each with its own outcome:
 *
 *   1  stops      does a check or a criterion stop the episode? Then it is
 *                 rejected, whatever the score.
 *   2  score      every check and criterion that counts, with score, weight
 *                 and what it costs the total; the two sides weighted into
 *                 the total
 *   3  thresholds the total against "accept from" and "review from"
 *   4  flags      a flag that rejects, or one that caps at review
 *
 * Below it, when the episode is not accepted, what would have to change for
 * it to be: one line per change with a button, and for each change which
 * other episodes of the sample it moves too, since the spec is one for all.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{ report: SampleReport; row: PreviewRow; judgment?: 'accept' | 'reject' }>()
const emit = defineEmits<{ select: [selection: { kind: 'check' | 'criterion'; id: string }] }>()
const { t, te } = useI18n()

const fmt = (v: number | null | undefined) => (v == null ? '?' : v.toFixed(2))
const checkLabel = (id: string) => (te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : id)
const criterionLabel = (id: string) => {
  const text = form.value.soft.indicators.find((i) => i.id === id)?.description.trim() || id
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}
const tone = (v: Verdict | null) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')

/** the calculation or the four steps in short; the choice is kept per browser */
const MODE_KEY = 'gym.specWizard.explainMode'
const readMode = (): 'formula' | 'short' => {
  try {
    return localStorage.getItem(MODE_KEY) === 'short' ? 'short' : 'formula'
  } catch {
    return 'formula'
  }
}
const mode = ref(readMode())
function setMode(next: 'formula' | 'short') {
  mode.value = next
  try {
    localStorage.setItem(MODE_KEY, next)
  } catch {
    /* private window: the choice lasts for the page */
  }
}

const stops = computed(() => props.row.blockers.filter((b) => b.kind === 'gate'))
const open = ref(false)
const parts = computed(() =>
  [
    ...props.row.hardParts.map((p) => ({ ...p, kind: 'check' as const, label: checkLabel(p.id) })),
    ...props.row.softParts.map((p) => ({ ...p, kind: 'criterion' as const, label: criterionLabel(p.id) })),
  ].sort((a, b) => b.cost - a.cost),
)
const sideWeights = computed(() => ({
  hard: props.row.hard != null ? form.value.scoring.hardWeight : 0,
  soft: props.row.soft != null ? form.value.scoring.softWeight : 0,
}))
const costTone = (p: ScorePart) => (p.cost >= 0.03 ? 'text-bad' : p.cost >= 0.01 ? 'text-warn' : 'text-surface-500')

/**
 * Criteria the model gives (almost) nothing in most of the sample: rarely
 * that every episode failed, more often words that do not fit the task.
 */
const misfits = computed(() =>
  props.row.softParts
    .filter((p) => p.score <= 0.1)
    .map((p) => {
      const scores = scoresOf(props.report, 'criterion', p.id)
      return { id: p.id, low: scores.filter((x) => x.score <= 0.1).length, of: scores.length }
    })
    .filter((m) => m.of > 1 && m.low * 2 >= m.of),
)

// --------------------------------------------------------------- the fixes
const run = computed(() => runFlags(props.report))
const fixes = computed(() => fixesFor(props.row, form.value))
const together = computed(() => allFixes(fixes.value))
const impact = (list: Fix[]) => fixImpact(props.report, form.value, list).changed.filter((c) => c.episode !== props.row.episode)
const label = (f: Fix): string => {
  if (f.type === 'flag') return t('specWizard.explain.fix.flag', { flag: f.flag })
  if (f.type === 'acceptAt') return t('specWizard.explain.fix.acceptAt', { v: fmt(f.to) })
  const name = f.source === 'hard' ? checkLabel(f.id) : criterionLabel(f.id)
  if ('totalAfter' in f) return t('specWizard.explain.fix.weightZero', { name, total: fmt(f.totalAfter) })
  if (f.type === 'lowerStop') return t('specWizard.explain.fix.lowerStop', { name, v: fmt(f.to) })
  return t('specWizard.explain.fix.liftStop', { name })
}
function apply(list: Fix[]) {
  for (const f of list) applyFix(form.value, f, run.value)
}
/** an episode the person calls bad but the spec accepts: "accept from" just above its total */
const tighten = computed<Fix | null>(() =>
  props.judgment === 'reject' && props.row.verdict === 'accept' && props.row.total != null && props.row.total < 1
    ? { type: 'acceptAt', to: Math.min(1, Math.ceil((props.row.total + 0.005) * 100) / 100) }
    : null,
)
</script>

<template>
  <div class="mt-3 flex flex-col gap-2 text-sm">
    <div class="flex items-center gap-1" role="tablist">
      <button
        v-for="m in ['formula', 'short'] as const"
        :key="m"
        type="button"
        role="tab"
        :aria-selected="mode === m"
        class="cursor-pointer rounded-md border px-2 py-0.5 text-xs"
        :class="mode === m ? 'border-primary bg-primary/10 text-primary' : 'border-surface-300 dark:border-surface-700'"
        @click="setMode(m)"
      >
        {{ t(`specWizard.formula.mode.${m}`) }}
      </button>
    </div>

    <ScoreFormula
      v-if="mode === 'formula'"
      :form="form"
      :row="row"
      :check-label="checkLabel"
      :criterion-label="criterionLabel"
      @select="emit('select', $event)"
    />

    <template v-else>
      <!-- 1 · stops -->
      <div class="flex items-start gap-2">
        <span class="mt-0.5 w-4 font-mono text-xs text-surface-400">1</span>
        <IconNo v-if="stops.length" class="text-bad mt-0.5 size-4 shrink-0" />
        <IconOk v-else class="text-ok mt-0.5 size-4 shrink-0" />
        <div class="min-w-0">
          <span class="me-1 font-medium">{{ t('specWizard.explain.stops') }}</span>
          <span v-if="!stops.length" class="text-surface-600 dark:text-surface-300"> {{ t('specWizard.explain.noStop') }}</span>
          <ul v-else class="mt-0.5 flex flex-col gap-0.5">
            <li v-for="(b, i) in stops" :key="i" class="text-bad">
              <template v-if="b.kind === 'gate' && b.flag">
                <button
                  type="button"
                  class="cursor-pointer underline decoration-dotted"
                  @click="emit('select', { kind: 'check', id: b.id })"
                >
                  {{ checkLabel(b.id) }}</button
                >{{ t('specWizard.explain.stopFlag', { flag: b.flag }) }}
              </template>
              <template v-else-if="b.kind === 'gate'">
                <button
                  type="button"
                  class="cursor-pointer underline decoration-dotted"
                  @click="emit('select', { kind: b.source === 'soft' ? 'criterion' : 'check', id: b.id })"
                >
                  {{ b.source === 'soft' ? criterionLabel(b.id) : checkLabel(b.id) }}</button
                >{{ t('specWizard.explain.stopScore', { score: fmt(b.score), limit: fmt(b.limit) }) }}
              </template>
            </li>
            <li class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.explain.stopRule') }}</li>
          </ul>
        </div>
      </div>

      <!-- 2 · the score -->
      <div class="flex items-start gap-2">
        <span class="mt-0.5 w-4 font-mono text-xs text-surface-400">2</span>
        <span class="mt-0.5 size-4 shrink-0" />
        <div class="min-w-0 grow">
          <button type="button" class="flex cursor-pointer flex-wrap items-baseline gap-x-1 text-start" @click="open = !open">
            <span class="me-1 font-medium">{{ t('specWizard.explain.score') }}</span>
            <span class="text-surface-600 dark:text-surface-300">
              <template v-if="row.hard != null">{{
                t('specWizard.explain.side.hard', { v: fmt(row.hard), w: sideWeights.hard })
              }}</template>
              <template v-if="row.hard != null && row.soft != null"> · </template>
              <template v-if="row.soft != null">{{
                t('specWizard.explain.side.soft', { v: fmt(row.soft), w: sideWeights.soft })
              }}</template>
            </span>
            <span class="font-mono font-semibold">→ {{ fmt(row.total) }}</span>
            <IconChevron class="size-3.5 self-center text-primary transition-transform" :class="open ? 'rotate-180' : ''" />
            <span class="text-xs text-primary">{{
              open ? t('specWizard.explain.hideParts') : t('specWizard.explain.showParts')
            }}</span>
          </button>
          <div v-if="open" class="mt-2 overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-start text-surface-500 dark:text-surface-400">
                  <th class="py-1 text-start font-medium">{{ t('specWizard.explain.part') }}</th>
                  <th class="py-1 text-end font-medium">{{ t('specWizard.explain.partScore') }}</th>
                  <th class="py-1 text-end font-medium">{{ t('spec.weight') }}</th>
                  <th class="py-1 text-end font-medium" :title="t('specWizard.explain.costHint')">
                    {{ t('specWizard.explain.cost') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in parts"
                  :key="`${p.kind}:${p.id}`"
                  class="cursor-pointer border-t border-surface-200 hover:bg-surface-50 dark:border-surface-800 dark:hover:bg-surface-800/40"
                  @click="emit('select', { kind: p.kind, id: p.id })"
                >
                  <td class="py-1 pe-2">
                    <span class="me-1 text-[10px] text-surface-400 uppercase">{{
                      p.kind === 'check' ? t('specWizard.explain.tagCheck') : t('specWizard.explain.tagModel')
                    }}</span>
                    <span :class="p.kind === 'criterion' ? 'italic' : ''">{{ p.label }}</span>
                  </td>
                  <td class="py-1 text-end font-mono tabular-nums">{{ fmt(p.score) }}</td>
                  <td class="py-1 text-end font-mono tabular-nums">{{ p.weight }}</td>
                  <td class="py-1 text-end font-mono tabular-nums" :class="costTone(p)">
                    {{ p.cost < 0.005 ? '·' : `−${fmt(p.cost)}` }}
                  </td>
                </tr>
                <tr class="border-t-2 border-surface-300 font-semibold dark:border-surface-700">
                  <td class="py-1">{{ t('specWizard.explain.totalLine') }}</td>
                  <td colspan="3" class="py-1 text-end font-mono tabular-nums">{{ fmt(row.total) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-1 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.explain.costHint') }}</p>
          </div>
        </div>
      </div>

      <!-- 3 · thresholds -->
      <div class="flex items-start gap-2">
        <span class="mt-0.5 w-4 font-mono text-xs text-surface-400">3</span>
        <IconOk v-if="row.scoreVerdict === 'accept'" class="text-ok mt-0.5 size-4 shrink-0" />
        <IconWarn v-else-if="row.scoreVerdict === 'review'" class="text-warn mt-0.5 size-4 shrink-0" />
        <IconNo v-else class="text-bad mt-0.5 size-4 shrink-0" />
        <div>
          <span class="me-1 font-medium">{{ t('specWizard.explain.thresholds') }}</span>
          <span class="text-surface-600 dark:text-surface-300">
            {{
              row.scoreVerdict === 'accept'
                ? t('specWizard.explain.overAccept', { total: fmt(row.total), accept: fmt(form.scoring.acceptThreshold) })
                : row.scoreVerdict === 'review'
                  ? t('specWizard.explain.betweenReview', {
                      total: fmt(row.total),
                      accept: fmt(form.scoring.acceptThreshold),
                      review: fmt(form.scoring.reviewThreshold),
                    })
                  : t('specWizard.explain.belowReview', { total: fmt(row.total), review: fmt(form.scoring.reviewThreshold) })
            }}
          </span>
        </div>
      </div>

      <!-- 4 · flags -->
      <div class="flex items-start gap-2">
        <span class="mt-0.5 w-4 font-mono text-xs text-surface-400">4</span>
        <IconNo v-if="row.rejects.length" class="text-bad mt-0.5 size-4 shrink-0" />
        <IconWarn v-else-if="row.caps.length" class="text-warn mt-0.5 size-4 shrink-0" />
        <IconOk v-else class="text-ok mt-0.5 size-4 shrink-0" />
        <div>
          <span class="me-1 font-medium">{{ t('specWizard.explain.flags') }}</span>
          <span v-if="!row.rejects.length && !row.caps.length" class="text-surface-600 dark:text-surface-300">
            {{ t('specWizard.explain.noFlag') }}</span
          >
          <span v-for="f in row.rejects" :key="f" class="text-bad block">{{
            t('specWizard.explain.rejectFlag', { flag: f })
          }}</span>
          <span v-for="f in row.caps" :key="f" class="text-warn block">{{
            t('specWizard.explain.capFlag', { flag: f, meaning: report.flag_docs?.[f] ?? '' })
          }}</span>
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-surface-200 pt-2 dark:border-surface-800">
        <span class="w-4" />
        <span class="me-1 font-medium">{{ t('specWizard.explain.result') }}</span>
        <Pill :tone="tone(row.verdict)">{{ t(`verdict.${row.verdict}`) }}</Pill>
      </div>
    </template>

    <!-- a criterion that probably does not fit the task -->
    <div v-for="m in misfits" :key="m.id" class="gym-note border-s-warn text-xs">
      {{ t('specWizard.explain.misfit', { name: criterionLabel(m.id), n: m.low, of: m.of }) }}
      <button
        type="button"
        class="ms-1 cursor-pointer text-primary underline"
        @click="emit('select', { kind: 'criterion', id: m.id })"
      >
        {{ t('specWizard.explain.misfitOpen') }}
      </button>
    </div>

    <!-- the way to accept -->
    <div
      v-if="fixes.length"
      class="mt-1 rounded-lg border p-3"
      :class="judgment === 'accept' ? 'border-primary bg-primary/5' : 'border-surface-300 dark:border-surface-700'"
    >
      <p class="font-medium">
        {{
          judgment === 'accept'
            ? t('specWizard.explain.youSayGood', { n: row.episode })
            : t('specWizard.explain.toAccept', { n: row.episode })
        }}
      </p>
      <ul class="mt-2 flex flex-col gap-2">
        <li v-for="(f, i) in fixes" :key="i" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="grow">{{ label(f) }}</span>
          <span v-if="impact([f]).length" class="text-xs text-surface-500 dark:text-surface-400">
            {{ t('specWizard.explain.alsoMoves') }}
            <template v-for="(c, j) in impact([f])" :key="c.episode"
              ><template v-if="j">, </template>E{{ c.episode }} {{ t(`verdict.${c.from}`) }} →
              {{ t(`verdict.${c.to}`) }}</template
            >
          </span>
          <SecondaryButton size="small" :label="t('specWizard.explain.apply')" @click="apply([f])" />
        </li>
      </ul>
      <div
        v-if="together.length > 1"
        class="mt-3 flex flex-wrap items-center gap-3 border-t border-surface-200 pt-2 dark:border-surface-800"
      >
        <span class="grow text-xs text-surface-500 dark:text-surface-400">
          {{ t('specWizard.explain.allTogether') }}
          <template v-if="impact(together).length">
            · {{ t('specWizard.explain.alsoMoves') }}
            <template v-for="(c, j) in impact(together)" :key="c.episode"
              ><template v-if="j">, </template>E{{ c.episode }} → {{ t(`verdict.${c.to}`) }}</template
            >
          </template>
        </span>
        <Button size="small" :label="t('specWizard.explain.applyAll')" @click="apply(together)" />
      </div>
      <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.explain.forAll') }}</p>
    </div>
    <div v-else-if="tighten" class="mt-1 rounded-lg border border-surface-300 p-3 dark:border-surface-700">
      <p class="font-medium">{{ t('specWizard.explain.youSayBad', { n: row.episode }) }}</p>
      <div class="mt-2 flex flex-wrap items-center gap-3">
        <span class="grow">{{ label(tighten) }}</span>
        <span v-if="impact([tighten]).length" class="text-xs text-surface-500 dark:text-surface-400">
          {{ t('specWizard.explain.alsoMoves') }}
          <template v-for="(c, j) in impact([tighten])" :key="c.episode"
            ><template v-if="j">, </template>E{{ c.episode }} → {{ t(`verdict.${c.to}`) }}</template
          >
        </span>
        <SecondaryButton size="small" :label="t('specWizard.explain.apply')" @click="apply([tighten])" />
      </div>
      <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.explain.badHint') }}</p>
    </div>
  </div>
</template>
