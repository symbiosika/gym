<script setup lang="ts">
import { computed } from 'vue'

/**
 * A line on the 0 to 1 scale of a score, set by dragging, with every episode
 * of the sample as a dot at its score. So a stop or a threshold is placed by
 * looking at the episodes it would cut off, not by guessing a number: dots
 * below the line are on its "fails" side and drawn in that colour. The dot of
 * the open episode is ringed; a click on a dot opens that episode.
 */
const value = defineModel<number>({ required: true })
const props = withDefaults(
  defineProps<{
    dots: { episode: number; score: number; judged?: 'accept' | 'reject' }[]
    selected?: number | null
    /** what lies below the line: `bad` for a stop, `warn` for a review threshold */
    below?: 'bad' | 'warn'
    disabled?: boolean
    label: string
  }>(),
  { selected: null, below: 'bad', disabled: false },
)
const emit = defineEmits<{ pick: [episode: number] }>()

const pct = (v: number) => `${Math.min(100, Math.max(0, v * 100))}%`
/** dots at the same score are stacked, so none hides another */
const placed = computed(() => {
  const seen = new Map<string, number>()
  return [...props.dots]
    .sort((a, b) => a.score - b.score)
    .map((d) => {
      const key = d.score.toFixed(2)
      const level = seen.get(key) ?? 0
      seen.set(key, level + 1)
      return { ...d, level }
    })
})
const height = computed(() => 18 + Math.max(0, ...placed.value.map((d) => d.level)) * 10)
const cut = computed(() => props.dots.filter((d) => d.score < value.value).length)
</script>

<template>
  <div class="flex flex-col gap-1" :class="disabled ? 'pointer-events-none opacity-50' : ''">
    <div class="flex items-baseline justify-between text-xs">
      <span class="text-surface-500 dark:text-surface-400">{{ label }}</span>
      <span class="font-mono tabular-nums font-semibold">{{ value.toFixed(2) }}</span>
    </div>
    <div class="relative" :style="{ height: `${height + 22}px` }">
      <!-- the episodes -->
      <button
        v-for="d in placed"
        :key="d.episode"
        type="button"
        class="absolute size-2.5 -translate-x-1/2 cursor-pointer rounded-full border transition-transform hover:scale-150"
        :class="[
          d.score < value ? (below === 'bad' ? 'bg-bad border-bad' : 'bg-warn border-warn') : 'bg-ok border-ok',
          d.episode === selected ? 'ring-primary scale-150 ring-2 ring-offset-1 dark:ring-offset-surface-900' : '',
          d.judged === 'reject' ? 'rounded-none' : '',
        ]"
        :style="{ left: pct(d.score), bottom: `${22 + d.level * 10}px` }"
        :title="`E${d.episode} · ${d.score.toFixed(2)}`"
        @click="emit('pick', d.episode)"
      />
      <!-- the scale and the line -->
      <div class="absolute inset-x-0 bottom-2 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
        <div class="h-full" :class="below === 'bad' ? 'bg-bad/30' : 'bg-warn/30'" :style="{ width: pct(value) }" />
      </div>
      <span
        class="bg-primary absolute bottom-0 w-0.5 -translate-x-1/2"
        :style="{ left: pct(value), height: `${height + 14}px` }"
      />
      <input
        v-model.number="value"
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="absolute inset-x-0 bottom-0 h-5 w-full cursor-ew-resize opacity-0"
        :aria-label="label"
        :disabled="disabled"
      />
    </div>
    <div class="flex justify-between font-mono text-[10px] text-surface-400"><span>0</span><span>0.5</span><span>1</span></div>
    <slot :cut="cut" />
  </div>
</template>
