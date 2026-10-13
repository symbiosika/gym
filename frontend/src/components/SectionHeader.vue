<script setup lang="ts">
/** The heading of a section: running number, title, optional info button and hint, actions on the right. */
defineProps<{ n?: string; title: string; hint?: string; info?: string }>()
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1">
    <span
      v-if="n"
      class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
      >{{ n }}</span
    >
    <h2 class="font-display text-lg font-semibold">{{ title }}</h2>
    <InfoButton v-if="info" :k="info" />
    <span v-if="hint" class="text-sm text-surface-500 dark:text-surface-400">{{ hint }}</span>
    <div v-if="$slots.default" class="ms-auto flex flex-wrap items-center gap-2">
      <slot />
    </div>
  </div>
</template>
