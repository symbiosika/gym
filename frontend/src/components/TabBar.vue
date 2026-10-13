<script setup lang="ts">
/** The inline tab strip of a view. `tabs` is a list of `{ value, label }`. */
defineProps<{ tabs: { value: string; label: string }[] }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <nav class="inline-flex gap-0.5 rounded-lg bg-surface-200 p-0.5 dark:bg-surface-800" role="tablist">
    <button
      v-for="tb in tabs"
      :key="tb.value"
      type="button"
      role="tab"
      class="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-surface-600 transition-colors hover:text-surface-900 aria-selected:bg-surface-0 aria-selected:text-primary aria-selected:shadow-sm dark:text-surface-300 dark:hover:text-surface-0 dark:aria-selected:bg-surface-900"
      :aria-selected="model === tb.value"
      @click="model = tb.value"
    >
      {{ tb.label }}
    </button>
  </nav>
</template>
