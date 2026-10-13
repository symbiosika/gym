<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { NONE } from '@/utils/select'
import type { DatasetSummary, EpisodeVerdict, FailureCode, HumanVerdict, RolloutRow, RolloutsView } from '@/types/gym'
import { fmtPercent, fmtSecs } from '@/utils/time'
import FindingsOverrides from '@/components/FindingsOverrides.vue'

/**
 * The human review of an evaluation block's rollouts.
 *
 * First the findings of the block's critics runs: what each flag does per
 * spec and the person's weighting (as in the spec, review only, hint only),
 * because a gate such as TRACKERR that rejects every rollout has to be
 * weighed before anyone looks at single rollouts. Then one row per rollout
 * with the critics' verdict, what the model said, the person's decision
 * (success, no success, or leave it to the critics), the failure mode, the
 * plan variation and a note. Rows can be ticked, also by flag ("every rollout
 * with TRACKERR"), and the actions above the table work on the ticked ones.
 * Every change is saved at once; the parent is told to reload the block.
 */
const props = defineProps<{
  blockId: string
  tenantId: string
  /** the block's datasets: their findings are weighed here */
  datasets?: DatasetSummary[]
  readonly?: boolean
}>()
const emit = defineEmits<{ changed: []; error: [message: string] }>()
const { t } = useI18n()

const view = ref<RolloutsView | null>(null)
const busy = ref(false)
const savedAt = ref(0)
const fail = (e: unknown) => emit('error', e instanceof Error ? e.message : String(e))

async function load() {
  try {
    view.value = await gymApi.rollouts(props.tenantId, props.blockId)
  } catch (e) {
    fail(e)
  }
}
onMounted(load)
watch(() => props.blockId, load)
// a dataset removed from the block takes its rollouts with it
watch(
  () => (props.datasets ?? []).map((d) => d.id).join(','),
  (now, before) => {
    if (now !== before) load()
  },
)
defineExpose({ load })

const rollouts = computed(() => view.value?.rollouts ?? [])
const totals = computed(() => view.value?.totals ?? null)
const analysed = computed(() => (props.datasets ?? []).filter((d) => d.analysis))
/** the dataset is only worth a word when the block has more than one */
const manyDatasets = computed(() => new Set(rollouts.value.map((r) => r.datasetId)).size > 1)
const isFirstOfDataset = (i: number) => i === 0 || rollouts.value[i - 1]!.datasetId !== rollouts.value[i]!.datasetId

const variationOptions = computed(() => [
  { label: t('rollouts.variationAuto'), value: NONE },
  ...(view.value?.variations ?? []).map((v) => ({ label: v.label, value: v.label })),
])
const codeOptions = computed(() => [
  { label: t('rollouts.noCode'), value: NONE },
  ...(view.value?.failureCodes ?? []).map((f) => ({ label: `${f.code} · ${t(`failure.${f.code}`)}`, value: f.code })),
])
const verdictTone = (v: EpisodeVerdict) => (v === 'accept' ? 'ok' : v === 'reject' ? 'bad' : v === 'review' ? 'warn' : 'neutral')
const rateTone = (r: number | null) => (r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad')
const ciRange = (ci: { low: number; high: number }) => t('rollouts.ciRange', { low: ci.low.toFixed(0), high: ci.high.toFixed(0) })

// ---------------------------------------------------------------- selection
const picked = ref<Record<string, boolean>>({})
const pickedRows = computed(() => rollouts.value.filter((r) => picked.value[r.episodeId]))
const allPicked = computed(() => rollouts.value.length > 0 && pickedRows.value.length === rollouts.value.length)
const pickAll = (on: boolean) => {
  for (const r of rollouts.value) picked.value[r.episodeId] = on
}
const clearPick = () => (picked.value = {})
/** the flags raised on the block's rollouts, most frequent first: a click ticks every rollout carrying the flag */
const flagsOf = (r: RolloutRow) => [...new Set([...r.flags, ...(r.vlm?.flags ?? [])])]
const flagCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const r of rollouts.value) for (const f of flagsOf(r)) counts.set(f, (counts.get(f) ?? 0) + 1)
  return [...counts.entries()]
    .map(([flag, count]) => ({ flag, count }))
    .sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag))
})
const flagPicked = (flag: string) => {
  const rows = rollouts.value.filter((r) => flagsOf(r).includes(flag))
  return rows.length > 0 && rows.every((r) => picked.value[r.episodeId])
}
const pickFlag = (flag: string) => {
  const on = !flagPicked(flag)
  for (const r of rollouts.value) if (flagsOf(r).includes(flag)) picked.value[r.episodeId] = on
}
/** the rows an action works on: the ticked ones, else all */
const targets = computed(() => (pickedRows.value.length ? pickedRows.value : rollouts.value))
const scope = computed(() =>
  pickedRows.value.length ? t('rollouts.picked', { n: pickedRows.value.length }) : t('rollouts.allRows'),
)

// ---------------------------------------------------------------- saving
type Change = {
  episodeId: string
  humanVerdict?: HumanVerdict | null
  failureCode?: string | null
  note?: string
  variationLabel?: string | null
}
async function save(changes: Change[]) {
  if (!changes.length || props.readonly) return
  busy.value = true
  try {
    view.value = await gymApi.reviewRollouts(props.tenantId, props.blockId, changes)
    savedAt.value = Date.now()
    emit('changed')
  } catch (e) {
    fail(e)
    await load()
  } finally {
    busy.value = false
  }
}
const setVerdict = (r: RolloutRow, v: HumanVerdict | null) => save([{ episodeId: r.episodeId, humanVerdict: v }])
const setCode = (r: RolloutRow, code: string) =>
  save([{ episodeId: r.episodeId, failureCode: code === NONE ? null : (code as FailureCode) }])
const setVariation = (r: RolloutRow, label: string) =>
  save([{ episodeId: r.episodeId, variationLabel: label === NONE ? null : label }])
const setNote = (r: RolloutRow, note: string) => {
  if (note.trim() === r.note) return
  return save([{ episodeId: r.episodeId, note }])
}
const bulkVerdict = (v: HumanVerdict | null) => save(targets.value.map((r) => ({ episodeId: r.episodeId, humanVerdict: v })))
const bulkCode = (code: string) =>
  save(targets.value.map((r) => ({ episodeId: r.episodeId, failureCode: code === NONE ? null : (code as FailureCode) })))
/** the rollouts whose failure mode is still open although the findings suggest one */
const suggestible = (rows: RolloutRow[]) => rows.filter((r) => !r.failureCode && r.suggestedFailureCode)
const suggestions = computed(() => suggestible(targets.value))
/** take the suggested failure mode over, for one rollout or for every target still without one */
const applySuggestion = (r: RolloutRow) =>
  r.suggestedFailureCode ? save([{ episodeId: r.episodeId, failureCode: r.suggestedFailureCode }]) : undefined
const applySuggestions = () =>
  save(suggestions.value.map((r) => ({ episodeId: r.episodeId, failureCode: r.suggestedFailureCode })))
const bulkVariation = (label: string) =>
  save(targets.value.map((r) => ({ episodeId: r.episodeId, variationLabel: label === NONE ? null : label })))

/** the findings of a dataset were reweighed: the critics replayed, the rows have to be read again */
async function onFindingsChanged() {
  await load()
  emit('changed')
}

// ---------------------------------------------------------------- the model's word
const open = ref<Record<string, boolean>>({})
const allOpen = computed(() => rollouts.value.length > 0 && rollouts.value.every((r) => open.value[r.episodeId]))
const toggleAll = () => {
  const on = !allOpen.value
  for (const r of rollouts.value) open.value[r.episodeId] = on
}
const vlmTone = (r: RolloutRow) =>
  !r.vlm || r.vlm.error ? 'bad' : r.vlm.taskSuccess === true ? 'ok' : r.vlm.taskSuccess === false ? 'bad' : 'warn'
const vlmLabel = (r: RolloutRow) =>
  !r.vlm
    ? t('rollouts.vlmOff')
    : r.vlm.error
      ? t('rollouts.vlmNoAnswer')
      : r.vlm.taskSuccess === true
        ? t('rollouts.vlmSuccess')
        : r.vlm.taskSuccess === false
          ? t('rollouts.vlmFailed')
          : t('rollouts.vlmUndecided')
const scoreTone = (s: number | null) => (s == null ? 'neutral' : s >= 0.8 ? 'ok' : s >= 0.5 ? 'warn' : 'bad')
const pctOf = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)} %`)

const segment = (active: boolean, tone: 'ok' | 'bad' | 'neutral') =>
  [
    'cursor-pointer rounded-md px-2 py-1 text-xs font-semibold transition-colors disabled:cursor-default',
    active
      ? tone === 'ok'
        ? 'bg-ok text-white'
        : tone === 'bad'
          ? 'bg-bad text-white'
          : 'bg-surface-700 text-white dark:bg-surface-200 dark:text-surface-900'
      : 'text-surface-600 hover:bg-surface-200 dark:text-surface-300 dark:hover:bg-surface-700',
  ].join(' ')
</script>

<template>
  <div>
    <div v-if="!view" class="py-6 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <div v-else-if="!rollouts.length" class="gym-empty">{{ t('rollouts.empty') }}</div>
    <template v-else>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          :label="t('skill.successRate')"
          :value="fmtPercent(totals!.ratePercent)"
          :sub="`${totals!.succeeded} / ${totals!.rollouts}${totals!.ci ? ` · ${t('rollouts.ci')} ${ciRange(totals!.ci)}` : ''}`"
          :bar="totals!.ratePercent"
          :tone="rateTone(totals!.ratePercent)"
        />
        <KpiTile
          :label="t('rollouts.attributable')"
          :value="fmtPercent(totals!.attributableRatePercent)"
          :sub="totals!.invalid ? t('rollouts.invalid', { n: totals!.invalid }) : t('rollouts.attributableHint')"
        />
        <KpiTile
          :label="t('rollouts.human')"
          :value="`${totals!.reviewed} / ${totals!.rollouts}`"
          :sub="t('rollouts.reviewed', { n: totals!.reviewed, total: totals!.rollouts })"
        />
        <KpiTile
          :label="t('report.pending')"
          :value="String(totals!.pendingReview)"
          :sub="totals!.pendingReview ? t('rollouts.pendingHint') : t('report.pendingHint')"
          :tone="totals!.pendingReview ? 'warn' : 'neutral'"
        />
      </div>

      <!-- 1 · the findings: what rejects, what a person makes of it -->
      <div v-if="!readonly && analysed.length" class="mt-4 flex flex-col gap-3">
        <FindingsOverrides
          v-for="d in analysed"
          :key="d.id"
          :analysis="d.analysis!"
          :tenant-id="tenantId"
          :dataset-id="d.id"
          :title="manyDatasets ? d.name : undefined"
          @changed="onFindingsChanged"
          @error="fail"
        />
      </div>

      <div v-if="view.byVariation.length" class="mt-4 flex flex-wrap items-center gap-1.5">
        <span class="gym-field mb-0 me-1">{{ t('rollouts.byVariation') }}</span>
        <Pill v-for="v in view.byVariation" :key="v.label" :tone="rateTone(v.ratePercent)">
          {{ v.label }} · {{ v.succeeded }}/{{ v.rollouts }}
        </Pill>
      </div>

      <!-- 2 · pick rollouts, also by flag -->
      <div v-if="!readonly && flagCounts.length" class="mt-4 flex flex-wrap items-center gap-1.5">
        <span class="gym-field mb-0 me-1">{{ t('rollouts.pickByFlag') }}</span>
        <button
          v-for="f in flagCounts"
          :key="f.flag"
          type="button"
          class="cursor-pointer rounded-md border px-1.5 py-0.5 font-mono text-xs font-semibold transition-colors"
          :class="
            flagPicked(f.flag)
              ? 'border-primary bg-primary text-white'
              : 'border-surface-300 text-surface-600 hover:border-primary hover:text-primary dark:border-surface-700 dark:text-surface-300'
          "
          :title="t('rollouts.pickByFlagHint', { flag: f.flag, n: f.count })"
          @click="pickFlag(f.flag)"
        >
          {{ f.count }} × {{ f.flag }}
        </button>
      </div>

      <!-- 3 · the actions on the ticked rollouts (or on all) -->
      <div
        v-if="!readonly"
        class="mt-3 flex flex-wrap items-center gap-2 rounded-panel border px-3 py-2"
        :class="pickedRows.length ? 'border-primary bg-primary/5' : 'border-surface-300 dark:border-surface-800'"
      >
        <b class="text-sm whitespace-nowrap">{{ scope }}</b>
        <SecondaryButton size="small" :disabled="busy" :label="t('rollouts.success')" @click="bulkVerdict('accept')" />
        <SecondaryButton size="small" :disabled="busy" :label="t('rollouts.failure')" @click="bulkVerdict('reject')" />
        <SecondaryButton size="small" :disabled="busy" :label="t('rollouts.asCritics')" @click="bulkVerdict(null)" />
        <Select
          size="small"
          class="w-56"
          :model-value="NONE"
          :options="codeOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('rollouts.failureCode')"
          :disabled="busy"
          @update:model-value="bulkCode($event as string)"
        >
          <template #value
            ><span class="text-surface-600 dark:text-surface-300">{{ t('rollouts.setCode') }}</span></template
          >
        </Select>
        <Select
          v-if="view.variations.length"
          size="small"
          class="w-48"
          :model-value="NONE"
          :options="variationOptions"
          option-label="label"
          option-value="value"
          :disabled="busy"
          @update:model-value="bulkVariation($event as string)"
        >
          <template #value
            ><span class="text-surface-600 dark:text-surface-300">{{ t('rollouts.setVariation') }}</span></template
          >
        </Select>
        <SecondaryButton
          v-if="suggestions.length"
          size="small"
          :disabled="busy"
          :label="t('rollouts.applySuggestions', { n: suggestions.length })"
          :title="t('rollouts.applySuggestionsHint')"
          @click="applySuggestions"
        />
        <SecondaryButton
          v-if="pickedRows.length"
          size="small"
          variant="text"
          :label="t('rollouts.clearPick')"
          @click="clearPick"
        />
        <SecondaryButton
          v-if="rollouts.some((r) => r.vlm)"
          size="small"
          variant="text"
          :label="allOpen ? t('rollouts.collapseAll') : t('rollouts.expandAll')"
          @click="toggleAll"
        />
        <span class="ms-auto font-mono text-xs text-surface-500 dark:text-surface-400">
          <template v-if="busy">{{ t('rollouts.saving') }}</template>
          <template v-else-if="savedAt">{{ t('rollouts.saved') }}</template>
        </span>
      </div>

      <!-- 4 · every rollout -->
      <div class="gym-panel mt-3 overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th v-if="!readonly" class="w-8">
                <Checkbox
                  binary
                  :model-value="allPicked"
                  :title="t('rollouts.pickAll')"
                  @update:model-value="pickAll($event as boolean)"
                />
              </th>
              <th class="num">{{ t('rollouts.position') }}</th>
              <th>{{ t('rollouts.variation') }}</th>
              <th class="num">{{ t('selection.duration') }}</th>
              <th>{{ t('rollouts.vlm') }}</th>
              <th>{{ t('rollouts.critics') }}</th>
              <th>{{ t('rollouts.human') }}</th>
              <th>{{ t('rollouts.failureCode') }}</th>
              <th>{{ t('rollouts.note') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(r, i) in rollouts" :key="r.episodeId">
              <!-- the dataset only as a group line, and only when the block has more than one -->
              <tr v-if="manyDatasets && isFirstOfDataset(i)" class="bg-surface-100/70 dark:bg-surface-800/40">
                <td :colspan="readonly ? 8 : 9" class="font-mono text-xs">{{ r.datasetName }}</td>
              </tr>
              <tr :class="[r.pendingReview ? 'bg-warn-soft' : '', picked[r.episodeId] ? 'bg-primary/5' : '']">
                <td v-if="!readonly">
                  <Checkbox v-model="picked[r.episodeId]" binary />
                </td>
                <td class="num font-mono text-xs whitespace-nowrap">
                  {{ r.position }}<span v-if="r.index !== r.position - 1" class="text-surface-400"> · #{{ r.index }}</span>
                </td>
                <td class="min-w-40">
                  <Select
                    v-if="!readonly && view.variations.length"
                    size="small"
                    fluid
                    :model-value="r.variationSet ? r.variation : NONE"
                    :options="variationOptions"
                    option-label="label"
                    option-value="value"
                    :disabled="busy"
                    @update:model-value="setVariation(r, $event as string)"
                  >
                    <template #value="{ value }">
                      <span v-if="value === NONE" class="text-surface-600 dark:text-surface-300">
                        {{ r.variation ?? t('rollouts.variationNone') }}
                        <span class="text-xs text-surface-500">· {{ t('rollouts.variationAuto') }}</span>
                      </span>
                      <span v-else>{{ value }}</span>
                    </template>
                  </Select>
                  <span v-else class="text-sm">{{ r.variation ?? '–' }}</span>
                </td>
                <td class="num whitespace-nowrap">{{ fmtSecs(r.durationSeconds) }}</td>
                <td class="min-w-44">
                  <Pill :tone="vlmTone(r)">{{ vlmLabel(r) }}</Pill>
                  <div v-if="r.vlm && !r.vlm.error" class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
                    <template v-if="r.vlm.confidence != null"
                      >{{ t('rollouts.vlmConfidence', { p: Math.round(r.vlm.confidence * 100) }) }} ·
                    </template>
                    <button
                      type="button"
                      class="text-primary cursor-pointer hover:underline"
                      @click="open[r.episodeId] = !open[r.episodeId]"
                    >
                      {{ open[r.episodeId] ? t('rollouts.hideDetails') : t('rollouts.details') }}
                    </button>
                  </div>
                </td>
                <td>
                  <Pill :tone="verdictTone(r.criticsVerdict)">{{ t(`verdict.${r.criticsVerdict}`) }}</Pill>
                  <div v-if="r.criticsReason" class="mt-0.5 max-w-56 text-xs text-surface-500 dark:text-surface-400">
                    {{ r.criticsReason }}
                  </div>
                  <div v-else-if="r.flags.length" class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
                    {{ r.flags.join(', ') }}
                  </div>
                </td>
                <td>
                  <div
                    v-if="!readonly"
                    class="inline-flex gap-0.5 rounded-lg bg-surface-100 p-0.5 dark:bg-surface-800"
                    role="group"
                  >
                    <button
                      type="button"
                      :class="segment(r.humanVerdict == null, 'neutral')"
                      :disabled="busy"
                      @click="setVerdict(r, null)"
                    >
                      {{ t('rollouts.asCritics') }}
                    </button>
                    <button
                      type="button"
                      :class="segment(r.humanVerdict === 'accept', 'ok')"
                      :disabled="busy"
                      @click="setVerdict(r, 'accept')"
                    >
                      {{ t('rollouts.success') }}
                    </button>
                    <button
                      type="button"
                      :class="segment(r.humanVerdict === 'reject', 'bad')"
                      :disabled="busy"
                      @click="setVerdict(r, 'reject')"
                    >
                      {{ t('rollouts.failure') }}
                    </button>
                  </div>
                  <Pill v-else :tone="r.humanVerdict ? verdictTone(r.humanVerdict) : 'neutral'">
                    {{ r.humanVerdict ? t(`verdict.${r.humanVerdict}`) : t('rollouts.asCritics') }}
                  </Pill>
                  <div v-if="r.reviewedByName" class="mt-0.5 text-xs text-surface-500 dark:text-surface-400">
                    {{ t('rollouts.reviewedBy', { name: r.reviewedByName }) }}
                  </div>
                </td>
                <td class="min-w-48">
                  <Select
                    v-if="!readonly"
                    size="small"
                    fluid
                    :model-value="r.failureCode ?? NONE"
                    :options="codeOptions"
                    option-label="label"
                    option-value="value"
                    :disabled="busy"
                    @update:model-value="setCode(r, $event as string)"
                  />
                  <span v-else-if="r.failureCode" class="text-sm">{{ r.failureCode }} · {{ t(`failure.${r.failureCode}`) }}</span>
                  <span v-else>–</span>
                  <!-- what the findings point at, until a person has set the failure mode -->
                  <div
                    v-if="!readonly && !r.failureCode && r.suggestedFailureCode"
                    class="mt-0.5 text-xs text-surface-500 dark:text-surface-400"
                  >
                    {{
                      t('rollouts.suggestedCode', { code: r.suggestedFailureCode, name: t(`failure.${r.suggestedFailureCode}`) })
                    }}
                    <button
                      type="button"
                      class="text-primary cursor-pointer hover:underline"
                      :disabled="busy"
                      @click="applySuggestion(r)"
                    >
                      {{ t('rollouts.applySuggestion') }}
                    </button>
                  </div>
                </td>
                <td class="min-w-48">
                  <InputText
                    v-if="!readonly"
                    size="small"
                    fluid
                    :model-value="r.note"
                    :placeholder="t('rollouts.notePlaceholder')"
                    :disabled="busy"
                    @blur="setNote(r, ($event.target as HTMLInputElement).value)"
                    @keyup.enter="setNote(r, ($event.target as HTMLInputElement).value)"
                  />
                  <span v-else class="text-sm text-surface-600 dark:text-surface-300">{{ r.note || '–' }}</span>
                </td>
              </tr>
              <!-- the model's reasoning: summary, one line per indicator with score and evidence, anomalies with time stamps -->
              <tr v-if="open[r.episodeId] && r.vlm && !r.vlm.error" class="bg-surface-50 dark:bg-surface-800/30">
                <td :colspan="readonly ? 1 : 2"></td>
                <td colspan="7" class="py-3">
                  <div class="grid gap-4 md:grid-cols-2">
                    <div>
                      <div class="gym-field">
                        {{ t('rollouts.vlmSummary') }}<template v-if="r.vlm.model"> · {{ r.vlm.model }}</template>
                      </div>
                      <p class="mt-1 text-sm">{{ r.vlm.summary || '–' }}</p>
                      <div v-if="r.vlm.anomalies.length" class="mt-3">
                        <div class="gym-field">{{ t('rollouts.vlmAnomalies') }}</div>
                        <ul class="mt-1 flex list-none flex-col gap-1 p-0 text-sm">
                          <li v-for="(a, j) in r.vlm.anomalies" :key="j" class="flex flex-wrap items-baseline gap-1.5">
                            <Pill :tone="a.severity === 'major' ? 'bad' : a.severity === 'info' ? 'neutral' : 'warn'">{{
                              a.type
                            }}</Pill>
                            <span v-if="a.timeSeconds != null" class="font-mono text-xs text-surface-500"
                              >t={{ a.timeSeconds }} s</span
                            >
                            <span>{{ a.description }}</span>
                          </li>
                        </ul>
                      </div>
                    </div>
                    <div>
                      <div class="gym-field">{{ t('rollouts.vlmIndicators') }}</div>
                      <ul class="mt-1 flex list-none flex-col gap-1.5 p-0 text-sm">
                        <li v-for="ind in r.vlm.indicators" :key="ind.id" class="flex flex-wrap items-baseline gap-1.5">
                          <Pill :tone="scoreTone(ind.score)">{{ pctOf(ind.score) }}</Pill>
                          <b>{{ ind.label }}</b>
                          <span class="text-surface-600 dark:text-surface-300">{{ ind.evidence || '–' }}</span>
                          <span v-if="ind.confidence != null" class="font-mono text-xs text-surface-500">
                            {{ t('rollouts.vlmConfidence', { p: Math.round(ind.confidence * 100) }) }}
                          </span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
