<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import type { DatasetSummary, BlockView, Lang } from '@/types/gym'
import { fmtMinutes, fmtSecs, fmtTime } from '@/utils/time'
import CriticsSummaryView from '@/components/CriticsSummaryView.vue'
import Button from '@/volt/Button.vue'
import SecondaryButton from '@/volt/SecondaryButton.vue'
import RolloutReview from '@/components/RolloutReview.vue'
import IconTrash from '~icons/carbon/trash-can'

/**
 * Step 5: the critics' results for today's datasets. Runs still in progress
 * are polled. From here the operator records more episodes (the AI says
 * what), moves on to the selection or closes the block. In an evaluation the
 * rollouts are reviewed here as well: a person may overrule the critics, and
 * the block's success rate follows.
 */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t, locale } = useI18n()
const gym = useGym()
const dialog = useDialog()
const busy = ref('')
const fail = (e: unknown) => emit('error', e instanceof Error ? e.message : String(e))
const isEvaluation = computed(() => props.block.kind === 'evaluation')
const successRate = computed(() =>
  props.block.totals.episodes ? (props.block.totals.accepted / props.block.totals.episodes) * 100 : null,
)

const open = computed(() => props.block.datasets.filter((d) => d.analysisStatus === 'queued' || d.analysisStatus === 'running'))
const missing = computed(() =>
  props.block.targetEpisodes != null ? Math.max(0, props.block.targetEpisodes - props.block.totals.accepted) : null,
)

/**
 * The verdict of the step in one sentence, and the action it suggests: more
 * episodes while the target is not reached, else the selection (or, in an
 * evaluation, closing the block once the rollouts are in).
 */
const pending = computed(() => (isEvaluation.value ? props.block.totals.review : 0))
const verdict = computed<{ tone: 'ok' | 'warn' | 'neutral'; text: string; more: boolean }>(() => {
  const tt = props.block.totals
  if (open.value.length) return { tone: 'neutral', text: t('review.verdictRunning', { n: open.value.length }), more: false }
  if (isEvaluation.value) {
    const short = props.block.targetEpisodes != null && tt.episodes < props.block.targetEpisodes
    return {
      tone: short ? 'warn' : 'ok',
      text: t('review.verdictEvaluation', {
        rate: successRate.value == null ? '–' : Math.round(successRate.value),
        ok: tt.accepted,
        n: tt.episodes,
      }),
      more: short,
    }
  }
  if (missing.value == null)
    return { tone: 'neutral', text: t('review.verdictNoTarget', { ok: tt.accepted, n: tt.episodes }), more: false }
  return missing.value > 0
    ? {
        tone: 'warn',
        text: t('review.verdictMissing', { ok: tt.accepted, target: props.block.targetEpisodes, missing: missing.value }),
        more: true,
      }
    : { tone: 'ok', text: t('review.verdictReached', { ok: tt.accepted }), more: false }
})
/** many rejects: the hints below say why */
const manyRejected = computed(
  () =>
    !isEvaluation.value && props.block.totals.episodes > 0 && props.block.totals.rejected / props.block.totals.episodes >= 0.3,
)

// the critics take a while: follow the run while something is open
let timer: ReturnType<typeof setInterval> | undefined
async function poll() {
  if (!open.value.length) return
  try {
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch {
    /* next tick */
  }
}
onMounted(() => (timer = setInterval(poll, 5000)))
onBeforeUnmount(() => clearInterval(timer))

const progressText = (d: DatasetSummary) =>
  Object.entries(d.progress ?? {})
    .map(([stage, v]) => `${stage} ${v.done}/${v.total}`)
    .join(' · ')

/**
 * With one dataset its details are open. With several, the newest is open and
 * the others fold to their counts, so the page does not run for screens.
 */
const opened = ref<Record<string, boolean>>({})
const isOpen = (id: string, i: number) =>
  opened.value[id] ?? (props.block.datasets.length === 1 || i === props.block.datasets.length - 1)
const toggleOpen = (id: string, i: number) => (opened.value[id] = !isOpen(id, i))

const statusTone = (s: DatasetSummary['analysisStatus']) => (s === 'done' ? 'ok' : s === 'failed' ? 'bad' : 'warn')

async function followUp() {
  busy.value = 'follow'
  try {
    emit('update', await gymApi.followUp(props.tenantId, props.block.id, locale.value as Lang))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
async function recordMore() {
  try {
    emit('update', await gymApi.startRecording(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  }
}
/** Back to the upload: another zip of the same block goes to the critics from there. */
async function toUpload() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'upload'))
  } catch (e) {
    fail(e)
  }
}
async function toSelection() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'selection'))
  } catch (e) {
    fail(e)
  }
}
async function closeBlock() {
  if (!(await dialog.confirm({ title: t('closed.confirmTitle'), text: t('closed.confirmText'), ok: t('review.closeBlock') })))
    return
  try {
    emit('update', await gymApi.closeBlock(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  }
}
/** the human review changed a verdict: the block's figures have to follow */
async function reloadBlock() {
  try {
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  }
}
async function removeDataset(id: string, name: string) {
  if (
    !(await dialog.confirm({
      title: t('upload.removeDatasetConfirm'),
      text: t('upload.removeDatasetText', { name }),
      ok: t('upload.removeDataset'),
      danger: true,
    }))
  )
    return
  try {
    await gymApi.deleteDataset(props.tenantId, id)
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ t('review.title') }}
    </h2>
    <p class="mt-1 mb-4 text-surface-600 dark:text-surface-300">
      {{ isEvaluation ? t('review.leadEvaluation') : t('review.lead') }}
    </p>

    <!-- the answer first: where the block stands and what to do next -->
    <div
      class="mb-4 rounded-panel border border-s-[4px] px-4 py-3.5"
      :class="{
        'border-ok/40 border-s-ok bg-ok-soft': verdict.tone === 'ok',
        'border-warn/40 border-s-warn bg-warn-soft': verdict.tone === 'warn',
        'border-surface-300 border-s-primary bg-surface-50 dark:border-surface-800 dark:bg-surface-800/30':
          verdict.tone === 'neutral',
      }"
      role="status"
    >
      <div class="font-display flex items-center gap-2 text-lg font-semibold text-surface-900 dark:text-surface-0">
        <i v-if="open.length" class="bg-primary size-2.5 animate-pulse rounded-full" aria-hidden="true"></i>
        {{ verdict.text }}
      </div>
      <p v-if="pending" class="mt-1 text-sm text-surface-700 dark:text-surface-200">
        {{ t('review.verdictPending', { n: pending }) }}
      </p>
      <p v-if="manyRejected" class="mt-1 text-sm text-surface-700 dark:text-surface-200">{{ t('review.verdictManyRejected') }}</p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="gym-panel flex flex-col gap-1 p-4">
        <span class="text-xs font-semibold tracking-wide text-surface-500 uppercase dark:text-surface-400">{{
          isEvaluation ? t('review.succeededRollouts') : t('review.todayAccepted')
        }}</span>
        <span class="font-display text-3xl leading-tight font-semibold tabular-nums"
          >{{ block.totals.accepted }}<small class="text-sm text-surface-500"> / {{ block.totals.episodes }}</small></span
        >
        <span v-if="isEvaluation" class="text-xs text-surface-500 dark:text-surface-400">
          {{ t('skill.successRate') }} {{ successRate == null ? '–' : `${Math.round(successRate)} %` }}
        </span>
        <span v-else-if="block.targetEpisodes != null" class="text-xs text-surface-500 dark:text-surface-400">
          {{ t('review.target', { n: block.targetEpisodes }) }} ·
          {{ t('review.missing', { n: missing }) }}
        </span>
        <div v-if="block.targetEpisodes" class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
          <i
            class="block h-full rounded-full transition-[width]"
            :class="missing ? 'bg-primary' : 'bg-ok'"
            :style="{
              width: `${Math.min(100, (block.totals.accepted / block.targetEpisodes) * 100)}%`,
            }"
          ></i>
        </div>
      </div>
      <KpiTile
        :label="t('review.verdicts')"
        :value="`${block.totals.accepted} · ${block.totals.review} · ${block.totals.rejected}`"
        :sub="`${t('verdict.accept')} · ${t('verdict.review')} · ${t('verdict.reject')}`"
        small
      />
      <!-- the tool-side time, and next to it the elapsed time that comes from the data -->
      <KpiTile
        :label="isEvaluation ? t('recording.evaluationTime') : t('review.teleop')"
        :value="fmtMinutes(block.times.teleopMinutes)"
        :sub="`${fmtTime(block.teleopStartedAt)} – ${fmtTime(block.teleopEndedAt)}`"
        small
      />
      <KpiTile
        :label="t('review.recorded')"
        :value="fmtSecs(block.times.recordedSeconds)"
        :sub="`${block.datasets.length} ${t('review.datasets')}`"
        small
      />
    </div>

    <!-- in an evaluation the rollouts come first: what the policy did, judged by the model, the critics and a person -->
    <section v-if="isEvaluation && block.datasets.some((d) => d.analysisStatus === 'done')" class="mt-6">
      <SectionHeader n="" :title="t('rollouts.title')" />
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('rollouts.lead') }} {{ t('rollouts.vlmLead') }}</p>
      <RolloutReview :block-id="block.id" :tenant-id="tenantId" :datasets="block.datasets" @changed="reloadBlock" @error="fail" />
    </section>

    <section v-for="(d, i) in block.datasets" :key="d.id" class="mt-6">
      <SectionHeader :n="`${t('review.dataset')} ${String(i + 1).padStart(2, '0')}`" :title="d.name">
        <button
          v-if="block.datasets.length > 1 && d.analysis"
          type="button"
          class="text-primary cursor-pointer text-sm hover:underline"
          :aria-expanded="isOpen(d.id, i)"
          @click="toggleOpen(d.id, i)"
        >
          {{ isOpen(d.id, i) ? t('review.hideDetails') : t('review.showDetails') }}
        </button>
        <Pill :tone="statusTone(d.analysisStatus)">{{ t(`analysisStatus.${d.analysisStatus}`) }}</Pill>
        <span class="text-sm text-surface-500 dark:text-surface-400">{{ fmtTime(d.createdAt) }}</span>
        <SecondaryButton
          size="small"
          variant="text"
          class="text-bad!"
          :label="t('upload.removeDataset')"
          :aria-label="`${t('upload.removeDataset')}: ${d.name}`"
          @click="removeDataset(d.id, d.name)"
        >
          <template #icon><IconTrash class="size-4" /></template>
        </SecondaryButton>
      </SectionHeader>

      <div v-if="d.analysisStatus === 'queued' || d.analysisStatus === 'running'" class="gym-note">
        <span class="flex items-center gap-1.5 text-sm">
          <i class="bg-primary size-2 animate-pulse rounded-full" aria-hidden="true"></i>{{ t('review.running') }}
        </span>
        <div class="mt-1 font-mono text-xs text-surface-500 dark:text-surface-400">
          {{ progressText(d) || t('review.queued') }}
        </div>
      </div>
      <div v-else-if="d.analysisStatus === 'failed'" class="gym-note border-s-bad">
        <b class="text-bad">{{ t('review.failed') }}</b>
        <div class="mt-1 font-mono text-xs">{{ d.analysisError }}</div>
      </div>
      <div v-else-if="d.analysis && !isOpen(d.id, i)" class="gym-note flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          ><b class="tabular-nums">{{ d.analysis.counts.accept }}</b> {{ t('verdict.accept') }} ·
          <b class="tabular-nums">{{ d.analysis.counts.review }}</b> {{ t('verdict.review') }} ·
          <b class="tabular-nums">{{ d.analysis.counts.reject }}</b> {{ t('verdict.reject') }}</span
        >
      </div>
      <CriticsSummaryView
        v-else-if="d.analysis"
        :analysis="d.analysis"
        :report-url="gymApi.datasetReportUrl(tenantId, d.id)"
        :tenant-id="isEvaluation ? undefined : tenantId"
        :dataset-id="d.id"
        @changed="reloadBlock"
        @error="fail"
      />
    </section>

    <!-- the AI's advice on what to record again, asked for on demand -->
    <section class="gym-note mt-6">
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-surface-900 dark:text-surface-0">{{ t('review.followUpTitle') }}</b>
        <Pill v-if="block.followUp" :tone="block.followUp.source === 'ai' ? 'accent' : 'neutral'">{{
          t(`plan.source.${block.followUp.source}`)
        }}</Pill>
        <span class="grow"></span>
        <SecondaryButton
          size="small"
          :disabled="busy === 'follow' || !block.datasets.some((d) => d.analysisStatus === 'done')"
          :loading="busy === 'follow'"
          :label="busy === 'follow' ? t('app.loading') : block.followUp ? t('review.followUpAgain') : t('review.getFollowUp')"
          @click="followUp"
        />
      </div>
      <template v-if="block.followUp">
        <p class="mt-1.5">{{ block.followUp.summary }}</p>
        <ul class="mt-2 flex list-none flex-col gap-1 p-0">
          <li v-for="(it, i) in block.followUp.items" :key="i">
            <b class="text-surface-900 tabular-nums dark:text-surface-0">{{ it.episodes }} ×</b>
            {{ it.title }}
            <span class="text-xs text-surface-500 dark:text-surface-400">{{ it.reason }}</span>
          </li>
        </ul>
      </template>
      <p v-else class="mt-1 text-xs text-surface-500 dark:text-surface-400">
        {{ gym.ai.enabled ? t('review.followUpLead') : t('brief.aiOff') }}
      </p>
    </section>

    <div class="gym-stepnav">
      <SecondaryButton :label="t('review.backToUpload')" @click="toUpload" />
      <span class="grow"></span>
      <!-- the suggested way on is the filled button; the other stays one click away -->
      <component
        :is="verdict.more ? Button : SecondaryButton"
        :label="isEvaluation ? t('review.runMore') : t('review.recordMore')"
        @click="recordMore"
      />
      <component
        :is="verdict.more ? SecondaryButton : Button"
        :label="isEvaluation ? t('review.closeBlock') : t('review.select')"
        @click="isEvaluation ? closeBlock() : toSelection()"
      />
    </div>
  </div>
</template>
