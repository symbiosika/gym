<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtAxis, metricRows, type MetricRow } from '@/utils/selectionOverview'
import type { SelectionMetrics, SelectionPoint } from '@/types/gym'
import PositionCharts from '@/components/skill/PositionCharts.vue'

/**
 * The position figures over the selected episodes of the datasets in the
 * selection: where the robot picked, and where its wrists were at the start
 * and at the end, each with its spread and its base. Plain arithmetic over
 * what the data critics measured per episode; nothing here is judged, so
 * nothing is coloured.
 */
const props = defineProps<{
  metrics: SelectionMetrics
  /** the positions the figures are taken over, for the charts */
  points: SelectionPoint[]
  /** dataset names by id */
  names: Record<string, string>
}>()
const { t, te } = useI18n()

const rows = computed(() => metricRows(props.metrics))
/** "left" and "right" in the reader's language, any other arm name as the data has it */
const armName = (arm: string) => (te(`skill.episodesTab.arm.${arm}`) ? t(`skill.episodesTab.arm.${arm}`) : arm)
const label = (r: MetricRow) =>
  r.kind === 'delta'
    ? t('skill.episodesTab.metrics.delta')
    : r.kind === 'arm'
      ? armName(r.arm!)
      : t('skill.episodesTab.metrics.all')
/** the group is named on its first line only */
const firstOfGroup = (i: number) => i === 0 || rows.value[i - 1]!.group !== rows.value[i]!.group
</script>

<template>
  <section>
    <SectionHeader
      :title="t('skill.episodesTab.metrics.title')"
      :hint="
        t('skill.episodesTab.metrics.base', { datasets: metrics.datasets, episodes: metrics.episodes }) +
        (metrics.withoutPositions ? ' · ' + t('skill.episodesTab.metrics.without', { n: metrics.withoutPositions }) : '')
      "
      info="selectionMetrics"
    />
    <div v-if="!rows.length" class="gym-empty">
      {{ metrics.episodes ? t('skill.episodesTab.metrics.noneMeasured') : t('skill.episodesTab.metrics.noneSelected') }}
    </div>
    <template v-else>
      <PositionCharts class="mb-4" :metrics="metrics" :points="points" :names="names" />
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th></th>
              <th></th>
              <th class="num">{{ t('skill.episodesTab.metrics.mean') }}</th>
              <th class="num">{{ t('skill.episodesTab.metrics.std') }}</th>
              <th class="num">n</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="`${r.group}-${r.kind}-${r.arm ?? ''}`">
              <td class="font-medium whitespace-nowrap">
                {{ firstOfGroup(i) ? t(`skill.episodesTab.metrics.group.${r.group}`) : '' }}
              </td>
              <td class="whitespace-nowrap text-surface-600 dark:text-surface-300">{{ label(r) }}</td>
              <td class="num font-mono text-xs whitespace-nowrap">{{ fmtAxis(r.stat.meanCm) }}</td>
              <td class="num font-mono text-xs whitespace-nowrap">{{ fmtAxis(r.stat.stdCm) }}</td>
              <td class="num">{{ r.stat.n }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="metrics.withoutPositions" class="mt-1.5 text-xs text-surface-500 dark:text-surface-400">
        {{ t('skill.episodesTab.metrics.withoutHint') }}
      </p>
    </template>
  </section>
</template>
