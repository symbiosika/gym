<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * A list of short words (flags, arm names) typed as one comma-separated
 * line. The list is written on blur and on Enter, so a half-typed word never
 * splits the model while typing.
 */
defineProps<{ placeholder?: string }>()
const model = defineModel<string[]>({ required: true })

const text = ref(model.value.join(', '))
watch(model, (v) => {
  if (
    v.join(', ') !==
    text.value
      .trim()
      .replace(/\s*,\s*/g, ', ')
      .replace(/,\s*$/, '')
  )
    text.value = v.join(', ')
})

function commit() {
  model.value = text.value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
</script>

<template>
  <InputText
    v-model="text"
    fluid
    class="font-mono! text-xs!"
    :placeholder="placeholder"
    @blur="commit"
    @keydown.enter.prevent="commit"
  />
</template>
