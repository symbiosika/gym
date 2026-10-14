<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CriticsHardCriticInfo, SampleReport } from '@/types/gym'
import type { SpecForm as SpecFormModel } from '@/utils/spec'
import {
  countVerdicts,
  durationRange,
  indicatorEvidence,
  sampleFlags,
  scoresOf,
  softState,
  type PreviewRow,
  type Selection,
} from '@/utils/specSample'
import SpecForm from '@/components/spec/SpecForm.vue'
import NumField from '@/components/spec/NumField.vue'
import FlagPanel from '@/components/specwizard/FlagPanel.vue'
import ScaleSlider from '@/components/specwizard/workbench/ScaleSlider.vue'
import FlagSwitch from '@/components/specwizard/workbench/FlagSwitch.vue'
import IconTrash from '~icons/carbon/trash-can'
import IconMagic from '~icons/carbon/magic-wand'

/**
 * The right side of the workbench: the settings of the spec, next to the
 * episode in the middle. The first tab is the result clicked there (a check,
 * a success criterion, the model's overall word) with everything that decides
 * what it does: on or off, weight, stop line, the flags it raises. Every line
 * is a slider with the episodes of the sample as dots at their score, so the
 * line is set by looking at the episodes it cuts off. The other tabs are the
 * whole spec: thresholds and weights, the success criteria, all flags.
 */
const form = defineModel<SpecFormModel>({ required: true })
const props = defineProps<{
  report: SampleReport
  critics: CriticsHardCriticInfo[]
  rows: PreviewRow[]
  selection: Selection
  episode: number | null
  judgments: Record<string, 'accept' | 'reject'>
}>()
const emit = defineEmits<{ pick: [episode: number]; select: [selection: Selection] }>()
const { t, te } = useI18n()

type Tab = 'selected' | 'scoring' | 'criteria' | 'flags'
const tab = ref<Tab>(props.selection ? 'selected' : 'scoring')
watch(
  () => props.selection,
  (s) => (tab.value = s ? 'selected' : tab.value === 'selected' ? 'scoring' : tab.value),
)

const judged = (episode: number) => props.judgments[String(episode)]
const dotsOf = (list: { episode: number; score: number }[]) => list.map((d) => ({ ...d, judged: judged(d.episode) }))
const totals = computed(() =>
  dotsOf(props.rows.flatMap((r) => (r.total == null ? [] : [{ episode: r.episode, score: r.total }]))),
)
const counts = computed(() => countVerdicts(props.rows))

// ------------------------------------------------------------- the selection
const check = computed(() =>
  props.selection?.kind === 'check' ? form.value.hardCritics.find((c) => c.id === props.selection!.id) : undefined,
)
const criterion = computed(() =>
  props.selection?.kind === 'criterion' ? form.value.soft.indicators.find((i) => i.id === props.selection!.id) : undefined,
)
const checkLabel = (id: string) => (te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : id)
const checkDesc = (id: string) => (te(`spec.critic.${id}.desc`) ? t(`spec.critic.${id}.desc`) : '')
const scoreDots = computed(() =>
  props.selection && props.selection.kind !== 'model'
    ? dotsOf(scoresOf(props.report, props.selection.kind, props.selection.id))
    : [],
)
/** the flags of the selected result: those it raised in the sample, and for a check those it stops on */
const flagsHere = computed(() => {
  const s = props.selection
  if (!s) return []
  const raised = sampleFlags(props.report, form.value)
  if (s.kind === 'check') {
    const own = raised.filter((f) => f.source === 'check' && f.criticId === s.id).map((f) => f.flag)
    return [...new Set([...own, ...(check.value?.gateFlags ?? [])])]
  }
  if (s.kind === 'criterion') return [`VLM_${s.id.toUpperCase()}`]
  return ['VLM_TASK_FAILED', 'VLM_MAJOR_ANOMALY', 'HUMAN_IN_WORKSPACE']
})
/** episodes the selected check stops through a flag rather than through its score line, by flag */
const flagStops = computed(() => {
  const s = props.selection
  if (s?.kind !== 'check') return []
  const by = new Map<string, number>()
  for (const r of props.rows) {
    for (const b of r.blockers) {
      if (b.kind === 'gate' && b.source === 'hard' && b.id === s.id && b.flag) by.set(b.flag, (by.get(b.flag) ?? 0) + 1)
    }
  }
  return [...by.entries()].map(([flag, n]) => ({ flag, n }))
})
const judgedText = computed(() =>
  criterion.value ? indicatorEvidence(props.report)[criterion.value.id]?.judgedText?.trim() : '',
)

// the parameters of a check: the service's defaults, numbers only, overrides kept
const numericParams = computed(() => {
  const c = check.value
  if (!c) return []
  const defaults = props.critics.find((m) => m.id === c.id)?.default_params ?? {}
  return Object.entries(defaults)
    .filter(([, v]) => typeof v === 'number')
    .map(([key, v]) => ({ key, dflt: v as number }))
})
function setParam(key: string, raw: string) {
  const c = check.value
  if (!c) return
  const n = Number(raw)
  if (raw.trim() === '' || Number.isNaN(n)) delete c.params[key]
  else c.params[key] = n
}
const durations = computed(() => (check.value?.id === 'duration' ? durationRange(props.report) : null))
function useDurations() {
  const c = check.value
  const d = durations.value
  if (!c || !d) return
  c.params = { ...c.params, min_s: Math.max(0.5, Math.floor(d.min * 0.5 * 10) / 10), max_s: Math.ceil(d.max * 1.5) }
}

function removeCriterion() {
  const id = criterion.value?.id
  if (!id) return
  form.value.soft.indicators = form.value.soft.indicators.filter((i) => i.id !== id)
  emit('select', null)
}
const softSample = computed(() => (softState(props.report) === 'judged' ? indicatorEvidence(props.report) : undefined))
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3">
    <div class="flex flex-wrap gap-1 border-b border-surface-200 pb-2 dark:border-surface-800" role="tablist">
      <button
        v-for="tb in (['selected', 'scoring', 'criteria', 'flags'] as Tab[]).filter((x) => x !== 'selected' || selection)"
        :key="tb"
        type="button"
        role="tab"
        :aria-selected="tab === tb"
        class="cursor-pointer rounded-md px-2 py-1 text-xs font-medium"
        :class="
          tab === tb
            ? 'bg-primary text-white'
            : 'text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800'
        "
        @click="tab = tb"
      >
        {{ t(`specWizard.bench.tab.${tb}`) }}
      </button>
    </div>

    <div class="min-h-0 overflow-y-auto pe-1">
      <!-- the result clicked in the middle -->
      <template v-if="tab === 'selected' && selection">
        <!-- a technical check -->
        <div v-if="selection.kind === 'check' && check" class="flex flex-col gap-4">
          <div>
            <h3 class="font-semibold">{{ checkLabel(check.id) }}</h3>
            <p class="text-xs text-surface-500 dark:text-surface-400">{{ checkDesc(check.id) }}</p>
          </div>
          <label class="flex items-center gap-2 text-sm"
            ><Checkbox v-model="check.enabled" binary />{{ t('specWizard.bench.checkOn') }}</label
          >
          <template v-if="check.enabled">
            <label class="flex items-center justify-between gap-2 text-sm">
              {{ t('spec.weight') }}
              <NumField v-model="check.weight" :min="0" :step="0.5" :fallback="1" narrow />
            </label>
            <div class="flex flex-col gap-2">
              <label class="flex items-center gap-2 text-sm"
                ><Checkbox v-model="check.gate" binary />{{ t('specWizard.bench.stopBelow') }}</label
              >
              <ScaleSlider
                v-model="check.gateBelow"
                :dots="scoreDots"
                :selected="episode"
                :disabled="!check.gate"
                :label="t('specWizard.bench.stopLine')"
                @pick="emit('pick', $event)"
              >
                <template #default="{ cut }">
                  <span v-if="check.gate" class="text-xs text-surface-500 dark:text-surface-400">{{
                    t('specWizard.bench.cut', { n: cut, of: scoreDots.length })
                  }}</span>
                </template>
              </ScaleSlider>
            </div>
            <p v-for="f in flagStops" :key="f.flag" class="text-bad text-xs">
              {{ t('specWizard.bench.flagStops', { n: f.n, of: rows.length, flag: f.flag }) }}
            </p>
            <div v-if="flagsHere.length" class="flex flex-col gap-2">
              <span class="gym-field mb-0!">{{ t('specWizard.bench.itsFlags') }}</span>
              <FlagSwitch v-for="f in flagsHere" :key="f" v-model="form" :report="report" :flag="f" :check-id="check.id" />
            </div>
            <div v-if="numericParams.length" class="flex flex-col gap-2">
              <span class="gym-field mb-0!">{{ t('spec.params') }}</span>
              <div v-if="durations" class="gym-note text-xs">
                {{ t('specWizard.bench.durations', { min: durations.min.toFixed(1), max: durations.max.toFixed(1) }) }}
                <SecondaryButton class="mt-1" size="small" :label="t('specWizard.checks.useDuration')" @click="useDurations">
                  <template #icon><IconMagic class="size-4" /></template>
                </SecondaryButton>
              </div>
              <label v-for="p in numericParams" :key="p.key" class="flex items-center justify-between gap-2">
                <span class="font-mono text-xs">{{ p.key }}</span>
                <InputText
                  :model-value="check.params[p.key] == null ? '' : String(check.params[p.key])"
                  type="number"
                  step="any"
                  size="small"
                  class="w-24! font-mono! text-xs!"
                  :placeholder="String(p.dflt)"
                  @blur="setParam(p.key, ($event.target as HTMLInputElement).value)"
                  @keydown.enter="setParam(p.key, ($event.target as HTMLInputElement).value)"
                />
              </label>
              <p class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.paramsNote') }}</p>
            </div>
          </template>
        </div>

        <!-- a success criterion -->
        <div v-else-if="selection.kind === 'criterion' && criterion" class="flex flex-col gap-4">
          <FormField :label="t('specWizard.bench.criterionText')">
            <Textarea v-model="criterion.description" rows="3" fluid auto-resize />
          </FormField>
          <p v-if="judgedText && judgedText !== criterion.description.trim()" class="text-warn text-xs">
            {{ t('specWizard.success.reworded', { old: judgedText }) }}
          </p>
          <label class="flex items-center justify-between gap-2 text-sm">
            {{ t('spec.weight') }}
            <NumField v-model="criterion.weight" :min="0" :step="0.5" :fallback="1" narrow />
          </label>
          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-2 text-sm"
              ><Checkbox v-model="criterion.gate" binary />{{ t('specWizard.bench.stopBelow') }}</label
            >
            <ScaleSlider
              v-model="criterion.gateBelow"
              :dots="scoreDots"
              :selected="episode"
              :disabled="!criterion.gate"
              :label="t('specWizard.bench.stopLine')"
              @pick="emit('pick', $event)"
            >
              <template #default="{ cut }">
                <span v-if="criterion.gate" class="text-xs text-surface-500 dark:text-surface-400">{{
                  t('specWizard.bench.cut', { n: cut, of: scoreDots.length })
                }}</span>
              </template>
            </ScaleSlider>
            <p class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.stopVsTag') }}</p>
          </div>
          <div class="flex flex-col gap-2">
            <span class="gym-field mb-0!">{{ t('specWizard.bench.itsTag') }}</span>
            <FlagSwitch v-for="f in flagsHere" :key="f" v-model="form" :report="report" :flag="f" />
          </div>
          <FormField :label="t('spec.rubric')">
            <Textarea
              v-model="criterion.rubric"
              rows="2"
              fluid
              auto-resize
              class="text-xs!"
              :placeholder="t('spec.rubricPlaceholder')"
            />
          </FormField>
          <SecondaryButton size="small" :label="t('specWizard.bench.removeCriterion')" @click="removeCriterion">
            <template #icon><IconTrash class="size-4" /></template>
          </SecondaryButton>
        </div>
        <div v-else-if="selection.kind === 'criterion'" class="gym-note border-s-warn text-sm">
          {{ t('specWizard.bench.criterionGone') }}
        </div>

        <!-- the model's overall word -->
        <div v-else-if="selection.kind === 'model'" class="flex flex-col gap-4">
          <div>
            <h3 class="font-semibold">{{ t('specWizard.bench.modelOverall') }}</h3>
            <p class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.modelHint') }}</p>
          </div>
          <label class="flex items-center gap-2 text-sm"
            ><Checkbox v-model="form.soft.enabled" binary />{{ t('spec.softEnabled') }}</label
          >
          <FlagSwitch v-for="f in flagsHere" :key="f" v-model="form" :report="report" :flag="f" />
        </div>
      </template>

      <!-- thresholds and weights of the whole spec -->
      <div v-else-if="tab === 'scoring'" class="flex flex-col gap-5">
        <div class="flex flex-wrap gap-1.5">
          <Pill tone="ok">{{ t('verdict.accept') }} · {{ counts.accept }}</Pill>
          <Pill tone="warn">{{ t('verdict.review') }} · {{ counts.review }}</Pill>
          <Pill tone="bad">{{ t('verdict.reject') }} · {{ counts.reject }}</Pill>
        </div>
        <ScaleSlider
          v-model="form.scoring.acceptThreshold"
          :dots="totals"
          :selected="episode"
          below="warn"
          :label="t('spec.acceptThreshold')"
          @pick="emit('pick', $event)"
        />
        <ScaleSlider
          v-model="form.scoring.reviewThreshold"
          :dots="totals"
          :selected="episode"
          :label="t('spec.reviewThreshold')"
          @pick="emit('pick', $event)"
        />
        <p class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.totalsHint') }}</p>
        <label class="flex items-center justify-between gap-2 text-sm">
          {{ t('spec.hardWeight') }}
          <NumField v-model="form.scoring.hardWeight" :min="0" :step="0.5" :fallback="1" narrow />
        </label>
        <label class="flex items-center justify-between gap-2 text-sm">
          {{ t('spec.softWeight') }}
          <NumField v-model="form.scoring.softWeight" :min="0" :step="0.5" :fallback="1" narrow />
        </label>
      </div>

      <!-- the success criteria -->
      <SpecForm v-else-if="tab === 'criteria'" v-model="form" :critics="critics" :sections="['soft']" :soft-sample="softSample" />

      <!-- every flag -->
      <FlagPanel v-else-if="tab === 'flags'" v-model="form" :report="report" compact />
    </div>
  </div>
</template>
