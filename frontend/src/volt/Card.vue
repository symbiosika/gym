<template>
  <Card
    unstyled
    :pt="theme"
    :ptOptions="{
      mergeProps: ptViewMerge,
    }"
  >
    <template v-for="(_, slotName) in $slots" #[slotName]="slotProps">
      <slot :name="slotName" v-bind="slotProps ?? {}" />
    </template>
  </Card>
</template>

<script setup lang="ts">
import Card, { type CardPassThroughOptions, type CardProps } from 'primevue/card'
import { ref } from 'vue'
import { ptViewMerge } from './utils'

interface Props extends /* @vue-ignore */ CardProps {}
defineProps<Props>()

const theme = ref<CardPassThroughOptions>({
  root: `flex flex-col rounded-xl
        bg-surface-0/90 dark:bg-surface-900/70 backdrop-blur-sm
        text-surface-700 dark:text-surface-0
        border border-surface-200 dark:border-surface-800
        shadow-sm transition-shadow duration-300
        hover:shadow-glow hover:border-primary-200 dark:hover:border-primary-500/30`,
  header: ``,
  body: `p-6 flex flex-col gap-2`,
  caption: `flex flex-col gap-2`,
  title: `font-medium text-xl`,
  subtitle: `text-surface-500 dark:text-surface-400`,
  content: ``,
  footer: ``,
})
</script>
