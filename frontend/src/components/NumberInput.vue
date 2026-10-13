<script setup lang="ts">
import { computed } from 'vue'

/**
 * A number field on top of Volt's InputText, which models a string. Empty
 * input is `null`, so "no target yet" stays distinguishable from 0.
 */
const props = withDefaults(defineProps<{ min?: number; step?: number }>(), {
  min: 0,
  step: 1,
})
const model = defineModel<number | null>({ required: true })

const text = computed({
  get: () => (model.value == null ? '' : String(model.value)),
  set: (v: string) => {
    const n = Number(v)
    model.value = v.trim() === '' || Number.isNaN(n) ? null : n
  },
})
</script>

<template>
  <InputText v-model="text" type="number" inputmode="numeric" :min="props.min" :step="props.step" />
</template>
