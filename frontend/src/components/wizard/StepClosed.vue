<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import type { BlockView } from '@/types/gym'
import { fmtMinutes, fmtSecs, fmtTime } from '@/utils/time'
import RolloutReview from '@/components/RolloutReview.vue'
import SectionHeader from '@/components/SectionHeader.vue'

/**
 * The closed block: the figures at a glance, the day's print link, a way
 * back. An evaluation keeps its rollout review here, editable: a person who
 * had no time at the cell reviews the rollouts a day later without reopening
 * the block, and the figures above follow.
 */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t } = useI18n()

/** the review changed a verdict: the figures of the block have to follow */
async function reloadBlock() {
  try {
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}
async function reopen() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, props.block.datasets.length ? 'review' : 'brief'))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ t('closed.title') }}
    </h2>
    <p class="mt-1 mb-4 text-surface-600 dark:text-surface-300">
      {{ t('closed.lead') }}
    </p>

    <div class="grid gap-3 sm:grid-cols-2" :class="block.kind === 'recording' ? 'lg:grid-cols-5' : 'lg:grid-cols-4'">
      <div class="gym-panel flex flex-col gap-1 p-4">
        <span class="text-xs font-semibold tracking-wide text-surface-500 uppercase dark:text-surface-400">{{
          block.kind === 'evaluation' ? t('review.succeededRollouts') : t('review.todayAccepted')
        }}</span>
        <span class="font-display text-3xl leading-tight font-semibold tabular-nums"
          >{{ block.totals.accepted }}<small class="text-sm text-surface-500"> / {{ block.totals.episodes }}</small></span
        >
      </div>
      <KpiTile v-if="block.kind === 'recording'" :label="t('selection.selectedShort')" :value="String(block.totals.selected)" />
      <KpiTile :label="t('review.datasets')" :value="String(block.datasets.length)" />
      <KpiTile
        :label="block.kind === 'evaluation' ? t('recording.evaluationTime') : t('review.teleop')"
        :value="fmtMinutes(block.times.teleopMinutes)"
        :sub="`${fmtTime(block.teleopStartedAt)} – ${fmtTime(block.teleopEndedAt)} · ${t('recording.teleopWindows', { n: block.times.teleopSessions })}`"
        small
      />
      <KpiTile
        :label="t('review.recorded')"
        :value="fmtSecs(block.times.recordedSeconds)"
        :sub="t('review.recordedHint')"
        small
      />
    </div>

    <section v-if="block.kind === 'evaluation' && block.datasets.length" class="mt-6">
      <SectionHeader n="" :title="t('closed.reviewRollouts')" />
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('closed.reviewLead') }}</p>
      <RolloutReview
        :block-id="block.id"
        :tenant-id="tenantId"
        :datasets="block.datasets"
        @changed="reloadBlock"
        @error="emit('error', $event)"
      />
    </section>

    <div class="gym-stepnav">
      <SecondaryButton :label="t('closed.reopen')" @click="reopen" />
      <span class="grow"></span>
      <a :href="`#/print/${block.shareId}`" target="_blank" rel="noopener">
        <SecondaryButton :label="t('day.print')" />
      </a>
      <RouterLink :to="{ name: 'Skill', params: { tenantId, skillId: block.skillId } }">
        <SecondaryButton :label="t('closed.toSkill')" />
      </RouterLink>
      <RouterLink :to="{ name: 'Day', params: { tenantId, dayId: block.dayProtocolId } }">
        <SecondaryButton :label="t('closed.toDay')" />
      </RouterLink>
      <RouterLink :to="{ name: 'Home', params: { tenantId } }">
        <Button :label="t('closed.toHome')" />
      </RouterLink>
    </div>
  </div>
</template>
