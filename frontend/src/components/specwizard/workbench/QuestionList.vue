<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { QuestionRow } from '@/utils/specSample'
import IconYes from '~icons/carbon/checkmark-filled'
import IconNo from '~icons/carbon/close-filled'
import IconOpen from '~icons/carbon/help'
import IconError from '~icons/carbon/warning-alt-filled'

/**
 * The questions to the model on the open episode, one line each: ✓ or ✗ with
 * the model's sentence, or "not tested yet" for words it has not been asked.
 * A click opens the question on the right.
 */
defineProps<{ rows: QuestionRow[]; active: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="flex flex-col divide-y divide-surface-200 dark:divide-surface-800">
    <li v-for="q in rows" :key="q.id">
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-2.5 px-1 py-2 text-start transition-colors hover:bg-surface-50 dark:hover:bg-surface-800/40"
        :class="active === q.id ? 'bg-primary/10' : ''"
        :title="q.score != null ? t('specWizard.q.scoreTitle', { s: q.score.toFixed(2) }) : undefined"
        @click="emit('select', q.id)"
      >
        <IconYes v-if="q.answer === 'yes'" class="text-ok mt-0.5 size-5 shrink-0" />
        <IconNo v-else-if="q.answer === 'no'" class="text-bad mt-0.5 size-5 shrink-0" />
        <IconError v-else-if="q.answer === 'error'" class="text-warn mt-0.5 size-5 shrink-0" />
        <IconOpen v-else class="mt-0.5 size-5 shrink-0 text-surface-400" />
        <span class="min-w-0 grow">
          <span class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-medium" :class="q.answer === 'untested' ? 'text-surface-500 dark:text-surface-400' : ''">{{
              q.kind === 'model' ? t('specWizard.q.overall') : q.text
            }}</span>
            <span
              v-if="q.must"
              class="rounded px-1 text-[10px] font-semibold uppercase"
              :class="q.stops ? 'bg-bad-soft text-bad' : 'bg-surface-100 text-surface-500 dark:bg-surface-800'"
              >{{ t('specWizard.q.must') }}</span
            >
          </span>
          <span v-if="q.answer === 'untested'" class="block text-xs text-surface-500 dark:text-surface-400">{{
            t('specWizard.q.untested')
          }}</span>
          <span v-else-if="q.evidence" class="line-clamp-2 block text-xs text-surface-600 dark:text-surface-300">{{
            q.evidence
          }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>
