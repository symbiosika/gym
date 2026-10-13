<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { popover, showInfo } from './infoPopover'

/** The "i" next to a label; `k` is a key under `info` in the locales: [title, explanation, example]. */
const props = defineProps<{ k: string }>()
const { tm } = useI18n()
const info = computed(() => tm(`info.${props.k}`) as unknown as [string, string, string])
const expanded = computed(() => popover.open && popover.title === info.value?.[0])
</script>

<template>
  <button
    type="button"
    data-info-button
    class="grid size-4.5 shrink-0 cursor-pointer place-items-center rounded-full border border-surface-300 font-mono text-[10px] leading-none font-bold text-surface-500 transition-colors hover:border-primary hover:text-primary aria-expanded:border-primary aria-expanded:bg-primary aria-expanded:text-white dark:border-surface-700 dark:text-surface-400"
    :aria-expanded="expanded"
    aria-label="Info"
    @click.stop="showInfo($event.currentTarget as HTMLElement, info)"
  >
    i
  </button>
</template>
