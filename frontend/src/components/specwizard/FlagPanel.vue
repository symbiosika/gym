<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import { runFlags, sampleFlags, setFlagEffect, type FlagEffect, type SampleFlag } from '@/utils/specSample'

/**
 * Every flag the sample raised, one row each: who raised it (the
 * vision-language model or a technical check), what it means in the critics'
 * words, in which episodes, what the model said there, and what it does to an
 * episode. That last part is a switch the person sets on purpose:
 *
 *   rejects   the episode is out (a check's stop, or a flag that rejects)
 *   review    the episode is held at review, a person looks at it
 *   note      shown with the episode, nothing more
 *   off       switched off: not shown, not counted
 *
 * The switch writes the spec (the check's gate flags, scoring.reject_flags,
 * review_flags, ignore_flags) and the preview above follows at once.
 */
const form = defineModel<SpecForm>({ required: true })
/** `compact` stacks every row, for the narrow side panel of the workbench */
const props = defineProps<{ report: SampleReport; compact?: boolean }>()
const { t, te } = useI18n()

const run = computed(() => runFlags(props.report))
const flags = computed(() => sampleFlags(props.report, form.value))
const vlm = computed(() => flags.value.filter((f) => f.source === 'vlm'))
const checks = computed(() => flags.value.filter((f) => f.source === 'check'))
const n = computed(() => props.report.episodes.length)

type Choice = 'out' | 'review' | 'info' | 'ignore'
const CHOICES: Choice[] = ['out', 'review', 'info', 'ignore']
const choiceOf = (f: SampleFlag): Choice => (f.effect === 'stop' || f.effect === 'reject' ? 'out' : (f.effect as Choice))
function choose(f: SampleFlag, choice: Choice) {
  const effect: FlagEffect = choice === 'out' ? (f.source === 'check' ? 'stop' : 'reject') : choice
  setFlagEffect(form.value, f.flag, effect, run.value, f.source === 'check' ? f.criticId : null)
}
const choiceTone = (c: Choice, on: boolean) =>
  !on
    ? 'border-surface-300 text-surface-600 hover:border-primary dark:border-surface-700 dark:text-surface-300'
    : c === 'out'
      ? 'border-bad bg-bad-soft text-bad'
      : c === 'review'
        ? 'border-warn bg-warn-soft text-warn'
        : c === 'info'
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-surface-400 bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300'

const checkLabel = (id: string | null) => (id && te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : (id ?? ''))
/** a criterion's flag reads best in the criterion's own words */
const criterionText = (f: SampleFlag) =>
  f.source === 'vlm' && f.criticId
    ? form.value.soft.indicators.find((i) => i.id === f.criticId)?.description.trim() || null
    : null
</script>

<template>
  <section>
    <SectionHeader v-if="!compact" :title="t('specWizard.flags.title')" :hint="t('specWizard.flags.hint')" />
    <p v-else class="mb-3 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.flags.hint') }}</p>
    <div v-if="!flags.length" class="gym-empty">{{ t('specWizard.flags.none') }}</div>
    <template v-else>
      <div v-for="group in [vlm, checks].filter((g) => g.length)" :key="group === vlm ? 'vlm' : 'checks'" class="mb-4">
        <span class="gym-field">{{ group === vlm ? t('specWizard.flags.fromModel') : t('specWizard.flags.fromChecks') }}</span>
        <div class="gym-panel divide-y divide-surface-200 dark:divide-surface-800">
          <div v-for="f in group" :key="f.flag" :class="['grid gap-x-4 gap-y-2 p-3', compact ? '' : 'lg:grid-cols-[1fr_auto]']">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-sm font-semibold" :class="f.effect === 'ignore' ? 'line-through opacity-60' : ''">{{
                  f.flag
                }}</span>
                <Pill v-if="f.source === 'check'">{{ checkLabel(f.criticId) }}</Pill>
                <Pill v-else tone="accent">{{ t('specWizard.flags.model') }}</Pill>
                <span class="text-xs text-surface-500 dark:text-surface-400">{{
                  t('specWizard.flags.inEpisodes', { n: f.episodes.length, of: n, list: f.episodes.join(', ') })
                }}</span>
              </div>
              <p class="mt-1 text-sm text-surface-600 dark:text-surface-300">
                <template v-if="criterionText(f)">{{ t('specWizard.flags.criterion', { text: criterionText(f) }) }}</template>
                <template v-else>{{ f.meaning || t('specWizard.flags.noMeaning') }}</template>
              </p>
              <details v-if="f.evidence.length" class="group mt-1">
                <summary class="cursor-pointer text-xs text-surface-600 select-none dark:text-surface-300">
                  {{ t('specWizard.scoring.modelSaw') }}
                </summary>
                <ul class="mt-1 flex flex-col gap-1">
                  <li v-for="ev in f.evidence" :key="ev.episode" class="text-xs">
                    <span class="font-mono">{{ t('specWizard.episodeShort', { n: ev.episode }) }}</span>
                    <span class="text-surface-600 dark:text-surface-300"> {{ ev.text }}</span>
                  </li>
                </ul>
              </details>
            </div>
            <div class="flex flex-col gap-1" :class="compact ? '' : 'lg:items-end'">
              <div class="flex flex-wrap gap-1" role="radiogroup" :aria-label="f.flag">
                <button
                  v-for="c in CHOICES"
                  :key="c"
                  type="button"
                  role="radio"
                  :aria-checked="choiceOf(f) === c"
                  class="cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors"
                  :class="choiceTone(c, choiceOf(f) === c)"
                  :title="t(`specWizard.flags.choiceHint.${c}`)"
                  @click="choose(f, c)"
                >
                  {{ t(`specWizard.flags.choice.${c}`) }}
                </button>
              </div>
              <span class="text-xs text-surface-500 dark:text-surface-400">{{
                f.effect === 'stop'
                  ? t('specWizard.flags.effect.stop', { check: checkLabel(f.criticId) })
                  : t(`specWizard.flags.effect.${f.effect}`)
              }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
