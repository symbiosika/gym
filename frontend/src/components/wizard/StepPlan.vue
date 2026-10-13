<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import type { BlockView, Lang, RecordingPlan } from '@/types/gym'
import PlanEditor from '@/components/PlanEditor.vue'
import { planTotal, planVariations, variationsWithImage } from '@/utils/plan'
import IconCheck from '~icons/carbon/checkmark'

/** Step 2: the AI's plan, editable, then "start recording" (or "start the evaluation"). */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t, locale } = useI18n()
const gym = useGym()
const dialog = useDialog()

const clone = (p: RecordingPlan): RecordingPlan => JSON.parse(JSON.stringify(p))
const plan = ref<RecordingPlan>(clone(props.block.plan!))
const busy = ref('')
const fail = (e: unknown) => emit('error', e instanceof Error ? e.message : String(e))

const toInput = (p: RecordingPlan) => ({
  summary: p.summary,
  sceneSetup: p.sceneSetup,
  randomizations: p.randomizations,
  steps: p.steps.map((s) => ({
    id: s.id.startsWith('local-') ? undefined : s.id,
    title: s.title,
    instructions: s.instructions,
    // the picture stays with the variation; only its file id travels back
    variations: s.variations.map((v) => ({
      label: v.label,
      episodes: v.episodes,
      imagePrompt: v.imagePrompt ?? '',
      image: v.image ? { ref: v.image.ref } : null,
    })),
  })),
})

/*
 * The plan saves itself: every edit is sent a moment after the last keystroke,
 * and before anything leaves the step. What the server holds is kept as a
 * snapshot; the editor is dirty while it differs from it.
 */
const snapshot = (p: RecordingPlan) => JSON.stringify(toInput(p))
const saved = ref(snapshot(plan.value))
const dirty = computed(() => snapshot(plan.value) !== saved.value)
const saving = ref(false)
/** a plan taken over whole from the server (proposal, image action): nothing left to save */
function adopt(p: RecordingPlan) {
  plan.value = clone(p)
  saved.value = snapshot(plan.value)
}
/** The server takes a step or a variation only with a name: until then there is nothing to send on its own. */
const complete = computed(() => plan.value.steps.every((s) => s.title.trim() && s.variations.every((v) => v.label.trim())))

let timer: ReturnType<typeof setTimeout> | undefined
watch(
  plan,
  () => {
    clearTimeout(timer)
    if (complete.value) timer = setTimeout(() => void save(), 1000)
  },
  { deep: true },
)
onBeforeUnmount(() => {
  clearTimeout(timer)
  void save()
})

let inflight: Promise<boolean> | null = null
async function save(): Promise<boolean> {
  clearTimeout(timer)
  if (inflight) await inflight
  if (!dirty.value) return true
  inflight = send()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}
async function send(): Promise<boolean> {
  const sent = toInput(plan.value)
  saving.value = true
  try {
    const next = await gymApi.updatePlan(props.tenantId, props.block.id, sent)
    // new steps get their ids from the server; what was typed meanwhile stays as it is
    const stored = next.plan!.steps
    if (stored.length === plan.value.steps.length) {
      plan.value.steps.forEach((s, i) => {
        if (s.id.startsWith('local-')) s.id = stored[i]!.id
      })
    }
    if (stored.length === sent.steps.length) sent.steps.forEach((s, i) => (s.id = stored[i]!.id))
    saved.value = JSON.stringify(sent)
    emit('update', next)
    return true
  } catch (e) {
    fail(e)
    return false
  } finally {
    saving.value = false
  }
}
/** A new proposal replaces the plan, the edits with it: asked first. */
async function regenerate() {
  if (!(await dialog.confirm({ title: t('plan.regenerateConfirm'), text: t('plan.regenerateText'), ok: t('plan.regenerate') })))
    return
  clearTimeout(timer)
  busy.value = 'gen'
  try {
    const next = await gymApi.generatePlan(props.tenantId, props.block.id, locale.value as Lang)
    adopt(next.plan!)
    emit('update', next)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
/** Back to the scene: the plan is saved on the way, so nothing typed is lost. */
async function back() {
  busy.value = 'back'
  if (await save()) {
    try {
      emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'brief'))
    } catch (e) {
      fail(e)
    }
  }
  busy.value = ''
}

async function start() {
  busy.value = 'start'
  if (await save()) {
    try {
      emit('update', await gymApi.startRecording(props.tenantId, props.block.id))
    } catch (e) {
      fail(e)
    }
  }
  busy.value = ''
}

/* ---- reference images of the variations, all optional -------------------- */

/** The model needs a key and a scene photo; uploads work without both. */
const imagesEnabled = computed(() => gym.ai.imageEnabled && props.block.hasSceneImage)
const variations = computed(() => planVariations(plan.value))
const withImage = computed(() => variationsWithImage(plan.value))
const busyImage = ref('')
/** how far a run over all variations without a picture has come */
const bulk = ref<{ done: number; total: number } | null>(null)
const cancelBulk = ref(false)
const imageUrl = (stepId: string, index: number, ref: string) =>
  gymApi.variationImageUrl(props.tenantId, props.block.id, stepId, index, ref)

/** Indexes are the ones the server knows, so the plan is saved before every image call. */
async function imageAction(
  action: 'generate' | 'upload' | 'scene' | 'remove',
  stepIndex: number,
  variationIndex: number,
  file?: File,
): Promise<boolean> {
  if (!(await save())) return false
  const stepId = plan.value.steps[stepIndex]?.id
  if (!stepId) return false
  busyImage.value = `${stepIndex}:${variationIndex}`
  try {
    const call =
      action === 'generate'
        ? gymApi.generateVariationImage(props.tenantId, props.block.id, stepId, variationIndex)
        : action === 'upload'
          ? gymApi.uploadVariationImage(props.tenantId, props.block.id, stepId, variationIndex, file!)
          : action === 'scene'
            ? gymApi.variationImageFromScene(props.tenantId, props.block.id, stepId, variationIndex)
            : gymApi.removeVariationImage(props.tenantId, props.block.id, stepId, variationIndex)
    const next = await call
    adopt(next.plan!)
    emit('update', next)
    return true
  } catch (e) {
    fail(e)
    return false
  } finally {
    busyImage.value = ''
  }
}

/** One picture per variation that has none; stops at the first failure. */
async function generateMissing() {
  const todo = variations.value.filter((x) => !x.variation.image)
  if (!todo.length || bulk.value) return
  cancelBulk.value = false
  bulk.value = { done: 0, total: todo.length }
  for (const x of todo) {
    if (cancelBulk.value) break
    if (!(await imageAction('generate', x.stepIndex, x.variationIndex))) break
    bulk.value = { done: bulk.value.done + 1, total: todo.length }
  }
  bulk.value = null
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ block.kind === 'evaluation' ? t('plan.titleEvaluation') : t('plan.title') }}
    </h2>
    <p class="mt-1 mb-4 flex flex-wrap items-center gap-2 text-surface-600 dark:text-surface-300">
      {{
        block.plan?.source === 'plain'
          ? t('plan.leadPlain')
          : block.kind === 'evaluation'
            ? t('plan.leadEvaluation')
            : t('plan.lead')
      }}
      <Pill :tone="block.plan?.source === 'ai' ? 'accent' : 'neutral'">{{
        t(`plan.source.${block.plan?.source ?? 'manual'}`)
      }}</Pill>
    </p>

    <PlanEditor
      v-model="plan"
      :target="block.targetEpisodes"
      :images-enabled="imagesEnabled"
      :busy-image="busyImage"
      :image-url="imageUrl"
      @image="imageAction"
    />

    <div
      class="mt-5 flex flex-wrap items-center gap-3 rounded-panel border border-surface-300 bg-surface-50 px-3.5 py-3 dark:border-surface-800 dark:bg-surface-800/30"
    >
      <div class="min-w-0">
        <b class="block text-sm font-semibold">{{ t('plan.image.title') }}</b>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('plan.image.lead') }}</span>
      </div>
      <span class="grow"></span>
      <Pill>{{ t('plan.image.count', { n: withImage, total: variations.length }) }}</Pill>
      <SecondaryButton v-if="bulk" size="small" :label="t('plan.image.stop')" @click="cancelBulk = true" />
      <SecondaryButton
        v-else
        size="small"
        :disabled="!imagesEnabled || withImage === variations.length || !!busyImage"
        :label="t('plan.image.generateMissing')"
        @click="generateMissing"
      />
      <div v-if="bulk" class="h-1.5 w-full overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
        <i
          class="bg-primary block h-full rounded-full transition-[width]"
          :style="{
            width: `${Math.round((100 * bulk.done) / Math.max(1, bulk.total))}%`,
          }"
        ></i>
      </div>
      <p v-else-if="!gym.ai.imageEnabled" class="w-full text-xs text-surface-500 dark:text-surface-400">
        {{ t('plan.image.off') }}
      </p>
      <p v-else-if="!block.hasSceneImage" class="w-full text-xs text-surface-500 dark:text-surface-400">
        {{ t('plan.image.noScene') }}
      </p>
    </div>

    <div class="gym-stepnav">
      <SecondaryButton :disabled="!!busy" :label="t('app.back')" @click="back" />
      <SecondaryButton
        :disabled="busy === 'gen'"
        :loading="busy === 'gen'"
        :label="busy === 'gen' ? t('brief.creatingPlan') : t('plan.regenerate')"
        @click="regenerate"
      />
      <span class="grow"></span>
      <span
        class="flex items-center gap-1 font-mono text-xs"
        :class="saving || dirty ? 'text-surface-500 dark:text-surface-400' : 'text-ok'"
        role="status"
      >
        <template v-if="saving">{{ t('app.saving') }} …</template>
        <template v-else-if="dirty">{{ complete ? t('app.unsaved') : t('plan.incomplete') }}</template>
        <template v-else><IconCheck class="size-3.5" />{{ t('app.saved') }}</template>
      </span>
      <span class="text-xs text-surface-500 tabular-nums dark:text-surface-400">{{
        t('plan.total', { n: planTotal(plan) })
      }}</span>
      <Button
        :disabled="busy === 'start' || !plan.steps.length"
        :loading="busy === 'start'"
        :label="block.kind === 'evaluation' ? t('plan.startEvaluation') : t('plan.startRecording')"
        @click="start"
      />
    </div>
  </div>
</template>
