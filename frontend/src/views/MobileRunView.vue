<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { publicApi } from '@/api/gym'
import type { MobileState } from '@/types/gym'
import { activeStep, currentVariation, percentDone, planTotal, progressTotal, stepDone } from '@/utils/plan'
import RunList from '@/components/RunList.vue'

/** The recording run on a phone or tablet at the cell: what to do now, one big "next". */
const route = useRoute()
const { t } = useI18n()
const token = computed(() => String(route.params.token))
const state = ref<MobileState | null>(null)
const error = ref('')
const busy = ref(false)

async function load() {
  try {
    state.value = await publicApi.mobile(token.value)
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await load()
  timer = setInterval(load, 5000)
})
onBeforeUnmount(() => clearInterval(timer))

const plan = computed(() => state.value?.plan ?? null)
const total = computed(() => planTotal(plan.value))
const done = computed(() => progressTotal(state.value?.progress))
const current = computed(() => (plan.value ? activeStep(plan.value, state.value?.progress) : null))
const variation = computed(() =>
  current.value ? currentVariation(current.value, stepDone(state.value?.progress, current.value)) : null,
)

/** the picture of the variation to build now, when the plan carries one */
const currentImage = computed(() => {
  const step = current.value
  const index = variation.value?.index
  const image = index != null ? step?.variations[index]?.image : null
  return step && image ? publicApi.mobileVariationImageUrl(token.value, step.id, index!) : ''
})
const imageUrl = (stepId: string, index: number) => publicApi.mobileVariationImageUrl(token.value, stepId, index)

/** the step "undo" takes the episode back from */
const undoStepId = computed(
  () =>
    plan.value?.steps.find(
      (s) =>
        (state.value?.progress?.completed[s.id] ?? 0) > 0 &&
        (!current.value || s.id === current.value.id || stepDone(state.value?.progress, s) >= s.episodes),
    )?.id,
)

/** a tap on a step of the list: work on it next */
async function select(stepId: string) {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await publicApi.currentStep(token.value, stepId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function count(delta: number, stepId?: string) {
  const id = stepId ?? current.value?.id
  if (!id) return
  busy.value = true
  try {
    state.value = await publicApi.progress(token.value, id, delta)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 px-4 py-5 pb-28">
    <div v-if="error" class="gym-note border-s-bad">
      {{ t('mobile.invalid') }}
      <div class="mt-1 font-mono text-xs">{{ error }}</div>
    </div>
    <div v-else-if="!state" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <div v-else-if="!plan" class="gym-note border-s-warn">
      {{ t('mobile.run.noPlan') }}
    </div>

    <template v-else>
      <h1 class="font-display text-xl font-bold">
        {{ state.cellName }} · {{ state.kind === 'evaluation' ? t('mobile.run.titleEvaluation') : t('mobile.run.title') }}
      </h1>
      <span class="-mt-3 text-sm text-surface-500 dark:text-surface-400">{{ state.skillName }}</span>

      <div class="gym-panel flex flex-col gap-3 p-4">
        <span class="font-display text-4xl leading-none font-semibold tabular-nums"
          >{{ done }}<small class="text-base text-surface-500"> / {{ total }}</small></span
        >
        <div class="h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
          <i
            class="bg-primary block h-full rounded-full transition-[width]"
            :style="{ width: `${percentDone(done, total)}%` }"
          ></i>
        </div>

        <template v-if="current && variation">
          <h2 class="font-display flex items-center gap-2 text-base font-semibold">
            <span class="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 font-mono text-xs">{{ t('mobile.run.now') }}</span>
            {{ current.title }}
          </h2>
          <p v-if="current.instructions" class="text-surface-600 dark:text-surface-300">
            {{ current.instructions }}
          </p>
          <div class="border-primary text-primary flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
            <span class="grow">{{ current.variations[variation.index]?.label }}</span>
            <span class="tabular-nums"
              >{{ variation.doneInVariation }} / {{ current.variations[variation.index]?.episodes }}</span
            >
          </div>
          <img
            v-if="currentImage"
            class="w-full rounded-panel border border-surface-300 dark:border-surface-700"
            :src="currentImage"
            alt=""
          />
        </template>
        <h2 v-else class="font-display flex items-center gap-2 text-base font-semibold">
          <span class="bg-ok-soft text-ok rounded-md px-1.5 py-0.5 font-mono text-xs">✓</span>
          {{ t('recording.allDone') }}
        </h2>
      </div>

      <RunList :plan="plan" :progress="state.progress" :image-url="imageUrl" compact @select="select" />

      <div class="gym-actions">
        <div class="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Button
            size="large"
            class="grow"
            :disabled="busy || !current"
            :label="state.kind === 'evaluation' ? t('mobile.run.nextRollout') : t('mobile.run.next')"
            @click="count(1)"
          />
          <SecondaryButton size="large" :disabled="busy || !done" :label="t('recording.undo')" @click="count(-1, undoStepId)" />
        </div>
      </div>
    </template>
  </div>
</template>
