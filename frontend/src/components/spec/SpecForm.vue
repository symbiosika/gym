<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CriticsHardCriticInfo } from '@/types/gym'
import {
  OBJECT_ROLES,
  PER_EPISODE,
  defaultIndicators,
  indicator,
  slugOf,
  uniqueId,
  type SpecForm,
  type SpecHardCritic,
  type SpecIndicator,
} from '@/utils/spec'
import { NONE } from '@/utils/select'
import NumField from '@/components/spec/NumField.vue'
import TokenField from '@/components/spec/TokenField.vue'
import IconAdd from '~icons/carbon/add'
import IconTrash from '~icons/carbon/trash-can'
import IconMagic from '~icons/carbon/magic-wand'
import IconChevron from '~icons/carbon/chevron-down'

/**
 * The spec as fields, in the order an operator thinks about a task: what the
 * robot does and with which objects, what counts as success, which technical
 * checks run and how strictly, and finally the robot. The model is edited in
 * place; `critics` says which parameters every technical check takes.
 */
const props = defineProps<{ critics: CriticsHardCriticInfo[] }>()
const form = defineModel<SpecForm>({ required: true })
const { t, te } = useI18n()

const roleOptions = computed(() => OBJECT_ROLES.map((r) => ({ label: t(`spec.role.${r}`), value: r })))
const perEpisodeOptions = computed(() => PER_EPISODE.map((p) => ({ label: t(`spec.perEpisode.${p}`), value: p })))

// ------------------------------------------------------------------ objects
function addObject() {
  form.value.task.objects.push({ name: '', role: form.value.task.objects.length ? 'other' : 'target_object', description: '' })
}
const removeObject = (i: number) => form.value.task.objects.splice(i, 1)

// --------------------------------------------------------------- indicators
/** the id the form gave an indicator itself; one the operator typed is never overwritten */
const autoIds = new WeakMap<SpecIndicator, string>()

function addIndicator() {
  const row = indicator('', '')
  row.id = uniqueId(
    'indicator',
    form.value.soft.indicators.map((i) => i.id),
  )
  autoIds.set(row, row.id)
  form.value.soft.indicators.push(row)
}
const removeIndicator = (i: number) => form.value.soft.indicators.splice(i, 1)

/** After the wording is typed, an id the form chose follows it. */
function settleId(row: SpecIndicator) {
  if (row.id && autoIds.get(row) !== row.id) return
  const others = form.value.soft.indicators.filter((i) => i !== row).map((i) => i.id)
  row.id = uniqueId(slugOf(row.description), others)
  autoIds.set(row, row.id)
}

function insertDefaults() {
  const have = new Set(form.value.soft.indicators.map((i) => i.id))
  for (const row of defaultIndicators(form.value.task.objects)) if (!have.has(row.id)) form.value.soft.indicators.push(row)
}

// ------------------------------------------------------------- hard critics
const openParams = ref<string | null>(null)
const criticLabel = (id: string) => (te(`spec.critic.${id}.label`) ? t(`spec.critic.${id}.label`) : id)
const criticDesc = (id: string) => (te(`spec.critic.${id}.desc`) ? t(`spec.critic.${id}.desc`) : '')
const paramHint = (id: string, key: string) => (te(`spec.param.${id}.${key}`) ? t(`spec.param.${id}.${key}`) : '')

/** the parameters a check takes: the service's defaults plus anything the spec already sets */
function paramKeys(c: SpecHardCritic): string[] {
  const defaults = props.critics.find((m) => m.id === c.id)?.default_params ?? {}
  return [...new Set([...Object.keys(defaults), ...Object.keys(c.params)])]
}
const defaultOf = (c: SpecHardCritic, key: string): unknown => props.critics.find((m) => m.id === c.id)?.default_params?.[key]
const kindOf = (v: unknown): 'number' | 'boolean' | 'text' =>
  typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text'
const showDefault = (v: unknown): string =>
  v == null ? t('spec.paramAuto') : typeof v === 'object' ? JSON.stringify(v) : String(v)

function paramText(c: SpecHardCritic, key: string): string {
  const v = c.params[key]
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
function setParam(c: SpecHardCritic, key: string, raw: string) {
  const text = raw.trim()
  if (!text) {
    delete c.params[key]
    return
  }
  const kind = kindOf(defaultOf(c, key))
  if (kind === 'number') {
    const n = Number(text)
    if (!Number.isNaN(n)) c.params[key] = n
    return
  }
  try {
    c.params[key] = JSON.parse(text)
  } catch {
    c.params[key] = text
  }
}
const boolParam = (c: SpecHardCritic, key: string): string => (typeof c.params[key] === 'boolean' ? String(c.params[key]) : NONE)
function setBoolParam(c: SpecHardCritic, key: string, v: string) {
  if (v === NONE) delete c.params[key]
  else c.params[key] = v === 'true'
}
const boolOptions = (dflt: unknown) => [
  { label: t('spec.paramDefault', { v: showDefault(dflt) }), value: NONE },
  { label: t('app.yes'), value: 'true' },
  { label: t('app.no'), value: 'false' },
]
const overrides = (c: SpecHardCritic) => Object.keys(c.params).length
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 1 · the task -->
    <section>
      <header class="mb-2 flex items-center gap-2">
        <span class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
          >1</span
        >
        <h3 class="text-sm font-semibold">{{ t('spec.secTask') }}</h3>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.secTaskHint') }}</span>
      </header>
      <div class="flex flex-col gap-3">
        <FormField :label="t('spec.instruction')" :hint="t('spec.instructionHint')" required>
          <InputText v-model="form.task.instruction" fluid :placeholder="t('spec.instructionPlaceholder')" />
        </FormField>
        <FormField :label="t('spec.scene')" :hint="t('spec.sceneHint')">
          <Textarea v-model="form.task.scene" rows="2" fluid auto-resize :placeholder="t('spec.scenePlaceholder')" />
        </FormField>

        <div>
          <span class="gym-field">{{ t('spec.objects') }}</span>
          <div v-if="form.task.objects.length" class="gym-panel overflow-x-auto">
            <table class="gym-table">
              <thead>
                <tr>
                  <th>{{ t('spec.objectName') }}</th>
                  <th>{{ t('spec.objectRole') }}</th>
                  <th>{{ t('spec.objectDesc') }}</th>
                  <th class="w-10"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(o, i) in form.task.objects" :key="i">
                  <td class="min-w-36">
                    <InputText v-model="o.name" fluid size="small" :placeholder="t('spec.objectNamePlaceholder')" />
                  </td>
                  <td class="min-w-40">
                    <Select
                      v-model="o.role"
                      :options="roleOptions"
                      option-label="label"
                      option-value="value"
                      size="small"
                      fluid
                    />
                  </td>
                  <td class="min-w-44">
                    <InputText v-model="o.description" fluid size="small" :placeholder="t('spec.objectDescPlaceholder')" />
                  </td>
                  <td>
                    <button
                      type="button"
                      class="cursor-pointer p-1 text-surface-500 hover:text-bad"
                      :aria-label="t('app.delete')"
                      @click="removeObject(i)"
                    >
                      <IconTrash class="size-4" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <SecondaryButton size="small" :label="t('spec.addObject')" @click="addObject">
              <template #icon><IconAdd class="size-4" /></template>
            </SecondaryButton>
            <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.objectsHint') }}</span>
          </div>
        </div>

        <details class="group">
          <summary class="flex cursor-pointer items-center gap-1 text-sm text-surface-600 select-none dark:text-surface-300">
            <IconChevron class="size-4 transition-transform group-open:rotate-180" />
            {{ t('spec.moreTask') }}
          </summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <FormField :label="t('spec.expectedCycles')" :hint="t('spec.expectedCyclesHint')">
              <NumberInput v-model="form.task.expectedCycles" :min="1" class="w-28!" />
            </FormField>
            <FormField :label="t('spec.perEpisodeLabel')" :hint="t('spec.perEpisodeHint')">
              <Select
                v-model="form.task.perEpisode"
                :options="perEpisodeOptions"
                option-label="label"
                option-value="value"
                fluid
              />
            </FormField>
            <FormField class="sm:col-span-2" :label="t('spec.notes')" :hint="t('spec.notesHint')">
              <Textarea v-model="form.task.notes" rows="2" fluid auto-resize />
            </FormField>
          </div>
        </details>
      </div>
    </section>

    <!-- 2 · success indicators -->
    <section>
      <header class="mb-2 flex flex-wrap items-center gap-2">
        <span class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
          >2</span
        >
        <h3 class="text-sm font-semibold">{{ t('spec.secSoft') }}</h3>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.secSoftHint') }}</span>
        <label class="ms-auto flex items-center gap-2 text-sm">
          <Checkbox v-model="form.soft.enabled" binary />
          {{ t('spec.softEnabled') }}
        </label>
      </header>

      <template v-if="form.soft.enabled">
        <div v-if="!form.soft.indicators.length" class="gym-empty">{{ t('spec.noIndicators') }}</div>
        <ol v-else class="flex flex-col gap-2">
          <li
            v-for="(row, i) in form.soft.indicators"
            :key="i"
            class="rounded-lg border border-surface-300 bg-surface-0 p-3 dark:border-surface-700 dark:bg-surface-900"
          >
            <div class="flex items-start gap-2">
              <span class="mt-2 font-mono text-xs text-surface-500">{{ i + 1 }}</span>
              <div class="flex min-w-0 grow flex-col gap-2">
                <Textarea
                  v-model="row.description"
                  rows="1"
                  fluid
                  auto-resize
                  :placeholder="t('spec.indicatorPlaceholder')"
                  @blur="settleId(row)"
                />
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  <label class="flex items-center gap-2">
                    <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.weight') }}</span>
                    <NumField v-model="row.weight" :min="0" :step="0.5" :fallback="1" narrow />
                  </label>
                  <label class="flex items-center gap-2" :title="t('spec.gateHint')">
                    <Checkbox v-model="row.gate" binary />
                    {{ t('spec.gate') }}
                  </label>
                  <label v-if="row.gate" class="flex items-center gap-2">
                    <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.gateBelow') }}</span>
                    <NumField v-model="row.gateBelow" :min="0" :max="1" :step="0.05" :fallback="0.3" narrow />
                  </label>
                  <label class="ms-auto flex items-center gap-2">
                    <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.indicatorId') }}</span>
                    <InputText v-model="row.id" size="small" class="w-44! font-mono! text-xs!" />
                  </label>
                </div>
                <details class="group">
                  <summary
                    class="flex cursor-pointer items-center gap-1 text-xs text-surface-500 select-none dark:text-surface-400"
                  >
                    <IconChevron class="size-3.5 transition-transform group-open:rotate-180" />
                    {{ t('spec.rubric') }}
                  </summary>
                  <Textarea
                    v-model="row.rubric"
                    rows="2"
                    fluid
                    auto-resize
                    class="mt-2 text-xs!"
                    :placeholder="t('spec.rubricPlaceholder')"
                  />
                </details>
              </div>
              <button
                type="button"
                class="cursor-pointer p-1 text-surface-500 hover:text-bad"
                :aria-label="t('app.delete')"
                @click="removeIndicator(i)"
              >
                <IconTrash class="size-4" />
              </button>
            </div>
          </li>
        </ol>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <SecondaryButton size="small" :label="t('spec.addIndicator')" @click="addIndicator">
            <template #icon><IconAdd class="size-4" /></template>
          </SecondaryButton>
          <SecondaryButton
            size="small"
            :label="t('spec.insertDefaults')"
            :title="t('spec.insertDefaultsHint')"
            @click="insertDefaults"
          >
            <template #icon><IconMagic class="size-4" /></template>
          </SecondaryButton>
        </div>
      </template>
      <div v-else class="gym-note border-s-warn">{{ t('spec.softOff') }}</div>
    </section>

    <!-- 3 · technical checks -->
    <section>
      <header class="mb-2 flex flex-wrap items-center gap-2">
        <span class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
          >3</span
        >
        <h3 class="text-sm font-semibold">{{ t('spec.secHard') }}</h3>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.secHardHint') }}</span>
      </header>
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th class="w-8"></th>
              <th>{{ t('spec.check') }}</th>
              <th class="w-28">{{ t('spec.weight') }}</th>
              <th>{{ t('spec.gate') }}</th>
              <th class="w-32">{{ t('spec.params') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="c in form.hardCritics" :key="c.id">
              <tr :class="c.enabled ? '' : 'opacity-60'">
                <td><Checkbox v-model="c.enabled" binary :title="t('spec.checkOn')" /></td>
                <td class="min-w-56">
                  <span class="block text-sm font-medium">{{ criticLabel(c.id) }}</span>
                  <span class="block text-xs text-surface-500 dark:text-surface-400">{{ criticDesc(c.id) }}</span>
                </td>
                <td><NumField v-model="c.weight" :min="0" :step="0.5" :fallback="1" narrow :disabled="!c.enabled" /></td>
                <td class="min-w-56">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <label class="flex items-center gap-2" :title="t('spec.gateHint')">
                      <Checkbox v-model="c.gate" binary :disabled="!c.enabled" />
                      <span class="text-xs">{{ t('spec.gateScore') }}</span>
                    </label>
                    <NumField v-if="c.gate" v-model="c.gateBelow" :min="0" :max="1" :step="0.05" :fallback="0.2" narrow />
                    <span v-if="c.gateFlags.length" class="flex flex-wrap gap-1" :title="t('spec.gateFlagsHint')">
                      <Pill v-for="f in c.gateFlags" :key="f" tone="bad">{{ f }}</Pill>
                    </span>
                  </div>
                </td>
                <td>
                  <button
                    type="button"
                    class="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
                    :aria-expanded="openParams === c.id"
                    @click="openParams = openParams === c.id ? null : c.id"
                  >
                    <IconChevron class="size-3.5 transition-transform" :class="openParams === c.id ? 'rotate-180' : ''" />
                    {{ overrides(c) ? t('spec.paramsChanged', { n: overrides(c) }) : t('spec.paramsDefault') }}
                  </button>
                </td>
              </tr>
              <tr v-if="openParams === c.id">
                <td></td>
                <td colspan="4" class="bg-surface-50 dark:bg-surface-800/40">
                  <div v-if="!paramKeys(c).length" class="text-xs text-surface-500 dark:text-surface-400">
                    {{ t('spec.noParams') }}
                  </div>
                  <div v-else class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label v-for="key in paramKeys(c)" :key="key" class="flex min-w-0 flex-col gap-1">
                      <span class="flex items-baseline gap-2">
                        <span class="font-mono text-xs font-semibold">{{ key }}</span>
                        <span class="truncate font-mono text-[11px] text-surface-500 dark:text-surface-400">{{
                          t('spec.paramDefault', { v: showDefault(defaultOf(c, key)) })
                        }}</span>
                      </span>
                      <Select
                        v-if="kindOf(defaultOf(c, key)) === 'boolean'"
                        :model-value="boolParam(c, key)"
                        :options="boolOptions(defaultOf(c, key))"
                        option-label="label"
                        option-value="value"
                        size="small"
                        fluid
                        @update:model-value="setBoolParam(c, key, $event as string)"
                      />
                      <InputText
                        v-else
                        :model-value="paramText(c, key)"
                        :type="kindOf(defaultOf(c, key)) === 'number' ? 'number' : 'text'"
                        step="any"
                        size="small"
                        fluid
                        class="font-mono! text-xs!"
                        :placeholder="showDefault(defaultOf(c, key))"
                        @blur="setParam(c, key, ($event.target as HTMLInputElement).value)"
                        @keydown.enter.prevent="setParam(c, key, ($event.target as HTMLInputElement).value)"
                      />
                      <span v-if="paramHint(c.id, key)" class="text-xs text-surface-500 dark:text-surface-400">{{
                        paramHint(c.id, key)
                      }}</span>
                    </label>
                  </div>
                  <p class="mt-3 text-xs text-surface-500 dark:text-surface-400">{{ t('spec.paramsHint') }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 4 · scoring -->
    <section>
      <header class="mb-2 flex flex-wrap items-center gap-2">
        <span class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
          >4</span
        >
        <h3 class="text-sm font-semibold">{{ t('spec.secScoring') }}</h3>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.secScoringHint') }}</span>
      </header>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FormField :label="t('spec.acceptThreshold')" :hint="t('spec.acceptThresholdHint')">
          <NumField v-model="form.scoring.acceptThreshold" :min="0" :max="1" :step="0.05" :fallback="0.75" />
        </FormField>
        <FormField :label="t('spec.reviewThreshold')" :hint="t('spec.reviewThresholdHint')">
          <NumField v-model="form.scoring.reviewThreshold" :min="0" :max="1" :step="0.05" :fallback="0.55" />
        </FormField>
        <FormField :label="t('spec.hardWeight')" :hint="t('spec.hardWeightHint')">
          <NumField v-model="form.scoring.hardWeight" :min="0" :step="0.5" :fallback="1" />
        </FormField>
        <FormField :label="t('spec.softWeight')" :hint="t('spec.softWeightHint')">
          <NumField v-model="form.scoring.softWeight" :min="0" :step="0.5" :fallback="1" />
        </FormField>
        <FormField class="sm:col-span-2 lg:col-span-4" :label="t('spec.ignoreFlags')" :hint="t('spec.ignoreFlagsHint')">
          <TokenField v-model="form.scoring.ignoreFlags" placeholder="INACTIVE_ARM_TRACKERR, LOW_DIVERSITY" />
        </FormField>
      </div>
    </section>

    <!-- 5 · the robot -->
    <section>
      <details class="group">
        <summary class="flex cursor-pointer flex-wrap items-center gap-2 select-none">
          <span class="bg-primary/10 text-primary dark:bg-primary/15 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold"
            >5</span
          >
          <h3 class="text-sm font-semibold">{{ t('spec.secRobot') }}</h3>
          <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.secRobotHint') }}</span>
          <IconChevron class="size-4 text-surface-500 transition-transform group-open:rotate-180" />
        </summary>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          <FormField :label="t('spec.robotType')" :hint="t('spec.robotTypeHint')">
            <InputText v-model="form.robot.type" fluid placeholder="humanoid_v1" />
          </FormField>
          <FormField :label="t('spec.activeArms')" :hint="t('spec.activeArmsHint')">
            <TokenField v-model="form.robot.activeArms" placeholder="left, right" />
          </FormField>
          <FormField :label="t('spec.primaryCamera')" :hint="t('spec.primaryCameraHint')">
            <InputText v-model="form.robot.primaryCamera" fluid placeholder="observation.images.front" />
          </FormField>
        </div>
      </details>
    </section>
  </div>
</template>
