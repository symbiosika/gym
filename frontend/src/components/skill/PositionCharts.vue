<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  barSeries,
  niceTicks,
  planeOf,
  scatterDots,
  spreadEllipses,
  squareDomain,
  type Plane,
  type PositionGroup,
  type Series,
} from '@/utils/positionChart'
import type { SelectionMetrics, SelectionPoint } from '@/types/gym'

/**
 * The positions over the selection, drawn: a scatter plot of every measured
 * position on a plane of the robot's coordinates, with the mean (a cross) and
 * one standard deviation (an ellipse) per arm, and beside it the mean per
 * axis as bars with the standard deviation as whiskers.
 *
 * Colour says which arm, never how good: left and right keep their colour in
 * both charts, the delta between them has its own, a mark without a side is
 * neutral. The table under the charts carries the same figures as numbers.
 */
const props = defineProps<{
  metrics: SelectionMetrics
  points: SelectionPoint[]
  /** dataset names by id, for the tooltip of a dot */
  names: Record<string, string>
}>()
const { t, te } = useI18n()

const group = ref<PositionGroup>('pick')
const plane = ref<Plane>('xy')
const groupTabs = computed(() =>
  (['pick', 'start', 'end'] as const).map((value) => ({ value, label: t(`skill.episodesTab.metrics.group.${value}`) })),
)
const planeTabs = computed(() =>
  (['xy', 'xz', 'yz'] as const).map((value) => ({ value, label: t(`skill.episodesTab.charts.plane.${value}`) })),
)

const COLOURS: Record<Series, string> = {
  left: 'var(--gym-series-1)',
  right: 'var(--gym-series-2)',
  delta: 'var(--gym-series-3)',
  other: 'var(--p-surface-500)',
}
const armName = (arm: string | null) =>
  arm == null ? t('skill.episodesTab.metrics.all') : te(`skill.episodesTab.arm.${arm}`) ? t(`skill.episodesTab.arm.${arm}`) : arm
const fmt = (n: number) => n.toFixed(1)

/* ---- scatter ------------------------------------------------------------ */

const S = { size: 340, left: 46, right: 12, top: 12, bottom: 38 }
const plot = { w: S.size - S.left - S.right, h: S.size - S.top - S.bottom }
const dots = computed(() => scatterDots(props.points, group.value, plane.value))
const ellipses = computed(() => spreadEllipses(props.metrics, group.value, plane.value))
const domain = computed(() =>
  squareDomain([
    ...dots.value.map((d) => ({ x: d.x, y: d.y, rx: 0, ry: 0 })),
    ...ellipses.value.map((e) => ({ x: e.cx, y: e.cy, rx: e.rx, ry: e.ry })),
  ]),
)
const sx = (v: number) => S.left + ((v - domain.value.x[0]) / (domain.value.x[1] - domain.value.x[0])) * plot.w
const sy = (v: number) => S.top + plot.h - ((v - domain.value.y[0]) / (domain.value.y[1] - domain.value.y[0])) * plot.h
/** a length in centimetres as pixels: both axes share one scale */
const len = (v: number) => (v / (domain.value.x[1] - domain.value.x[0])) * plot.w
const xTicks = computed(() => niceTicks(domain.value.x[0], domain.value.x[1], 5))
const yTicks = computed(() => niceTicks(domain.value.y[0], domain.value.y[1], 5))
const axes = computed(() => planeOf(plane.value).labels)

/* ---- bars --------------------------------------------------------------- */

const B = { w: 380, h: 340, left: 46, right: 12, top: 12, bottom: 38 }
const bplot = { w: B.w - B.left - B.right, h: B.h - B.top - B.bottom }
const series = computed(() => barSeries(props.metrics, group.value))
const AXES = ['x', 'y', 'z'] as const
const bDomain = computed<[number, number]>(() => {
  const ends = series.value.flatMap((s) => s.stat.meanCm.flatMap((m, k) => [m - s.stat.stdCm[k]!, m + s.stat.stdCm[k]!]))
  const lo = Math.min(0, ...ends)
  const hi = Math.max(0, ...ends)
  const pad = (hi - lo || 1) * 0.08
  return [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0]
})
const by = (v: number) => B.top + bplot.h - ((v - bDomain.value[0]) / (bDomain.value[1] - bDomain.value[0])) * bplot.h
const bTicks = computed(() => niceTicks(bDomain.value[0], bDomain.value[1], 6))
const band = bplot.w / AXES.length
const barWidth = computed(() => Math.min(26, (band - 28) / Math.max(1, series.value.length) - 2))
/** the left edge of a bar: the bars of an axis sit centred in its band, two pixels apart */
const bx = (axis: number, i: number) => {
  const total = series.value.length * (barWidth.value + 2) - 2
  return B.left + axis * band + (band - total) / 2 + i * (barWidth.value + 2)
}
/** a bar from the zero line to its value, rounded at the value's end only */
function barPath(x: number, value: number): string {
  const w = barWidth.value
  const y0 = by(0)
  const y1 = by(value)
  const r = Math.min(4, w / 2, Math.abs(y1 - y0))
  const d = y1 < y0 ? -1 : 1 // up for a positive value
  return `M${x},${y0} L${x},${y1 - d * r} Q${x},${y1} ${x + r},${y1} L${x + w - r},${y1} Q${x + w},${y1} ${x + w},${y1 - d * r} L${x + w},${y0} Z`
}

/* ---- legend and tooltip --------------------------------------------------- */

const legend = computed(() => {
  const seen = new Map<string, { series: Series; label: string }>()
  for (const e of ellipses.value) seen.set(e.arm ?? 'all', { series: e.series, label: armName(e.arm) })
  for (const d of dots.value) if (!seen.has(d.arm ?? 'all')) seen.set(d.arm ?? 'all', { series: d.series, label: armName(d.arm) })
  for (const s of series.value)
    if (s.key === 'delta') seen.set('delta', { series: 'delta', label: t('skill.episodesTab.metrics.delta') })
  return [...seen.values()]
})

const tip = ref<{ x: number; y: number; title: string; lines: string[] } | null>(null)
const root = ref<HTMLElement | null>(null)
function show(event: MouseEvent, title: string, lines: string[]) {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  tip.value = { x: event.clientX - box.left + 12, y: event.clientY - box.top + 12, title, lines }
}
const dotTip = (event: MouseEvent, d: (typeof dots.value)[number]) =>
  show(event, `${props.names[d.datasetId] ?? ''} · ${t('skill.episodesTab.charts.episode', { n: d.episode })}`, [
    armName(d.arm),
    `${axes.value[0]} ${fmt(d.x)} cm · ${axes.value[1]} ${fmt(d.y)} cm`,
  ])
const meanTip = (event: MouseEvent, e: (typeof ellipses.value)[number]) =>
  show(event, `${armName(e.arm)} · ${t('skill.episodesTab.charts.meanStd')}`, [
    `${axes.value[0]} ${fmt(e.cx)} ± ${fmt(e.rx)} cm`,
    `${axes.value[1]} ${fmt(e.cy)} ± ${fmt(e.ry)} cm`,
    `n = ${e.n}`,
  ])
const barTip = (event: MouseEvent, s: (typeof series.value)[number], k: number) =>
  show(event, `${s.key === 'delta' ? t('skill.episodesTab.metrics.delta') : armName(s.arm)} · ${AXES[k]}`, [
    `${fmt(s.stat.meanCm[k]!)} ± ${fmt(s.stat.stdCm[k]!)} cm`,
    `n = ${s.stat.n}`,
  ])
</script>

<template>
  <div ref="root" class="relative" @mouseleave="tip = null">
    <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <TabBar v-model="group" :tabs="groupTabs" />
      <ul class="ms-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-600 dark:text-surface-300">
        <li v-for="l in legend" :key="l.label" class="flex items-center gap-1.5">
          <span class="size-2.5 rounded-full" :style="{ background: COLOURS[l.series] }" aria-hidden="true"></span>{{ l.label }}
        </li>
      </ul>
    </div>

    <div v-if="!dots.length && !series.length" class="gym-empty">{{ t('skill.episodesTab.charts.none') }}</div>
    <div v-else class="grid gap-3 lg:grid-cols-2">
      <figure class="gym-panel p-3">
        <figcaption class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <b class="text-sm font-semibold">{{ t('skill.episodesTab.charts.scatter') }}</b>
          <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('skill.episodesTab.charts.scatterKey') }}</span>
          <TabBar v-model="plane" class="ms-auto" :tabs="planeTabs" />
        </figcaption>
        <svg
          :viewBox="`0 0 ${S.size} ${S.size}`"
          class="mx-auto block w-full max-w-md"
          role="img"
          :aria-label="t('skill.episodesTab.charts.scatter')"
        >
          <!-- grid and axes: recessive -->
          <g class="text-surface-200 dark:text-surface-800" stroke="currentColor" stroke-width="1">
            <line v-for="v in xTicks" :key="`gx${v}`" :x1="sx(v)" :x2="sx(v)" :y1="S.top" :y2="S.top + plot.h" />
            <line v-for="v in yTicks" :key="`gy${v}`" :x1="S.left" :x2="S.left + plot.w" :y1="sy(v)" :y2="sy(v)" />
          </g>
          <g class="fill-surface-500 font-mono dark:fill-surface-400" font-size="10">
            <text v-for="v in xTicks" :key="`tx${v}`" :x="sx(v)" :y="S.top + plot.h + 14" text-anchor="middle">{{ v }}</text>
            <text v-for="v in yTicks" :key="`ty${v}`" :x="S.left - 6" :y="sy(v) + 3" text-anchor="end">{{ v }}</text>
            <text :x="S.left + plot.w / 2" :y="S.size - 6" text-anchor="middle">{{ axes[0] }} (cm)</text>
            <text :transform="`translate(11 ${S.top + plot.h / 2}) rotate(-90)`" text-anchor="middle">{{ axes[1] }} (cm)</text>
          </g>

          <!-- one standard deviation around the mean, under the dots -->
          <ellipse
            v-for="e in ellipses"
            :key="`e${e.arm}`"
            :cx="sx(e.cx)"
            :cy="sy(e.cy)"
            :rx="Math.max(len(e.rx), 1)"
            :ry="Math.max(len(e.ry), 1)"
            :fill="COLOURS[e.series]"
            fill-opacity="0.12"
            :stroke="COLOURS[e.series]"
            stroke-width="1.5"
            stroke-dasharray="4 3"
          />
          <circle
            v-for="(d, i) in dots"
            :key="i"
            :cx="sx(d.x)"
            :cy="sy(d.y)"
            r="3.5"
            :fill="COLOURS[d.series]"
            fill-opacity="0.8"
            class="stroke-surface-0 dark:stroke-surface-900"
            stroke-width="1"
            @mousemove="dotTip($event, d)"
            @mouseleave="tip = null"
          />
          <!-- the mean: a cross in ink with a surface halo, so it reads on top of its own dots -->
          <g v-for="e in ellipses" :key="`m${e.arm}`" @mousemove="meanTip($event, e)" @mouseleave="tip = null">
            <circle :cx="sx(e.cx)" :cy="sy(e.cy)" r="9" fill="transparent" />
            <path
              :d="`M${sx(e.cx) - 6},${sy(e.cy)} h12 M${sx(e.cx)},${sy(e.cy) - 6} v12`"
              class="stroke-surface-0 dark:stroke-surface-900"
              stroke-width="5"
              stroke-linecap="round"
            />
            <path
              :d="`M${sx(e.cx) - 6},${sy(e.cy)} h12 M${sx(e.cx)},${sy(e.cy) - 6} v12`"
              :stroke="COLOURS[e.series]"
              stroke-width="2.5"
              stroke-linecap="round"
            />
          </g>
        </svg>
      </figure>

      <figure class="gym-panel p-3">
        <figcaption class="mb-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5">
          <b class="text-sm font-semibold">{{ t('skill.episodesTab.charts.bars') }}</b>
          <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('skill.episodesTab.charts.barsKey') }}</span>
        </figcaption>
        <svg
          :viewBox="`0 0 ${B.w} ${B.h}`"
          class="mx-auto block w-full max-w-lg"
          role="img"
          :aria-label="t('skill.episodesTab.charts.bars')"
        >
          <g class="text-surface-200 dark:text-surface-800" stroke="currentColor" stroke-width="1">
            <line v-for="v in bTicks" :key="`g${v}`" :x1="B.left" :x2="B.left + bplot.w" :y1="by(v)" :y2="by(v)" />
          </g>
          <g class="fill-surface-500 font-mono dark:fill-surface-400" font-size="10">
            <text v-for="v in bTicks" :key="`t${v}`" :x="B.left - 6" :y="by(v) + 3" text-anchor="end">{{ v }}</text>
            <text
              v-for="(a, k) in AXES"
              :key="a"
              :x="B.left + k * band + band / 2"
              :y="B.top + bplot.h + 16"
              text-anchor="middle"
              font-size="12"
            >
              {{ a }}
            </text>
            <text :transform="`translate(11 ${B.top + bplot.h / 2}) rotate(-90)`" text-anchor="middle">cm</text>
          </g>
          <template v-for="(a, k) in AXES" :key="`b${a}`">
            <g v-for="(s, i) in series" :key="s.key" @mousemove="barTip($event, s, k)" @mouseleave="tip = null">
              <!-- the whole column is the target, not only the bar: a mean near zero is a sliver -->
              <rect :x="bx(k, i) - 1" :y="B.top" :width="barWidth + 2" :height="bplot.h" fill="transparent" />
              <path :d="barPath(bx(k, i), s.stat.meanCm[k]!)" :fill="COLOURS[s.series]" />
              <!-- one standard deviation either side of the mean, in ink -->
              <g class="stroke-surface-900 dark:stroke-surface-0" stroke-width="1.5" stroke-linecap="round">
                <line
                  :x1="bx(k, i) + barWidth / 2"
                  :x2="bx(k, i) + barWidth / 2"
                  :y1="by(s.stat.meanCm[k]! - s.stat.stdCm[k]!)"
                  :y2="by(s.stat.meanCm[k]! + s.stat.stdCm[k]!)"
                />
                <line
                  v-for="end in [-1, 1]"
                  :key="end"
                  :x1="bx(k, i) + barWidth / 2 - 4"
                  :x2="bx(k, i) + barWidth / 2 + 4"
                  :y1="by(s.stat.meanCm[k]! + end * s.stat.stdCm[k]!)"
                  :y2="by(s.stat.meanCm[k]! + end * s.stat.stdCm[k]!)"
                />
              </g>
            </g>
          </template>
          <!-- the zero line on top: every bar stands on it -->
          <line :x1="B.left" :x2="B.left + bplot.w" :y1="by(0)" :y2="by(0)" class="stroke-surface-500" stroke-width="1" />
        </svg>
      </figure>
    </div>

    <div
      v-if="tip"
      class="pointer-events-none absolute z-10 rounded-md border border-surface-300 bg-surface-0 px-2.5 py-1.5 text-xs shadow-panel dark:border-surface-700 dark:bg-surface-800"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      role="status"
    >
      <b class="block font-semibold">{{ tip.title }}</b>
      <span v-for="line in tip.lines" :key="line" class="block font-mono text-surface-600 dark:text-surface-300">{{ line }}</span>
    </div>
  </div>
</template>
