<script setup lang="ts">
/** Label, control and hint of one input. `required` marks it with a dot. */
defineProps<{
  label?: string
  hint?: string
  required?: boolean
  info?: string
}>()
</script>

<template>
  <div class="flex min-w-0 flex-col">
    <span v-if="label || info" class="mb-1 flex items-center gap-1.5">
      <label class="gym-field mb-0">{{ label }}</label>
      <span v-if="required" class="text-bad" aria-hidden="true">*</span>
      <InfoButton v-if="info" :k="info" />
    </span>
    <slot />
    <span v-if="hint" class="mt-1 text-xs text-surface-500 dark:text-surface-400">{{ hint }}</span>
  </div>
</template>
