<script setup lang="ts">
/** The heading of a view: title, a monospaced sub line, actions on the right. */
defineProps<{ title: string; sub?: string }>()
</script>

<template>
  <div class="mt-6 mb-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
    <h1 class="font-display text-[1.375rem] leading-tight font-bold tracking-tight">
      {{ title }}
    </h1>
    <span v-if="sub" class="font-mono text-[0.7rem] tracking-wider text-surface-500 dark:text-surface-400">{{ sub }}</span>
    <div v-if="$slots.default" class="ms-auto flex flex-wrap items-center gap-2 print:hidden">
      <slot />
    </div>
  </div>
</template>
