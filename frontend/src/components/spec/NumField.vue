<script setup lang="ts">
import { computed } from 'vue'

/**
 * A number field for the spec form: models a number, never null. Emptying the
 * field puts the `fallback` back (the critics' default), so a weight or a
 * threshold is always a number the critics can read.
 */
const props = withDefaults(defineProps<{ min?: number; max?: number; step?: number; fallback?: number; narrow?: boolean }>(), {
  step: 0.1,
  fallback: 0,
  narrow: false,
})
const model = defineModel<number>({ required: true })

const text = computed({
  get: () => String(model.value),
  set: (v: string) => {
    const n = Number(v)
    if (v.trim() === '' || Number.isNaN(n)) {
      model.value = props.fallback
      return
    }
    let clamped = n
    if (props.min != null) clamped = Math.max(props.min, clamped)
    if (props.max != null) clamped = Math.min(props.max, clamped)
    model.value = clamped
  },
})
</script>

<template>
  <InputText
    v-model="text"
    type="number"
    inputmode="decimal"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    class="tabular-nums"
    :class="props.narrow ? 'w-20!' : 'w-28!'"
  />
</template>
