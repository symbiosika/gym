<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CueTest } from '@/types/gym'
import { firstBaseline, labelPlace, radarOutline, radarPoints, radarRing, ringLabelPlace, twoLines } from '@/utils/shortcutRadar'
import IconWarning from '~icons/carbon/warning-alt'

/**
 * The shortcut tests as a spider plot: one axis per test, the critics' hit
 * rate on held-out scenes as the filled shape, chance (the share of the most
 * frequent answer) as a dashed ring for each axis. The further the shape
 * reaches past the ring, the more a policy could answer from that signal
 * instead of the prompt.
 *
 * GYM only draws what the critics computed. An axis is marked only where the
 * critics raised the matching finding; a test they could not run has no point
 * and leaves a gap. The tiles above carry the same figures as numbers.
 *
 * Colour says which line, never how good: the hit rate in the primary blue,
 * chance in a neutral ink, dashed. Checked for separation and contrast on the
 * panel in both modes; the finding a test belongs to is the critics' warning,
 * with its icon and name.
 */
export interface RadarAxis {
  key: string
  label: string
  test: CueTest | null
  /** the critics raised the finding this test belongs to */
  flagged: boolean
  /** the finding's name, for the tooltip */
  flag?: string
}
const props = defineProps<{ axes: RadarAxis[] }>()
const { t } = useI18n()

const W = 440
const H = 292
// room above the rim for a two-line label at the top axis
const frame = { cx: W / 2, cy: 154, r: 108 }
const n = computed(() => props.axes.length)
const rings = [0.25, 0.5, 0.75, 1]

const hit = computed(() =>
  radarPoints(
    frame,
    props.axes.map((a) => a.test?.accuracy),
  ),
)
const chance = computed(() =>
  radarPoints(
    frame,
    props.axes.map((a) => a.test?.chance),
  ),
)
const hitOutline = computed(() => radarOutline(hit.value))
const chanceOutline = computed(() => radarOutline(chance.value))
const spokes = computed(() =>
  radarPoints(
    frame,
    props.axes.map(() => 1),
  ),
)
const labels = computed(() => props.axes.map((a, i) => ({ ...labelPlace(frame, i, n.value), lines: twoLines(a.label), axis: a })))

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`)

const tip = ref<{ x: number; y: number; title: string; lines: string[] } | null>(null)
const root = ref<HTMLElement | null>(null)
function show(event: MouseEvent, a: RadarAxis) {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  const lines = a.test
    ? [
        t('skill.episodesTab.shortcuts.radar.tipHit', { share: pct(a.test.accuracy) }),
        t('skill.episodesTab.shortcuts.radar.tipChance', { share: pct(a.test.chance) }),
        t('skill.episodesTab.shortcuts.radar.tipLift', { share: pct(a.test.lift) }),
        t('skill.episodesTab.shortcuts.radar.tipBase', { n: a.test.n, scenes: a.test.scenes, classes: a.test.classes }),
      ]
    : [t('skill.episodesTab.shortcuts.notTestable')]
  if (a.flagged && a.flag) lines.push(t('skill.episodesTab.shortcuts.radar.tipFlag', { flag: a.flag }))
  tip.value = { x: event.clientX - box.left + 12, y: event.clientY - box.top + 12, title: a.label, lines }
}
</script>

<template>
  <figure ref="root" class="gym-panel relative p-3" data-testid="shortcut-radar" @mouseleave="tip = null">
    <figcaption class="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1">
      <b class="text-sm font-semibold">{{ t('skill.episodesTab.shortcuts.radar.title') }}</b>
      <ul class="ms-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-600 dark:text-surface-300">
        <li class="flex items-center gap-1.5">
          <svg width="18" height="10" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="16"
              height="8"
              rx="2"
              class="fill-primary-600/15 stroke-primary-600 dark:fill-primary-400/20 dark:stroke-primary-400"
              stroke-width="2"
            />
          </svg>
          {{ t('skill.episodesTab.shortcuts.radar.hit') }}
        </li>
        <li class="flex items-center gap-1.5">
          <svg width="18" height="10" aria-hidden="true">
            <line
              x1="1"
              y1="5"
              x2="17"
              y2="5"
              class="stroke-surface-500 dark:stroke-surface-400"
              stroke-width="2"
              stroke-dasharray="4 3"
            />
          </svg>
          {{ t('skill.episodesTab.shortcuts.radar.chance') }}
        </li>
      </ul>
    </figcaption>

    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="mx-auto block w-full max-w-lg"
      role="img"
      :aria-label="t('skill.episodesTab.shortcuts.radar.title')"
    >
      <!-- grid: recessive rings at 25 % steps and one spoke per test -->
      <g class="text-surface-200 dark:text-surface-800" stroke="currentColor" stroke-width="1" fill="none">
        <path v-for="s in rings" :key="s" :d="radarRing(frame, n, s)" />
        <line v-for="(pt, i) in spokes" :key="`s${i}`" :x1="frame.cx" :y1="frame.cy" :x2="pt!.x" :y2="pt!.y" />
      </g>
      <g class="fill-surface-500 font-mono dark:fill-surface-400" font-size="9">
        <text v-for="s in [0.5, 1]" :key="`r${s}`" v-bind="ringLabelPlace(frame, n, s)">{{ Math.round(s * 100) }} %</text>
      </g>

      <!-- chance: the reference each hit rate is read against -->
      <path
        :d="chanceOutline.d"
        fill="none"
        class="stroke-surface-500 dark:stroke-surface-400"
        stroke-width="2"
        stroke-dasharray="4 3"
        stroke-linejoin="round"
      />
      <!-- the hit rate on held-out scenes -->
      <path
        v-if="hitOutline.closed"
        :d="hitOutline.d"
        class="fill-primary-600/15 dark:fill-primary-400/20"
        stroke="none"
        data-testid="shortcut-radar-shape"
      />
      <path
        :d="hitOutline.d"
        fill="none"
        class="stroke-primary-600 dark:stroke-primary-400"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <template v-for="(pt, i) in hit" :key="`p${i}`">
        <circle
          v-if="pt"
          :cx="pt.x"
          :cy="pt.y"
          r="4.5"
          class="fill-primary-600 stroke-surface-0 dark:fill-primary-400 dark:stroke-surface-900"
          stroke-width="2"
        />
      </template>

      <!-- labels; a test the critics raised a finding for carries their warning -->
      <g font-size="11">
        <text
          v-for="(l, i) in labels"
          :key="`l${i}`"
          :x="l.x"
          :y="firstBaseline(frame, l, l.lines.length)"
          :text-anchor="l.anchor"
          :class="
            l.axis.flagged
              ? 'fill-warn font-semibold'
              : l.axis.test
                ? 'fill-surface-700 dark:fill-surface-200'
                : 'fill-surface-500 dark:fill-surface-400'
          "
        >
          <tspan v-for="(line, k) in l.lines" :key="k" :x="l.x" :dy="k ? 13 : 0">{{ line }}</tspan>
        </text>
      </g>

      <!-- hover: the whole spoke, wider than the mark -->
      <line
        v-for="(pt, i) in spokes"
        :key="`h${i}`"
        :x1="frame.cx"
        :y1="frame.cy"
        :x2="pt!.x"
        :y2="pt!.y"
        stroke="transparent"
        stroke-width="26"
        class="cursor-default"
        @mousemove="show($event, axes[i]!)"
      />
    </svg>

    <ul v-if="axes.some((a) => a.flagged)" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-warn">
      <li v-for="a in axes.filter((x) => x.flagged)" :key="a.key" class="flex items-center gap-1">
        <IconWarning class="size-3.5" aria-hidden="true" />{{ a.label }}: {{ a.flag }}
      </li>
    </ul>

    <div
      v-if="tip"
      class="pointer-events-none absolute z-10 rounded-md border border-surface-300 bg-surface-0 px-2.5 py-1.5 text-xs shadow-panel dark:border-surface-700 dark:bg-surface-900"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="font-semibold">{{ tip.title }}</div>
      <div v-for="line in tip.lines" :key="line" class="text-surface-600 dark:text-surface-300">{{ line }}</div>
    </div>
  </figure>
</template>
