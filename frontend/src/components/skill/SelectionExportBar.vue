<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * The exports of the skill's selection on the Pre-Train tab: the name, the
 * manifest and the merged dataset. Shown above the table and once more at the
 * end of the page; both bars share one name and one running export.
 */
defineProps<{
  /** episodes the export takes */
  count: number
  /** what is running on the page ('' for nothing): every button waits for it */
  busy: string
}>()
const emit = defineEmits<{ export: [kind: 'export' | 'merged'] }>()
const name = defineModel<string>('name', { required: true })
const { t } = useI18n()
</script>

<template>
  <div class="gym-panel flex flex-wrap items-end gap-2 p-3">
    <FormField class="min-w-56 grow" :label="t('selection.exportName')" :hint="t('selection.exportNameHint')">
      <InputText v-model="name" fluid :disabled="!!busy" maxlength="120" />
    </FormField>
    <span class="pb-2 text-sm text-surface-500 dark:text-surface-400">{{
      t('skill.episodesTab.exportCount', { n: count })
    }}</span>
    <SecondaryButton
      :disabled="!count || !!busy"
      :loading="busy === 'export'"
      :label="t('skill.episodesTab.export')"
      :title="count ? t('skill.episodesTab.exportHint') : t('skill.episodesTab.nothingSelected')"
      @click="emit('export', 'export')"
    />
    <Button
      :disabled="!count || !!busy"
      :loading="busy === 'merged'"
      :label="busy === 'merged' ? t('skill.episodesTab.merging') : t('skill.episodesTab.exportMerged')"
      :title="count ? t('skill.episodesTab.exportMergedHint') : t('skill.episodesTab.nothingSelected')"
      @click="emit('export', 'merged')"
    />
  </div>
</template>
