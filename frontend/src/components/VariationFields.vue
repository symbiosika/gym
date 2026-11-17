<script setup lang="ts">
import type { PlanVariationField } from '@/types/gym'

/**
 * What a run sheet says about one episode beyond its label: the columns of
 * its row as small "name: value" pairs, in the order of the sheet. Shown as
 * they are, GYM gives them no meaning. Renders nothing without any.
 */
defineProps<{ fields?: PlanVariationField[] | null }>()
</script>

<template>
  <dl v-if="fields?.length" class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-surface-500 dark:text-surface-400">
    <div v-for="f in fields" :key="f.name" class="flex gap-1">
      <dt class="font-mono">{{ f.name }}:</dt>
      <dd class="font-medium text-surface-700 dark:text-surface-200">{{ f.value }}</dd>
    </div>
  </dl>
</template>
