<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import IconImage from '~icons/carbon/image'

/**
 * The contact sheet of one episode of the sample: one row per camera, frames
 * over time. A click shows it large. A sheet the critics could not draw (no
 * video in the sample) is said, not shown as a broken image.
 */
defineProps<{ src: string; episode: number; caption?: string }>()
const { t } = useI18n()
const failed = ref(false)
const open = ref(false)
</script>

<template>
  <figure class="flex min-w-0 flex-col gap-1">
    <button
      v-if="!failed"
      type="button"
      class="block cursor-zoom-in overflow-hidden rounded-lg border border-surface-300 bg-surface-950 dark:border-surface-700"
      :aria-label="t('specWizard.sheetOpen', { n: episode })"
      @click="open = true"
    >
      <img
        :src="src"
        :alt="t('specWizard.sheetAlt', { n: episode })"
        loading="lazy"
        class="block w-full"
        @error="failed = true"
      />
    </button>
    <div
      v-else
      class="flex aspect-video items-center justify-center gap-2 rounded-lg border border-dashed border-surface-300 text-xs text-surface-500 dark:border-surface-700 dark:text-surface-400"
    >
      <IconImage class="size-4" />
      {{ t('specWizard.sheetMissing') }}
    </div>
    <figcaption class="text-xs text-surface-500 dark:text-surface-400">
      {{ t('specWizard.episode', { n: episode }) }}<template v-if="caption"> · {{ caption }}</template>
    </figcaption>
    <Modal v-model:visible="open" :title="t('specWizard.episode', { n: episode })" :hint="caption" size="xl">
      <img :src="src" :alt="t('specWizard.sheetAlt', { n: episode })" class="block w-full rounded-lg" />
      <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.sheetHint') }}</p>
    </Modal>
  </figure>
</template>
