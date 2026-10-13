<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import type { BlockStep, BlockView } from '@/types/gym'
import { fmtDateLong, today } from '@/utils/time'
import WizardSteps from '@/components/WizardSteps.vue'
import StepBrief from '@/components/wizard/StepBrief.vue'
import StepPlan from '@/components/wizard/StepPlan.vue'
import StepRecording from '@/components/wizard/StepRecording.vue'
import StepUpload from '@/components/wizard/StepUpload.vue'
import StepReview from '@/components/wizard/StepReview.vue'
import StepSelection from '@/components/wizard/StepSelection.vue'
import StepClosed from '@/components/wizard/StepClosed.vue'

/**
 * The stateful wizard of one block. The current step comes from the server,
 * so a browser restart lands exactly where the operator left off. While the
 * phone is in use (brief, recording) the view polls for changes.
 */
const route = useRoute()
const { t, locale } = useI18n()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))
const blockId = computed(() => String(route.params.blockId))

const block = ref<BlockView | null>(null)
const loading = ref(true)
const error = ref('')

async function load() {
  try {
    block.value = await gymApi.block(tenantId.value, blockId.value)
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
const pollingSteps: BlockStep[] = ['brief', 'recording']
function schedulePolling() {
  clearInterval(timer)
  if (block.value && pollingSteps.includes(block.value.step) && document.visibilityState === 'visible') {
    timer = setInterval(load, 3000)
  }
}
watch(() => block.value?.step, schedulePolling)
watch(blockId, async () => {
  loading.value = true
  await load()
  schedulePolling()
})
const onVisibility = () => schedulePolling()
onMounted(async () => {
  await load()
  schedulePolling()
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibility)
})

/**
 * The heading of the wizard: the cell, said as a cell. Operator and date are
 * not repeated here; they belong to the day protocol.
 */
const cellTitle = computed(() => {
  const name = block.value?.cell.name ?? ''
  return /^(zelle|cell)\b/i.test(name) ? name : `${t('skill.cell')} ${name}`
})

/** The date only when the block is not today's: on the day itself it says nothing. */
const dateLabel = computed(() =>
  block.value && block.value.date !== today() ? fmtDateLong(block.value.date, locale.value) : undefined,
)

function onUpdate(next: BlockView) {
  block.value = next
}
function onError(message: string) {
  ui.showBanner('err', message)
}

const reachable = computed<BlockStep[]>(() => {
  const b = block.value
  if (!b) return []
  const out: BlockStep[] = ['brief']
  if (b.plan) out.push('plan', 'recording', 'upload')
  // an evaluation may run without a plan: one is made on the way
  else if (b.kind === 'evaluation') out.push('recording', 'upload')
  if (b.datasets.length) out.push('review')
  if (b.datasets.length && b.kind === 'recording') out.push('selection')
  return out
})

/*
 * The step guide only looks. A click on another step shows it read-only and
 * leaves the block where it is: no clock starts, nothing reopens. Moving the
 * block there is a second, explicit click ("continue here"), so going back to
 * look at the plan never counts as teleoperation time.
 */
const viewing = ref<BlockStep | null>(null)
watch(
  () => block.value?.step,
  () => (viewing.value = null),
)
const shown = computed<BlockStep | undefined>(() => viewing.value ?? block.value?.step)
const stepLabel = (step: BlockStep) => t(block.value?.kind === 'evaluation' ? `block.evalSteps.${step}` : `day.steps.${step}`)

function look(step: BlockStep) {
  viewing.value = step === block.value?.step ? null : step
}
const continueLabel = computed(() =>
  viewing.value === 'recording'
    ? block.value?.kind === 'evaluation'
      ? t('wizard.continueEvaluation')
      : t('wizard.continueRecording')
    : block.value?.step === 'closed'
      ? t('wizard.reopenHere')
      : t('wizard.continueHere'),
)
const moving = ref(false)
async function moveHere() {
  const b = block.value
  const step = viewing.value
  if (!b || !step) return
  moving.value = true
  try {
    block.value =
      step === 'recording' ? await gymApi.startRecording(tenantId.value, b.id) : await gymApi.setStep(tenantId.value, b.id, step)
    viewing.value = null
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e))
  } finally {
    moving.value = false
  }
}
</script>

<template>
  <div class="gym-wrap">
    <div v-if="loading" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <div v-else-if="error || !block" class="gym-note border-s-warn mt-6">
      {{ error || t('app.error.generic') }}
    </div>
    <template v-else>
      <PageTitle :title="cellTitle" :sub="dateLabel">
        <Pill :tone="block.kind === 'evaluation' ? 'warn' : 'accent'">{{ t(`block.kind.${block.kind}`) }}</Pill>
      </PageTitle>

      <div class="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-sm text-surface-600 dark:text-surface-300">
        <span
          ><span class="me-1.5 text-surface-500 dark:text-surface-400">{{ t('block.skill') }}</span
          ><b class="font-semibold text-surface-900 dark:text-surface-0">{{ block.skill.name }}</b></span
        >
        <span v-if="block.policy"
          ><span class="me-1.5 text-surface-500 dark:text-surface-400">{{ t('block.policy') }}</span
          ><b class="font-semibold text-surface-900 dark:text-surface-0">{{ block.policy.name }}</b></span
        >
        <span v-if="block.targetEpisodes != null"
          ><span class="me-1.5 text-surface-500 dark:text-surface-400">{{ t('day.target') }}</span
          ><b class="font-semibold text-surface-900 tabular-nums dark:text-surface-0">{{ block.targetEpisodes }}</b></span
        >
        <span v-if="block.totals.episodes"
          ><span class="me-1.5 text-surface-500 dark:text-surface-400">{{
            block.kind === 'evaluation' ? t('block.succeeded') : t('day.recorded')
          }}</span
          ><b class="font-semibold text-surface-900 tabular-nums dark:text-surface-0"
            >{{ block.totals.accepted }} / {{ block.totals.episodes }}</b
          ></span
        >
      </div>

      <WizardSteps :current="block.step" :viewing="viewing" :reachable="reachable" :kind="block.kind" @go="look" />

      <!-- looking at another step: said plainly, with the way back and the explicit move -->
      <div
        v-if="viewing"
        class="gym-note border-s-warn sticky top-16 z-30 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 shadow-panel"
        role="status"
      >
        <span class="min-w-0 grow">
          <b class="text-surface-900 dark:text-surface-0">{{ t('wizard.viewing', { step: stepLabel(viewing) }) }}</b>
          {{ t('wizard.viewingHint', { step: stepLabel(block.step) }) }}
          <template v-if="viewing === 'recording'"> {{ t('wizard.clockHint') }}</template>
        </span>
        <SecondaryButton size="small" :label="t('wizard.backTo', { step: stepLabel(block.step) })" @click="viewing = null" />
        <Button size="small" :loading="moving" :disabled="moving" :label="continueLabel" @click="moveHere" />
      </div>

      <!-- a step that is only looked at is read-only: its buttons and fields are off -->
      <fieldset :disabled="!!viewing" class="m-0 min-w-0 border-0 p-0" :class="viewing ? 'opacity-80' : ''">
        <StepBrief v-if="shown === 'brief'" :block="block" :tenant-id="tenantId" @update="onUpdate" @error="onError" />
        <StepPlan v-else-if="shown === 'plan'" :block="block" :tenant-id="tenantId" @update="onUpdate" @error="onError" />
        <StepRecording
          v-else-if="shown === 'recording' && block.plan"
          :readonly="!!viewing"
          :block="block"
          :tenant-id="tenantId"
          @update="onUpdate"
          @error="onError"
        />
        <StepUpload v-else-if="shown === 'upload'" :block="block" :tenant-id="tenantId" @update="onUpdate" @error="onError" />
        <StepReview v-else-if="shown === 'review'" :block="block" :tenant-id="tenantId" @update="onUpdate" @error="onError" />
        <StepSelection
          v-else-if="shown === 'selection'"
          :block="block"
          :tenant-id="tenantId"
          @update="onUpdate"
          @error="onError"
        />
        <StepClosed v-else-if="shown === 'closed'" :block="block" :tenant-id="tenantId" @update="onUpdate" @error="onError" />
        <!-- an evaluation without a plan gets its one-step plan when it starts; there is nothing to look at yet -->
        <div v-else class="gym-stepbox">
          <div class="gym-empty">{{ t('wizard.noPlanYet') }}</div>
        </div>
      </fieldset>
    </template>
  </div>
</template>
