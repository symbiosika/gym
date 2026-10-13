<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EpisodeVerdict, EvaluationFigures, EvaluationReportSections, RateFigure } from '@/types/gym'
import { fmtDate, fmtPercent, fmtSecs } from '@/utils/time'
import SectionHeader from '@/components/SectionHeader.vue'

/**
 * The body of an evaluation report, read-only: the figures at a glance,
 * scene and task, success by block (with the Wilson interval), by variation,
 * the block × variation matrix, the failure modes, the conclusion, every
 * rollout and the data lineage. Used by the signed-in view and the shared,
 * printable one; the signed-in view links the blocks, the shared one does not.
 */
const props = defineProps<{
  figures: EvaluationFigures
  sections: EvaluationReportSections
  /** when given, block names link into the wizard */
  tenantId?: string
}>()
const { t, locale } = useI18n()

const f = computed(() => props.figures)
const rateTone = (r: number | null) => (r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad')
const barClass = { neutral: 'bg-surface-400', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' } as const
const verdictTone = (v: EpisodeVerdict) => (v === 'accept' ? 'ok' : v === 'reject' ? 'bad' : v === 'review' ? 'warn' : 'neutral')
const cellText = (x: RateFigure | undefined) => (x ? `${x.succeeded}/${x.rollouts}` : '·')
const cellTone = (x: RateFigure | undefined) => (x ? rateTone(x.ratePercent) : 'neutral')
const pct = (x: number | null) => (x == null ? 0 : Math.min(100, Math.max(0, x)))
const ciRange = (ci: { low: number; high: number }) => t('rollouts.ciRange', { low: ci.low.toFixed(0), high: ci.high.toFixed(0) })

/** the failure modes as columns of the per-block table, most frequent first */
const failureCodes = computed(() => f.value.failureModes.map((m) => m.code))
const vlmFailed = computed(() => f.value.blocks.reduce((a, b) => a + b.vlmFailedDatasets, 0))
const hasScene = computed(() =>
  (['prompt', 'successCriteria', 'design', 'reset', 'caveats'] as const).some((k) => props.sections[k]),
)
const hasConclusion = computed(() => (['working', 'needsReview', 'nextSteps'] as const).some((k) => props.sections[k]))
const datasetsOf = (blockId: string) => [
  ...new Set(f.value.rollouts.filter((r) => r.blockId === blockId).map((r) => r.datasetName)),
]
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- the read-out -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        :label="t('report.overall')"
        :value="fmtPercent(f.overall.ratePercent)"
        :sub="`${t('report.ofRollouts', { k: f.overall.succeeded, n: f.overall.rollouts })}${f.overall.ci ? ` · ${ciRange(f.overall.ci)}` : ''}`"
        :bar="f.overall.ratePercent"
        :tone="rateTone(f.overall.ratePercent)"
        hero
      />
      <KpiTile
        :label="t('report.best')"
        :value="f.best ? f.best.label : '–'"
        :sub="f.best ? `${fmtPercent(f.best.ratePercent)} ${t('skill.successRate')}` : t('report.noBest')"
        small
      />
      <KpiTile
        :label="t('report.topFailure')"
        :value="f.topFailure ? f.topFailure.code : '–'"
        :sub="f.topFailure ? `${t(`failure.${f.topFailure.code}`)} · ${f.topFailure.count} ×` : t('report.noFailure')"
        :tone="f.topFailure ? 'bad' : 'neutral'"
      />
      <KpiTile
        :label="t('report.attributable')"
        :value="fmtPercent(f.overall.attributableRatePercent)"
        :sub="f.overall.invalid ? t('rollouts.invalid', { n: f.overall.invalid }) : t('report.attributableHint')"
      />
    </div>

    <div v-if="f.overall.pendingReview" class="gym-note border-s-warn">
      <b class="text-warn">{{ t('rollouts.pending', { n: f.overall.pendingReview }) }}</b>
      <p class="mt-1 text-sm">{{ t('report.pendingLead', { n: f.overall.pendingReview }) }}</p>
    </div>
    <div v-if="vlmFailed" class="gym-note border-s-bad">
      <b class="text-bad">{{ t('review.vlmFailedTitle') }}</b>
      <p class="mt-1 text-sm">{{ t('report.vlmLead', { n: vlmFailed }) }}</p>
    </div>

    <!-- A · scene and task -->
    <section v-if="hasScene">
      <SectionHeader n="A" :title="t('report.sections.scene')" />
      <div class="gym-panel grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
        <div
          v-for="k in ['prompt', 'successCriteria', 'design', 'reset', 'caveats'] as const"
          :key="k"
          :class="k === 'caveats' ? 'sm:col-span-2' : ''"
        >
          <template v-if="sections[k]">
            <div class="gym-field">{{ t(`report.sections.${k}`) }}</div>
            <p class="mt-1 text-sm whitespace-pre-line">{{ sections[k] }}</p>
          </template>
        </div>
      </div>
    </section>

    <!-- B · success by block -->
    <section>
      <SectionHeader n="B" :title="t('report.byBlock')" :hint="t('report.byBlockHint')" />
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('report.block') }}</th>
              <th>{{ t('report.date') }}</th>
              <th>{{ t('report.cell') }}</th>
              <th class="num">{{ t('report.rollouts') }}</th>
              <th class="num">{{ t('report.succeeded') }}</th>
              <th class="num">{{ t('report.rate') }}</th>
              <th class="min-w-48"></th>
              <th class="num">{{ t('report.interval') }}</th>
              <th class="num" :title="t('report.attributableHint')">{{ t('report.attributable') }}</th>
              <th class="num">{{ t('report.pending') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in f.blocks" :key="b.blockId">
              <td class="whitespace-nowrap font-semibold">
                <RouterLink
                  v-if="tenantId"
                  class="text-primary hover:underline"
                  :to="{ name: 'Block', params: { tenantId, blockId: b.blockId } }"
                  >{{ b.label }}</RouterLink
                >
                <template v-else>{{ b.label }}</template>
              </td>
              <td class="font-mono text-xs whitespace-nowrap">{{ fmtDate(b.date, locale) }}</td>
              <td class="whitespace-nowrap">{{ b.cellName }}</td>
              <td class="num">
                {{ b.rollouts }}<span v-if="b.targetEpisodes" class="text-surface-500"> / {{ b.targetEpisodes }}</span>
              </td>
              <td class="num">{{ b.succeeded }}</td>
              <td class="num">
                <Pill :tone="rateTone(b.ratePercent)">{{ fmtPercent(b.ratePercent) }}</Pill>
              </td>
              <td>
                <!-- the bar is the rate, the bracket under it the Wilson 95 % interval -->
                <div class="relative h-4 w-full min-w-40">
                  <div class="absolute inset-x-0 top-0.5 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
                    <i
                      class="block h-full rounded-full"
                      :class="barClass[rateTone(b.ratePercent)]"
                      :style="{ width: `${pct(b.ratePercent)}%` }"
                    ></i>
                  </div>
                  <div
                    v-if="b.ci"
                    class="absolute top-3 h-1 border-x border-b border-surface-500 dark:border-surface-400"
                    :style="{ left: `${b.ci.low}%`, width: `${Math.max(0, b.ci.high - b.ci.low)}%` }"
                    :title="`${t('rollouts.ci')}: ${ciRange(b.ci)}`"
                  ></div>
                </div>
              </td>
              <td class="num font-mono text-xs whitespace-nowrap text-surface-500 dark:text-surface-400">
                <template v-if="b.ci">{{ ciRange(b.ci) }}</template>
                <template v-else>–</template>
              </td>
              <td class="num">
                {{ fmtPercent(b.attributableRatePercent)
                }}<span v-if="b.invalid" class="text-xs text-surface-500"> · {{ b.invalid }} F-08</span>
              </td>
              <td class="num">
                <Pill v-if="b.pendingReview" tone="warn">{{ b.pendingReview }}</Pill>
                <span v-else class="text-surface-500">0</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- C · every rollout: block × variation -->
    <section>
      <SectionHeader n="C" :title="t('report.matrix')" :hint="t('report.matrixHint')" />
      <div v-if="!f.variations.length" class="gym-empty">{{ t('report.noVariations') }}</div>
      <div v-else class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('report.block') }}</th>
              <th v-for="v in f.variations" :key="v.label" class="num">{{ v.label }}</th>
              <th class="num">{{ t('report.rate') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in f.blocks" :key="b.blockId">
              <td class="whitespace-nowrap font-semibold">{{ b.label }}</td>
              <td v-for="v in f.variations" :key="v.label" class="num">
                <Pill :tone="cellTone(b.byVariation[v.label])">{{ cellText(b.byVariation[v.label]) }}</Pill>
              </td>
              <td class="num font-semibold">{{ b.succeeded }}/{{ b.rollouts }}</td>
            </tr>
            <tr class="bg-surface-100/70 font-semibold dark:bg-surface-800/40">
              <td>{{ t('print.totals') }}</td>
              <td v-for="v in f.variations" :key="v.label" class="num">
                <Pill :tone="rateTone(v.ratePercent)">{{ v.succeeded }}/{{ v.rollouts }}</Pill>
              </td>
              <td class="num">{{ f.overall.succeeded }}/{{ f.overall.rollouts }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- D · success by variation -->
    <section v-if="f.variations.length">
      <SectionHeader n="D" :title="t('report.byVariation')" :hint="t('report.byVariationHint')" />
      <div class="gym-panel flex flex-col gap-2 p-4">
        <div v-for="v in f.variations" :key="v.label" class="grid items-center gap-3 sm:grid-cols-[minmax(10rem,1fr)_2fr_auto]">
          <span class="text-sm font-medium">{{ v.label }}</span>
          <div class="h-2.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
            <i
              class="block h-full rounded-full"
              :class="barClass[rateTone(v.ratePercent)]"
              :style="{ width: `${pct(v.ratePercent)}%` }"
            ></i>
          </div>
          <span class="font-mono text-xs tabular-nums whitespace-nowrap">
            <b>{{ fmtPercent(v.ratePercent) }}</b> · {{ v.succeeded }}/{{ v.rollouts }}
            <span v-if="v.ci" class="text-surface-500 dark:text-surface-400">· {{ ciRange(v.ci) }}</span>
          </span>
        </div>
      </div>
    </section>

    <!-- E · failure modes -->
    <section>
      <SectionHeader n="E" :title="t('report.failureModes')" :hint="t('report.failureModesHint')" />
      <div v-if="!f.failureModes.length" class="gym-empty">{{ t('report.noFailureModes') }}</div>
      <div v-else class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('report.block') }}</th>
              <th v-for="code in failureCodes" :key="code" class="num" :title="t(`failure.${code}`)">{{ code }}</th>
              <th class="num">{{ t('report.failures') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in f.blocks" :key="b.blockId">
              <td class="whitespace-nowrap font-semibold">{{ b.label }}</td>
              <td v-for="code in failureCodes" :key="code" class="num">
                <span :class="b.failures[code] ? 'text-bad font-semibold' : 'text-surface-400'">{{ b.failures[code] ?? 0 }}</span>
              </td>
              <td class="num">{{ b.rollouts - b.succeeded }}</td>
            </tr>
            <tr class="bg-surface-100/70 font-semibold dark:bg-surface-800/40">
              <td>{{ t('print.totals') }}</td>
              <td v-for="m in f.failureModes" :key="m.code" class="num">{{ m.count }}</td>
              <td class="num">{{ f.overall.rollouts - f.overall.succeeded }}</td>
            </tr>
          </tbody>
        </table>
        <ul class="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs text-surface-500 dark:text-surface-400">
          <li v-for="m in f.failureModes" :key="m.code">
            <b>{{ m.code }}</b> {{ t(`failure.${m.code}`) }}
          </li>
        </ul>
      </div>
    </section>

    <!-- F · conclusion -->
    <section v-if="hasConclusion">
      <SectionHeader n="F" :title="t('report.sections.conclusion')" />
      <div class="grid gap-3 md:grid-cols-3">
        <div
          v-for="k in ['working', 'needsReview', 'nextSteps'] as const"
          :key="k"
          class="gym-panel border-s-[3px] p-4"
          :class="k === 'working' ? 'border-s-ok' : k === 'needsReview' ? 'border-s-warn' : 'border-s-primary'"
        >
          <div class="gym-field">{{ t(`report.sections.${k}`) }}</div>
          <p class="mt-1 text-sm whitespace-pre-line" :class="sections[k] ? '' : 'text-surface-400 italic'">
            {{ sections[k] || t('report.sectionPlaceholder') }}
          </p>
        </div>
      </div>
    </section>

    <!-- G · every rollout -->
    <section>
      <SectionHeader n="G" :title="t('report.everyRollout')" :hint="t('report.everyRolloutHint')" />
      <div v-if="!f.rollouts.length" class="gym-empty">{{ t('report.noRollouts') }}</div>
      <div v-else class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('report.block') }}</th>
              <th class="num">#</th>
              <th>{{ t('rollouts.variation') }}</th>
              <th class="num">{{ t('selection.duration') }}</th>
              <th>{{ t('report.critics') }}</th>
              <th>{{ t('report.human') }}</th>
              <th>{{ t('report.verdict') }}</th>
              <th>{{ t('rollouts.failureCode') }}</th>
              <th>{{ t('rollouts.note') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in f.rollouts" :key="r.episodeId" :class="r.succeeded ? '' : 'opacity-80'">
              <td class="whitespace-nowrap">{{ f.blocks.find((b) => b.blockId === r.blockId)?.label ?? '' }}</td>
              <td class="num font-mono text-xs">{{ r.position }}</td>
              <td>{{ r.variation ?? '–' }}</td>
              <td class="num whitespace-nowrap">{{ fmtSecs(r.durationSeconds) }}</td>
              <td>
                <Pill :tone="verdictTone(r.criticsVerdict)">{{ t(`verdict.${r.criticsVerdict}`) }}</Pill>
              </td>
              <td>
                <Pill v-if="r.humanVerdict" :tone="verdictTone(r.humanVerdict)">{{ t(`verdict.${r.humanVerdict}`) }}</Pill>
                <span v-else class="text-xs text-surface-400">–</span>
              </td>
              <td>
                <Pill :tone="verdictTone(r.verdict)">{{ r.succeeded ? t('rollouts.success') : t('rollouts.failure') }}</Pill>
              </td>
              <td class="whitespace-nowrap">
                <template v-if="r.failureCode">
                  <b>{{ r.failureCode }}</b>
                  <span class="text-xs text-surface-500 dark:text-surface-400">{{ t(`failure.${r.failureCode}`) }}</span>
                </template>
                <span v-else class="text-surface-400">–</span>
              </td>
              <td class="min-w-40 text-xs text-surface-500 dark:text-surface-400">{{ r.note || r.criticsReason || '–' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- H · data lineage -->
    <section>
      <SectionHeader n="H" :title="t('report.lineage')" :hint="t('report.lineageHint')" />
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('report.block') }}</th>
              <th>{{ t('report.policy') }}</th>
              <th>{{ t('report.date') }}</th>
              <th>{{ t('report.cell') }}</th>
              <th>{{ t('report.dataset') }}</th>
              <th class="num">{{ t('report.rollouts') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in f.blocks" :key="b.blockId">
              <td class="font-semibold whitespace-nowrap">{{ b.label }}</td>
              <td>{{ b.policyName ?? '–' }}</td>
              <td class="font-mono text-xs whitespace-nowrap">{{ fmtDate(b.date, locale) }}</td>
              <td>{{ b.cellName }}</td>
              <td class="font-mono text-xs">{{ datasetsOf(b.blockId).join(', ') || '–' }}</td>
              <td class="num">{{ b.rollouts }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
