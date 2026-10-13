<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import type { AccessTokenInfo, BlockView, DayView } from '@/types/gym'
import { activeStep, currentVariation, percentDone, planTotal, progressTotal, stepDone } from '@/utils/plan'
import { fmtMinutes, fmtTime } from '@/utils/time'
import QrCode from '@/components/QrCode.vue'
import RunList from '@/components/RunList.vue'
import IconTrash from '~icons/carbon/trash-can'
import IconChevron from '~icons/carbon/chevron-right'

/**
 * Step 3: teleoperation runs, or the policy under evaluation. The QR code
 * opens the run view on a phone or tablet at the cell; the same list works
 * here. "Next" counts one episode (one rollout). The downtimes belong to the
 * day protocol, not to the block: the cell stood still, whatever ran in it.
 */
const props = defineProps<{
  block: BlockView
  tenantId: string
  /** only looked at from the step guide: nothing counts, no key listens */
  readonly?: boolean
}>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t } = useI18n()

const isEvaluation = computed(() => props.block.kind === 'evaluation')
const token = ref<AccessTokenInfo | null>(null)
const runUrl = computed(() => (token.value ? `${window.location.origin}${token.value.paths.run}` : ''))
const day = ref<DayView | null>(null)
onMounted(async () => {
  try {
    token.value = await gymApi.accessToken(props.tenantId, props.block.id)
    day.value = await gymApi.day(props.tenantId, props.block.dayProtocolId)
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
})

const plan = computed(() => props.block.plan!)
const total = computed(() => planTotal(plan.value))
const done = computed(() => progressTotal(props.block.progress))
const current = computed(() => activeStep(plan.value, props.block.progress))
const variation = computed(() =>
  current.value ? currentVariation(current.value, stepDone(props.block.progress, current.value)) : null,
)

/** the picture of the variation the operator should build now, when there is one */
const currentImage = computed(() => {
  const step = current.value
  const index = variation.value?.index
  const image = index != null ? step?.variations[index]?.image : null
  return step && image
    ? {
        url: gymApi.variationImageUrl(props.tenantId, props.block.id, step.id, index!, image.ref),
        label: step.variations[index!]?.label ?? '',
      }
    : null
})
const imageUrl = (stepId: string, index: number, ref: string) =>
  gymApi.variationImageUrl(props.tenantId, props.block.id, stepId, index, ref)

/** the step "undo" takes the episode back from: the current one, else the last one with a count */
const undoStepId = computed(
  () =>
    plan.value.steps.find(
      (s) =>
        (props.block.progress?.completed[s.id] ?? 0) > 0 &&
        (!current.value || s.id === current.value.id || stepDone(props.block.progress, s) >= s.episodes),
    )?.id,
)

/**
 * The teleoperation time runs while this step is open, so the figure has to
 * move: the server counts the open window up to now, and a tick every ten
 * seconds is enough to see it doing that.
 */
const tick = ref(0)
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => (tick.value += 1), 10_000)
})
onUnmounted(() => window.clearInterval(timer))

/**
 * The space bar counts like "Next": the operator's hands are on the teleop
 * rig, not on the mouse. Not while a field or a button has the focus, where
 * the key means what it always means.
 */
function onKey(ev: KeyboardEvent) {
  if (props.readonly || ev.key !== ' ' || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return
  const el = ev.target as HTMLElement | null
  if (el?.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]')) return
  ev.preventDefault()
  if (!busy.value && current.value) void count(1)
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

const downtimeOpen = ref(false)

const teleopMinutes = computed(() => {
  void tick.value
  const times = props.block.times
  if (!times.teleopRunning) return times.teleopMinutes
  const open = props.block.teleopIntervals.find((i) => !i.endedAt)
  if (!open) return times.teleopMinutes
  // the server's figure was taken when the day was loaded; add what has passed since
  const since = (Date.now() - new Date(open.startedAt).getTime()) / 60_000
  const counted = props.block.teleopIntervals
    .filter((i) => i.endedAt)
    .reduce((a, i) => a + (new Date(i.endedAt!).getTime() - new Date(i.startedAt).getTime()) / 60_000, 0)
  return Math.max(times.teleopMinutes, Math.round(counted + since))
})

// ---------------------------------------------------------------------------
// Downtime
// ---------------------------------------------------------------------------

/**
 * A cell that stands still leaves no trace in the tool, so the operator says
 * it: a reason and a number of minutes, written down while it is still fresh.
 */
const downtimeReason = ref('')
const downtimeMinutes = ref<number | null>(null)
const savingDowntime = ref(false)
const canAddDowntime = computed(() => downtimeReason.value.trim().length > 0 && (downtimeMinutes.value ?? 0) > 0)

async function addDowntime() {
  if (!canAddDowntime.value || savingDowntime.value) return
  savingDowntime.value = true
  try {
    day.value = await gymApi.addDowntime(props.tenantId, props.block.dayProtocolId, {
      reason: downtimeReason.value.trim(),
      minutes: Math.round(downtimeMinutes.value!),
    })
    downtimeReason.value = ''
    downtimeMinutes.value = null
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    savingDowntime.value = false
  }
}

async function removeDowntime(eventId: string) {
  try {
    day.value = await gymApi.removeDowntime(props.tenantId, props.block.dayProtocolId, eventId)
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

const busy = ref(false)
async function count(delta: number, stepId?: string) {
  const id = stepId ?? current.value?.id ?? plan.value.steps[plan.value.steps.length - 1]?.id
  if (!id) return
  busy.value = true
  try {
    emit('update', await gymApi.progress(props.tenantId, props.block.id, id, delta))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
/**
 * Set where the current step stands, typed: after the counting was forgotten
 * for a while, or to skip ahead, instead of a run of +1. The server takes the
 * difference, like any other count.
 */
const currentDone = computed(() => (current.value ? stepDone(props.block.progress, current.value) : 0))
function setCurrentCount(ev: Event) {
  const input = ev.target as HTMLInputElement
  const step = current.value
  const wanted = Math.round(Number(input.value))
  if (!step || input.value.trim() === '' || Number.isNaN(wanted)) {
    input.value = String(currentDone.value)
    return
  }
  const next = Math.max(0, Math.min(step.episodes, wanted))
  input.value = String(next)
  if (next !== currentDone.value) void count(next - currentDone.value, step.id)
}

/** The operator picks a step from the list: "next" counts on it from now on. */
async function select(stepId: string) {
  if (busy.value || props.readonly) return
  busy.value = true
  try {
    emit('update', await gymApi.currentStep(props.tenantId, props.block.id, stepId))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
/** Back to the plan. The open window closes with the step, so the clock stops. */
async function back() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'plan'))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

async function finish() {
  try {
    emit('update', await gymApi.finishRecording(props.tenantId, props.block.id))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ isEvaluation ? t('recording.titleEvaluation') : t('recording.title') }}
    </h2>
    <p class="mt-1 mb-4 text-surface-600 dark:text-surface-300">
      {{ isEvaluation ? t('recording.leadEvaluation') : t('recording.lead') }}
    </p>

    <div class="grid gap-5 md:grid-cols-2">
      <div class="flex flex-col gap-4">
        <!-- what to do now and the one button for it: the centre of the step -->
        <div class="rounded-panel border-2 border-primary bg-primary/5 p-4">
          <div class="flex items-baseline justify-between gap-3">
            <span class="gym-field">{{ t('recording.current') }}</span>
            <span class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400" role="status"
              >{{ done }} / {{ total }}</span
            >
          </div>
          <div class="font-display text-2xl leading-tight font-semibold">
            {{ current ? current.title : t('recording.allDone') }}
          </div>
          <div v-if="current && variation" class="mt-0.5 text-sm text-surface-600 dark:text-surface-300">
            {{ current.variations[variation.index]?.label }}
            <span class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400"
              >· {{ variation.doneInVariation }} / {{ current.variations[variation.index]?.episodes }}</span
            >
          </div>
          <div class="mt-3 h-2 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
            <i
              class="block h-full rounded-full transition-[width]"
              :class="current ? 'bg-primary' : 'bg-ok'"
              :style="{ width: `${percentDone(done, total)}%` }"
            ></i>
          </div>
          <figure v-if="currentImage" class="m-0 mt-3">
            <img
              class="max-h-64 w-full rounded-panel border border-surface-300 object-cover dark:border-surface-800"
              :src="currentImage.url"
              alt=""
            />
            <figcaption class="mt-1 text-xs text-surface-500 dark:text-surface-400">{{ t('recording.targetImage') }}</figcaption>
          </figure>
          <Button
            class="mt-4 w-full"
            size="large"
            :disabled="busy || !current"
            :label="isEvaluation ? t('recording.nextRollout') : t('recording.next')"
            @click="count(1)"
          />
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <SecondaryButton size="small" :disabled="busy || !done" :label="t('recording.undo')" @click="count(-1, undoStepId)" />
            <label v-if="current" class="flex items-center gap-1.5 text-xs text-surface-600 dark:text-surface-300">
              {{ t('recording.position') }}
              <input
                :key="`${current.id}:${currentDone}`"
                type="number"
                inputmode="numeric"
                :min="0"
                :max="current.episodes"
                :value="currentDone"
                :disabled="busy"
                class="w-16 rounded-md border border-surface-300 bg-surface-0 px-2 py-1 text-end text-sm tabular-nums focus:border-primary focus:outline-none dark:border-surface-700 dark:bg-surface-900"
                :aria-label="t('recording.setCount', { step: current.title })"
                :title="t('recording.setCountHint')"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                @change="setCurrentCount"
              />
              <span class="font-mono tabular-nums">/ {{ current.episodes }}</span>
            </label>
            <span class="grow"></span>
            <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('recording.spaceHint') }}</span>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-[auto_1fr]">
          <KpiTile
            class="sm:min-w-44"
            :label="isEvaluation ? t('recording.evaluationTime') : t('recording.teleopTime')"
            :value="fmtMinutes(teleopMinutes)"
            :sub="
              block.times.teleopRunning
                ? t('recording.teleopRunning', { since: fmtTime(block.teleopStartedAt) })
                : t('recording.teleopWindows', { n: block.times.teleopSessions })
            "
            small
          />
          <!-- the same counting on a phone or tablet at the cell -->
          <div class="gym-panel flex items-center gap-3 p-2.5">
            <a v-if="runUrl" :href="runUrl" target="_blank" rel="noopener" class="shrink-0" :title="runUrl">
              <QrCode :url="runUrl" :size="88" :caption="false" />
            </a>
            <div class="min-w-0 text-sm">
              <b class="block font-semibold">{{ t('recording.phone') }}</b>
              <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('recording.scanHint') }}</span>
              <span class="mt-1 flex items-center gap-1.5 text-xs text-surface-500 dark:text-surface-400">
                <i class="bg-ok size-2 animate-pulse rounded-full" aria-hidden="true"></i>{{ t('recording.live') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <span class="gym-field">{{ t('recording.steps') }}</span>
        <RunList
          :plan="plan"
          :progress="block.progress"
          :image-url="imageUrl"
          @count="(stepId, delta) => count(delta, stepId)"
          @select="select"
        />
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('recording.selectStep') }}</span>
      </div>
    </div>

    <!-- the downtimes belong to the day; folded away until a standstill has to be written down -->
    <section class="mt-5 rounded-panel border border-surface-300 dark:border-surface-800">
      <button
        type="button"
        class="flex w-full cursor-pointer flex-wrap items-center gap-2 px-3.5 py-2.5 text-start"
        :aria-expanded="downtimeOpen"
        @click="downtimeOpen = !downtimeOpen"
      >
        <IconChevron class="size-4 transition-transform" :class="downtimeOpen ? 'rotate-90' : ''" aria-hidden="true" />
        <b class="text-sm font-semibold">{{ t('recording.downtime') }}</b>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{
          day && day.downtime.length
            ? t('recording.downtimeSum', { n: day.downtime.length, time: fmtMinutes(day.times.downtimeMinutes) })
            : t('recording.downtimeNone')
        }}</span>
        <span class="grow"></span>
        <span v-if="!downtimeOpen" class="text-primary text-sm">{{ t('recording.downtimeAdd') }}</span>
      </button>
      <div v-if="downtimeOpen" class="border-t border-surface-200 px-3.5 pt-3 pb-3.5 dark:border-surface-800">
        <p class="mb-3 text-xs text-surface-500 dark:text-surface-400">{{ t('recording.downtimeHint') }}</p>
        <div class="flex flex-wrap items-end gap-3">
          <FormField class="min-w-56 grow" :label="t('recording.downtimeReason')">
            <InputText v-model="downtimeReason" fluid :placeholder="t('recording.downtimeExample')" @keyup.enter="addDowntime" />
          </FormField>
          <FormField class="w-32" :label="t('recording.downtimeMinutes')">
            <NumberInput v-model="downtimeMinutes" fluid :min="1" :max="1440" @keyup.enter="addDowntime" />
          </FormField>
          <Button
            class="mb-0.5"
            :disabled="!canAddDowntime || savingDowntime"
            :label="t('recording.downtimeAdd')"
            @click="addDowntime"
          />
        </div>

        <div v-if="day && day.downtime.length" class="gym-panel mt-3 overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('recording.downtimeAt') }}</th>
                <th>{{ t('recording.downtimeReason') }}</th>
                <th class="num">{{ t('recording.downtimeMinutes') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in day.downtime" :key="d.id">
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtTime(d.at) }}</td>
                <td>{{ d.reason }}</td>
                <td class="num whitespace-nowrap">{{ fmtMinutes(d.minutes) }}</td>
                <td class="w-10">
                  <button
                    type="button"
                    class="text-bad cursor-pointer p-1 hover:opacity-70"
                    :title="t('recording.downtimeRemove')"
                    :aria-label="t('recording.downtimeRemove')"
                    @click="removeDowntime(d.id)"
                  >
                    <IconTrash class="size-4" />
                  </button>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="2" class="font-semibold">{{ t('recording.downtimeTotal') }}</td>
                <td class="num font-semibold whitespace-nowrap">{{ fmtMinutes(day.times.downtimeMinutes) }}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>

    <div class="gym-stepnav">
      <SecondaryButton :label="t('recording.backToPlan')" @click="back" />
      <span class="grow"></span>
      <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('recording.finishHint') }}</span>
      <Button :label="isEvaluation ? t('recording.finishEvaluation') : t('recording.finish')" @click="finish" />
    </div>
  </div>
</template>
