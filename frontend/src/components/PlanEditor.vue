<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlanVariation, RecordingPlan } from '@/types/gym'
import { duplicateStep, planTotal, rebalanceToTarget } from '@/utils/plan'
import IconAdd from '~icons/carbon/add'
import IconClose from '~icons/carbon/close'
import IconCopy from '~icons/carbon/copy'

/**
 * Edits a recording plan in place: summary, setup notes, steps and their
 * variations. Every variation may carry a reference image; the picture itself
 * lives on the server, so the editor only asks for an action and the parent
 * (StepPlan) saves the plan first and then calls the API.
 */
const plan = defineModel<RecordingPlan>({ required: true })
const props = defineProps<{
  target: number | null
  /** the image model is configured and a scene photo exists */
  imagesEnabled?: boolean
  /** which variation the server is working on, as `stepIndex:variationIndex` */
  busyImage?: string
  /** url of the reference image of a variation, when there is one */
  imageUrl?: (stepId: string, index: number, ref: string) => string
}>()
const emit = defineEmits<{
  image: [action: 'generate' | 'upload' | 'scene' | 'remove', stepIndex: number, variationIndex: number, file?: File]
}>()
const { t } = useI18n()

const total = computed(() => planTotal(plan.value))
const mismatch = computed(() => props.target != null && total.value !== props.target)

let seq = 0
const newId = () => `local-${Date.now().toString(36)}-${(seq++).toString(36)}`

function addStep() {
  plan.value.steps.push({
    id: newId(),
    title: '',
    instructions: '',
    variations: [{ label: '', episodes: 10 }],
    episodes: 10,
  })
}
function removeStep(i: number) {
  plan.value.steps.splice(i, 1)
}
/**
 * The copies made here, by their local id: which stored step they came from.
 * The server addresses a picture by step id and index, so until the plan is
 * saved a copy shows the pictures of its original.
 */
const copiedFrom = new Map<string, string>()
function duplicate(i: number) {
  const copy = duplicateStep(plan.value, i, newId())
  if (!copy) return
  copiedFrom.set(copy.id, plan.value.steps[i]!.id)
  openImage.value = ''
}
const storedStepId = (id: string): string => (copiedFrom.has(id) ? storedStepId(copiedFrom.get(id)!) : id)
function addVariation(i: number) {
  plan.value.steps[i]!.variations.push({ label: '', episodes: 10 })
}
function removeVariation(i: number, j: number) {
  plan.value.steps[i]!.variations.splice(j, 1)
}
function rebalance() {
  if (props.target != null) rebalanceToTarget(plan.value, props.target)
}
const listText = (arr: string[]) => arr.join('\n')
const setList = (key: 'sceneSetup' | 'randomizations', text: string) => {
  plan.value[key] = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// the image panel of one variation, open one at a time
const openImage = ref('')
const key = (i: number, j: number) => `${i}:${j}`
const toggleImage = (i: number, j: number) => (openImage.value = openImage.value === key(i, j) ? '' : key(i, j))
const src = (stepId: string, j: number, v: PlanVariation) =>
  v.image && props.imageUrl ? props.imageUrl(storedStepId(stepId), j, v.image.ref) : ''

const fileInput = ref<HTMLInputElement | null>(null)
const pending = ref<[number, number] | null>(null)
function pickFile(i: number, j: number) {
  pending.value = [i, j]
  fileInput.value?.click()
}
function fileChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && pending.value) emit('image', 'upload', pending.value[0], pending.value[1], file)
  input.value = ''
  pending.value = null
}
</script>

<template>
  <FormField :label="t('plan.summary')">
    <InputText v-model="plan.summary" fluid />
  </FormField>

  <div class="mt-3 grid gap-4 sm:grid-cols-2">
    <FormField :label="t('plan.sceneSetup')" :hint="t('plan.onePerLine')">
      <Textarea
        :value="listText(plan.sceneSetup)"
        rows="3"
        fluid
        @change="setList('sceneSetup', ($event.target as HTMLTextAreaElement).value)"
      />
    </FormField>
    <FormField :label="t('plan.randomizations')" :hint="t('plan.onePerLine')">
      <Textarea
        :value="listText(plan.randomizations)"
        rows="3"
        fluid
        @change="setList('randomizations', ($event.target as HTMLTextAreaElement).value)"
      />
    </FormField>
  </div>

  <SectionHeader class="mt-6" :n="t('plan.steps')" :title="t('plan.stepsTitle')">
    <span class="text-sm" :class="mismatch ? 'text-bad font-semibold' : 'text-surface-500 dark:text-surface-400'">
      {{ t('plan.total', { n: total }) }}
      <template v-if="target != null"> · {{ t('plan.target', { n: target }) }}</template>
    </span>
    <SecondaryButton v-if="mismatch" size="small" :label="t('plan.rebalance')" @click="rebalance" />
  </SectionHeader>

  <input ref="fileInput" type="file" accept="image/*" hidden @change="fileChosen" />

  <div
    v-for="(s, i) in plan.steps"
    :key="i"
    class="mb-3 rounded-panel border border-surface-300 bg-surface-50 p-3.5 dark:border-surface-800 dark:bg-surface-800/30"
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <FormField :label="`${t('plan.step')} ${i + 1}`">
        <InputText v-model="s.title" fluid :placeholder="t('plan.stepPlaceholder')" />
      </FormField>
      <FormField :label="t('plan.instructions')">
        <InputText v-model="s.instructions" fluid :placeholder="t('plan.instructionsPlaceholder')" />
      </FormField>
    </div>

    <div class="gym-field mt-3">{{ t('plan.variations') }}</div>
    <template v-for="(v, j) in s.variations" :key="j">
      <div class="mb-1.5 flex items-center gap-2">
        <button
          type="button"
          class="grid size-10 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border transition-colors"
          :class="[
            openImage === key(i, j) ? 'border-primary' : 'border-surface-300 dark:border-surface-700',
            busyImage === key(i, j) ? 'animate-pulse' : '',
          ]"
          :title="t('plan.image.open')"
          @click="toggleImage(i, j)"
        >
          <img v-if="v.image" class="size-full object-cover" :src="src(s.id, j, v)" alt="" />
          <span v-else class="text-surface-400">{{ busyImage === key(i, j) ? '…' : '+' }}</span>
        </button>
        <InputText v-model="v.label" class="grow" :placeholder="t('plan.variationPlaceholder')" />
        <NumberInput v-model="v.episodes" class="w-20" />
        <SecondaryButton variant="text" rounded :title="t('app.delete')" @click="removeVariation(i, j)">
          <template #icon><IconClose /></template>
        </SecondaryButton>
      </div>

      <div
        v-if="openImage === key(i, j)"
        class="mb-2.5 ms-12 rounded-panel border border-surface-300 bg-surface-0 p-3 dark:border-surface-700 dark:bg-surface-900"
      >
        <FormField :label="t('plan.image.prompt')" :hint="t('plan.image.promptHint')">
          <Textarea v-model="v.imagePrompt" rows="2" fluid :placeholder="t('plan.image.promptPlaceholder')" />
        </FormField>
        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <SecondaryButton
            size="small"
            :disabled="!imagesEnabled || !!busyImage"
            :label="
              busyImage === key(i, j)
                ? t('plan.image.generating')
                : v.image
                  ? t('plan.image.regenerate')
                  : t('plan.image.generate')
            "
            @click="emit('image', 'generate', i, j)"
          />
          <SecondaryButton size="small" :disabled="!!busyImage" :label="t('plan.image.upload')" @click="pickFile(i, j)" />
          <SecondaryButton
            size="small"
            :disabled="!!busyImage"
            :label="t('plan.image.useScene')"
            @click="emit('image', 'scene', i, j)"
          />
          <span class="grow"></span>
          <Pill v-if="v.image">{{ t(`plan.image.source.${v.image.source}`) }}</Pill>
          <SecondaryButton
            v-if="v.image"
            size="small"
            class="text-bad!"
            :disabled="!!busyImage"
            :label="t('plan.image.remove')"
            @click="emit('image', 'remove', i, j)"
          />
        </div>
        <img
          v-if="v.image"
          class="mt-2.5 max-h-72 rounded-md border border-surface-300 dark:border-surface-700"
          :src="src(s.id, j, v)"
          alt=""
        />
        <span v-else class="mt-2 block text-xs text-surface-500 dark:text-surface-400">{{
          imagesEnabled ? t('plan.image.none') : t('plan.image.off')
        }}</span>
      </div>
    </template>

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <SecondaryButton size="small" :label="t('plan.addVariation')" @click="addVariation(i)">
        <template #icon><IconAdd /></template>
      </SecondaryButton>
      <SecondaryButton size="small" :label="t('plan.duplicateStep')" @click="duplicate(i)">
        <template #icon><IconCopy /></template>
      </SecondaryButton>
      <span class="grow"></span>
      <SecondaryButton size="small" class="text-bad!" :label="t('plan.removeStep')" @click="removeStep(i)" />
    </div>
  </div>

  <SecondaryButton :label="t('plan.addStep')" @click="addStep">
    <template #icon><IconAdd /></template>
  </SecondaryButton>
</template>
