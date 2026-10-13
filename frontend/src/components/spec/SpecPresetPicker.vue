<script setup lang="ts">
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { PRESET_IDS, type PresetId } from '@/utils/spec'
import IconBox from '~icons/carbon/box'
import IconRepeat from '~icons/carbon/repeat'
import IconCategory from '~icons/carbon/category'
import IconPlug from '~icons/carbon/plug'
import IconPartnership from '~icons/carbon/partnership'
import IconEvaluation from '~icons/carbon/chart-evaluation'
import IconBlank from '~icons/carbon/document-blank'

/**
 * The first step of a new spec: pick the shape of the task. Every card is a
 * complete spec for a typical scene (objects, indicators, gates, checks); the
 * form opens filled in and the operator changes the words.
 */
const emit = defineEmits<{ pick: [id: PresetId] }>()
const { t } = useI18n()

const icons: Record<PresetId, Component> = {
  pick_place: IconBox,
  repeated: IconRepeat,
  sorting: IconCategory,
  insertion: IconPlug,
  bimanual: IconPartnership,
  evaluation: IconEvaluation,
  blank: IconBlank,
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div>
      <p class="font-display text-base font-semibold">{{ t('spec.presetTitle') }}</p>
      <p class="text-sm text-surface-500 dark:text-surface-400">{{ t('spec.presetHint') }}</p>
    </div>
    <div class="grid gap-2 sm:grid-cols-2">
      <button
        v-for="id in PRESET_IDS"
        :key="id"
        type="button"
        class="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-300 bg-surface-0 p-3 text-start transition-colors hover:border-primary hover:bg-primary/5 dark:border-surface-700 dark:bg-surface-900"
        :class="id === 'blank' ? 'sm:col-span-2' : ''"
        @click="emit('pick', id)"
      >
        <span class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary dark:bg-primary/15">
          <component :is="icons[id]" class="size-5" />
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-semibold">{{ t(`spec.preset.${id}.title`) }}</span>
          <span class="block text-xs text-surface-500 dark:text-surface-400">{{ t(`spec.preset.${id}.desc`) }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
