<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SpecForm } from '@/utils/spec'
import type { Decision, PreviewRow, ScorePart, Verdict } from '@/utils/specSample'

/**
 * The calculation of one episode's verdict with its numbers plugged in, the
 * way `lerobot_critics.scoring.aggregate` does it:
 *
 *   hard  = Σ wᵢ·sᵢ / Σ wᵢ   over the technical checks that count
 *   soft  = Σ wⱼ·sⱼ / Σ wⱼ   over the success criteria that count
 *   total = (W_h·hard + W_s·soft) / (W_h + W_s)   a side without a score drops out
 *
 * and then the decision rules in their order, the one that decided marked.
 * Every term is shown, and what is left out of the sums is named with why.
 */
const props = defineProps<{
  form: SpecForm
  row: PreviewRow
  checkLabel: (id: string) => string
  criterionLabel: (id: string) => string
}>()
const emit = defineEmits<{ select: [selection: { kind: 'check' | 'criterion'; id: string }] }>()
const { t } = useI18n()

const f2 = (v: number | null | undefined) => (v == null ? '?' : v.toFixed(2))
/** a weight as it was entered: 1, 0.5, 2 */
const w = (v: number) => String(Math.round(v * 100) / 100)

interface Side {
  key: 'hard' | 'soft'
  kind: 'check' | 'criterion'
  title: string
  value: number | null
  parts: (ScorePart & { label: string; product: number })[]
  sumW: number
  sumWS: number
  skipped: { id: string; label: string; reason: string; italic: boolean }[]
}
const side = (key: 'hard' | 'soft'): Side => {
  const kind = key === 'hard' ? 'check' : 'criterion'
  const label = (id: string) => (key === 'hard' ? props.checkLabel(id) : props.criterionLabel(id))
  const parts = (key === 'hard' ? props.row.hardParts : props.row.softParts).map((p) => ({
    ...p,
    label: label(p.id),
    product: p.weight * p.score,
  }))
  return {
    key,
    kind,
    title: t(`specWizard.formula.${key}`),
    value: key === 'hard' ? props.row.hard : props.row.soft,
    parts,
    sumW: parts.reduce((a, p) => a + p.weight, 0),
    sumWS: parts.reduce((a, p) => a + p.product, 0),
    skipped: props.row.skipped
      .filter((s) => s.source === key)
      .map((s) => ({
        id: s.id,
        label: s.reason === 'flagsOnly' ? t('specWizard.bench.modelOverall') : label(s.id),
        reason: t(`specWizard.formula.skip.${s.reason}`),
        italic: key === 'soft' && s.reason !== 'flagsOnly',
      })),
  }
}
const sides = computed(() => [side('hard'), side('soft')])

const total = computed(() => {
  const { hard, soft } = props.row
  const W = props.row.sideWeights
  const terms: string[] = []
  const weights: string[] = []
  if (hard != null) {
    terms.push(`${w(W.hard)}·${f2(hard)}`)
    weights.push(w(W.hard))
  }
  if (soft != null) {
    terms.push(`${w(W.soft)}·${f2(soft)}`)
    weights.push(w(W.soft))
  }
  return { terms: terms.join(' + '), weights: weights.join(' + ') }
})

/** what stops the episode, by name: "Duplicate frames (CAMSTALL)", "Grasp cycles 0.20 < 0.50" */
const stopNames = computed(() =>
  props.row.blockers
    .filter((b) => b.kind === 'gate')
    .map((b) => {
      if (b.kind !== 'gate') return ''
      const name = b.source === 'soft' ? props.criterionLabel(b.id) : props.checkLabel(b.id)
      return b.flag ? `${name} (${b.flag})` : `${name} ${f2(b.score)} < ${f2(b.limit)}`
    })
    .join(', '),
)

/** the rules in the order the critics apply them; the first that holds decides */
const rules = computed(() => {
  const r = props.row
  const s = props.form.scoring
  const list: { key: Decision; holds: boolean; text: string; outcome: Verdict }[] = [
    {
      key: 'stop',
      holds: r.gates.length > 0,
      text: t('specWizard.formula.rule.stop', { which: stopNames.value || t('specWizard.formula.none') }),
      outcome: 'reject',
    },
    {
      key: 'rejectFlag',
      holds: r.rejects.length > 0,
      text: t('specWizard.formula.rule.rejectFlag', { flags: r.rejects.join(', ') || '·' }),
      outcome: 'reject',
    },
    { key: 'noScore', holds: r.total == null, text: t('specWizard.formula.rule.noScore'), outcome: 'review' },
    {
      key: 'accept',
      holds: r.total != null && r.total >= s.acceptThreshold,
      text: t('specWizard.formula.rule.accept', { total: f2(r.total), accept: f2(s.acceptThreshold) }),
      outcome: 'accept',
    },
    {
      key: 'review',
      holds: r.total != null && r.total >= s.reviewThreshold,
      text: t('specWizard.formula.rule.review', { total: f2(r.total), review: f2(s.reviewThreshold) }),
      outcome: 'review',
    },
    { key: 'belowReview', holds: true, text: t('specWizard.formula.rule.else'), outcome: 'reject' },
  ]
  return list
})
/** the numbered rule that decided; a capped accept was decided by "accept" and then capped, a failed run by none */
const decided = computed<Decision | null>(() =>
  props.row.decidedBy === 'cap' ? 'accept' : props.row.decidedBy === 'error' ? null : props.row.decidedBy,
)
const tone = (v: Verdict) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
</script>

<template>
  <div class="flex flex-col gap-3 text-xs">
    <!-- the two sides -->
    <div v-for="s in sides" :key="s.key" class="rounded-lg bg-surface-50 p-2.5 dark:bg-surface-800/40">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-medium">{{ s.title }}</span>
        <code class="text-surface-500 dark:text-surface-400">{{ s.key }} = Σ w·s / Σ w</code>
      </div>
      <table v-if="s.parts.length" class="mt-1.5 w-full font-mono tabular-nums">
        <tbody>
          <tr
            v-for="p in s.parts"
            :key="p.id"
            class="cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-800"
            @click="emit('select', { kind: s.kind, id: p.id })"
          >
            <td class="max-w-0 truncate py-0.5 pe-2 font-sans" :class="s.kind === 'criterion' ? 'italic' : ''" :title="p.label">
              {{ p.label }}
            </td>
            <td class="py-0.5 text-end whitespace-nowrap text-surface-500 dark:text-surface-400">
              w {{ w(p.weight) }} · s {{ f2(p.score) }}
            </td>
            <td class="w-14 py-0.5 text-end">= {{ f2(p.product) }}</td>
          </tr>
          <tr class="border-t border-surface-300 dark:border-surface-700">
            <td class="py-0.5 pe-2 font-sans text-surface-500 dark:text-surface-400">{{ t('specWizard.formula.sum') }}</td>
            <td class="py-0.5 text-end whitespace-nowrap text-surface-500 dark:text-surface-400">Σ w = {{ w(s.sumW) }}</td>
            <td class="py-0.5 text-end">{{ f2(s.sumWS) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="mt-1 font-mono">
        <template v-if="s.value != null">
          {{ s.key }} = {{ f2(s.sumWS) }} / {{ w(s.sumW) }} = <b>{{ f2(s.value) }}</b>
        </template>
        <span v-else class="font-sans text-surface-500 dark:text-surface-400">{{ t(`specWizard.formula.noSide.${s.key}`) }}</span>
      </div>
      <p v-if="s.skipped.length" class="mt-1 text-surface-500 dark:text-surface-400">
        {{ t('specWizard.formula.notCounted') }}
        <template v-for="(k, i) in s.skipped" :key="k.id + k.reason"
          ><template v-if="i">; </template><span :class="k.italic ? 'italic' : ''">{{ k.label }}</span> ({{ k.reason }})</template
        >
      </p>
    </div>

    <!-- the total -->
    <div class="rounded-lg border border-primary/40 p-2.5">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-medium">{{ t('specWizard.formula.total') }}</span>
        <code class="text-surface-500 dark:text-surface-400">total = (W_h·hard + W_s·soft) / (W_h + W_s)</code>
      </div>
      <div class="mt-1 font-mono">
        <template v-if="row.total != null">
          total = ({{ total.terms }}) / ({{ total.weights }}) = <b class="text-sm">{{ f2(row.total) }}</b>
        </template>
        <span v-else class="font-sans">{{ t('specWizard.formula.noTotal') }}</span>
      </div>
      <p class="mt-1 text-surface-500 dark:text-surface-400">
        {{ t('specWizard.formula.sideWeights', { h: w(form.scoring.hardWeight), s: w(form.scoring.softWeight) }) }}
      </p>
    </div>

    <!-- the decision -->
    <div class="rounded-lg bg-surface-50 p-2.5 dark:bg-surface-800/40">
      <span class="font-medium">{{ t('specWizard.formula.decision') }}</span>
      <ol class="mt-1.5 flex flex-col gap-0.5">
        <li
          v-for="(r, i) in rules"
          :key="r.key"
          class="flex items-baseline gap-2 rounded px-1.5 py-0.5"
          :class="
            r.key === decided
              ? 'bg-primary/10 font-medium ring-1 ring-primary'
              : decided && rules.findIndex((x) => x.key === decided) < i
                ? 'opacity-40'
                : ''
          "
        >
          <span class="w-4 font-mono text-surface-400">{{ i + 1 }}</span>
          <span class="grow">{{ r.text }}</span>
          <span class="font-mono" :class="r.holds ? '' : 'text-surface-400'">{{
            r.key === 'belowReview' ? '' : r.holds ? t('specWizard.formula.yes') : t('specWizard.formula.no')
          }}</span>
          <span class="w-20 text-end"
            >→ <Pill :tone="tone(r.outcome)">{{ t(`verdict.${r.outcome}`) }}</Pill></span
          >
        </li>
        <li
          class="flex items-baseline gap-2 rounded px-1.5 py-0.5"
          :class="row.decidedBy === 'cap' ? 'bg-warn/10 font-medium ring-1 ring-warn' : 'opacity-60'"
        >
          <span class="w-4 font-mono text-surface-400">+</span>
          <span class="grow">{{
            t('specWizard.formula.rule.cap', { flags: row.caps.join(', ') || t('specWizard.formula.none') })
          }}</span>
          <span class="font-mono" :class="row.caps.length ? '' : 'text-surface-400'">{{
            row.caps.length ? t('specWizard.formula.yes') : t('specWizard.formula.no')
          }}</span>
          <span class="w-20 text-end"
            >→ <Pill tone="warn">{{ t('verdict.review') }}</Pill></span
          >
        </li>
      </ol>
      <p v-if="row.decidedBy === 'error'" class="text-bad mt-1.5">{{ t('specWizard.formula.error') }}</p>
      <p class="mt-1.5 text-surface-500 dark:text-surface-400">{{ t('specWizard.formula.firstWins') }}</p>
    </div>
  </div>
</template>
