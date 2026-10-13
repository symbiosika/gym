<script setup lang="ts">
/**
 * Modal in the gym design: header with running number and title, scrolling
 * body, footer slot for actions. Volt's Dialog does the overlay, the focus
 * trap and Escape; `locked` keeps a step-by-step dialog open.
 */
const props = withDefaults(
  defineProps<{
    title: string
    n?: string
    hint?: string
    size?: 'sm' | 'md' | 'lg' | 'xl'
    locked?: boolean
  }>(),
  { size: 'md', n: '', hint: '', locked: false },
)
const visible = defineModel<boolean>('visible', { required: true })

const widths = { sm: '26rem', md: '38rem', lg: '52rem', xl: '68rem' } as const
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :closable="!props.locked"
    :dismissable-mask="!props.locked"
    :close-on-escape="!props.locked"
    :draggable="false"
    :aria-label="title"
    :style="{ width: widths[props.size] }"
    class="w-[calc(100vw-2rem)]"
  >
    <template #header>
      <div class="flex min-w-0 items-baseline gap-2.5">
        <span
          v-if="n"
          class="bg-primary/10 text-primary dark:bg-primary/15 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
          >{{ n }}</span
        >
        <h2 class="font-display truncate text-lg font-semibold">{{ title }}</h2>
        <span v-if="hint" class="truncate text-sm text-surface-500 dark:text-surface-400">{{ hint }}</span>
      </div>
    </template>

    <slot />

    <template v-if="$slots.footer" #footer>
      <div class="flex w-full flex-wrap items-center gap-2">
        <slot name="footer" />
      </div>
    </template>
  </Dialog>
</template>
