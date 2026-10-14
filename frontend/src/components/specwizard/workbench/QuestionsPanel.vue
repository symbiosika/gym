<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { indicator, slugOf, uniqueId, type SpecForm, type SpecIndicator } from '@/utils/spec'
import type { QuestionRow } from '@/utils/specSample'
import IconYes from '~icons/carbon/checkmark-filled'
import IconNo from '~icons/carbon/close-filled'
import IconOpen from '~icons/carbon/help'
import IconTrash from '~icons/carbon/trash-can'
import IconAdd from '~icons/carbon/add'
import IconTest from '~icons/carbon/play-outline'
import Button from '@/volt/Button.vue'
import SecondaryButton from '@/volt/SecondaryButton.vue'

/**
 * The questions to the model, as the person writes them: one sentence each,
 * and whether it has to hold ("must": below 0.5 the episode is rejected) or
 * only counts towards the total. Words changed here are asked by the next
 * test; the button at the bottom asks them on the open episode.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{
  episode: number | null
  /** the questions on the open episode, with the model's answers */
  rows: QuestionRow[]
  active: string | null
  testing: boolean
}>()
const emit = defineEmits<{ test: []; select: [id: string] }>()
const { t } = useI18n()

/** the line a "must" question stops below, the same as its ✓ or ✗ */
const MUST_BELOW = 0.5

const answerOf = (id: string) => props.rows.find((r) => r.kind === 'criterion' && r.id === id)
const untested = computed(() => props.rows.filter((r) => r.answer === 'untested').length)

function setMust(q: SpecIndicator, must: boolean) {
  q.gate = must
  if (must) q.gateBelow = MUST_BELOW
}

/** ids the panel chose itself follow the words once they are typed; one from the spec stays */
const autoIds = new WeakMap<SpecIndicator, string>()
function settleId(q: SpecIndicator) {
  if (autoIds.get(q) !== q.id || !q.description.trim()) return
  const others = form.value.soft.indicators.filter((i) => i !== q).map((i) => i.id)
  q.id = uniqueId(slugOf(q.description), others)
  autoIds.set(q, q.id)
}
async function add() {
  const q = indicator(
    uniqueId(
      'question',
      form.value.soft.indicators.map((i) => i.id),
    ),
    '',
  )
  autoIds.set(q, q.id)
  form.value.soft.indicators.push(q)
  await nextTick()
  boxes.value.at(-1)?.querySelector('textarea')?.focus()
}
const remove = (q: SpecIndicator) => (form.value.soft.indicators = form.value.soft.indicators.filter((i) => i !== q))

// the question clicked in the middle comes into view
const boxes = ref<HTMLElement[]>([])
watch(
  () => props.active,
  async (id) => {
    await nextTick()
    const i = form.value.soft.indicators.findIndex((q) => q.id === id)
    boxes.value[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3">
    <div class="flex items-center gap-2">
      <h3 class="font-semibold">{{ t('specWizard.q.title') }}</h3>
      <InfoButton k="wbQuestions" />
    </div>

    <label v-if="!form.soft.enabled" class="gym-note flex items-center gap-2 text-sm">
      <Checkbox v-model="form.soft.enabled" binary />{{ t('specWizard.q.enable') }}
    </label>

    <template v-else>
      <div class="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1">
        <div
          v-for="q in form.soft.indicators"
          :key="q.id"
          ref="boxes"
          class="rounded-lg border p-2.5 transition-colors"
          :class="active === q.id ? 'border-primary ring-1 ring-primary' : 'border-surface-300 dark:border-surface-700'"
          @focusin="emit('select', q.id)"
        >
          <div class="flex items-start gap-2">
            <template v-if="answerOf(q.id)">
              <IconYes v-if="answerOf(q.id)!.answer === 'yes'" class="text-ok mt-2 size-4 shrink-0" />
              <IconNo v-else-if="answerOf(q.id)!.answer === 'no'" class="text-bad mt-2 size-4 shrink-0" />
              <IconOpen v-else class="mt-2 size-4 shrink-0 text-surface-400" />
            </template>
            <Textarea
              v-model="q.description"
              rows="2"
              auto-resize
              class="grow text-sm!"
              :placeholder="t('specWizard.q.placeholder')"
              :aria-label="t('specWizard.q.text')"
              @blur="settleId(q)"
            />
            <button
              type="button"
              class="mt-1.5 cursor-pointer p-1 text-surface-400 hover:text-bad"
              :aria-label="t('specWizard.q.remove')"
              :title="t('specWizard.q.remove')"
              @click="remove(q)"
            >
              <IconTrash class="size-4" />
            </button>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-1 text-xs" role="radiogroup">
            <button
              v-for="m in [true, false]"
              :key="String(m)"
              type="button"
              role="radio"
              :aria-checked="q.gate === m"
              class="cursor-pointer rounded-md border px-2 py-1"
              :class="
                q.gate === m
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-surface-300 text-surface-600 dark:border-surface-700 dark:text-surface-300'
              "
              @click="setMust(q, m)"
            >
              {{ m ? t('specWizard.q.mustHold') : t('specWizard.q.counts') }}
            </button>
          </div>
        </div>
        <SecondaryButton size="small" :label="t('specWizard.q.add')" @click="add">
          <template #icon><IconAdd class="size-4" /></template>
        </SecondaryButton>
      </div>

      <div v-if="episode != null" class="border-t border-surface-200 pt-3 dark:border-surface-800">
        <component
          :is="untested ? Button : SecondaryButton"
          class="w-full"
          :label="t('specWizard.q.testOn', { n: episode })"
          :loading="testing"
          :disabled="testing"
          @click="emit('test')"
        >
          <template #icon><IconTest class="size-4" /></template>
        </component>
        <p class="mt-1 text-center text-xs text-surface-500 dark:text-surface-400">
          {{ untested ? t('specWizard.q.untestedCount', { n: untested }) : t('specWizard.q.allTested') }}
        </p>
      </div>
    </template>
  </div>
</template>
