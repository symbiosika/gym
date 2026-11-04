<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { COMPONENT_STATUSES, type RobotComponent } from '@/types/gym'
import { COMPONENT_STATUS_TONE, copyName } from '@/utils/robots'
import IconAdd from '~icons/carbon/add'
import IconCopy from '~icons/carbon/copy'
import IconEdit from '~icons/carbon/edit'
import IconCheckmark from '~icons/carbon/checkmark'
import IconTrash from '~icons/carbon/trash-can'
import IconWarning from '~icons/carbon/warning-alt'

/**
 * One capability section of a robot (sensors, actuators, …, system) as a
 * condensed list. A click on a row opens it for editing; every change is saved
 * at once, and closing the row saves it again and confirms it on the row.
 * `save` gets the whole section; a row without a name is not sent until it has
 * one, and a row closed without a name is dropped.
 */
const props = defineProps<{ editable: boolean; save: (items: RobotComponent[]) => Promise<boolean> }>()
const items = defineModel<RobotComponent[]>({ required: true })
const { t } = useI18n()

const statusOptions = computed(() => COMPONENT_STATUSES.map((s) => ({ label: t(`robots.componentStatus.${s}`), value: s })))

// every row needs an id of its own to be opened, copied and confirmed
for (const c of items.value) c.id ||= crypto.randomUUID()

/** the row open for editing */
const openId = ref<string | null>(null)
/** where the last save of a row stands; "saved" fades after a moment */
const saveState = ref<{ id: string; state: 'saving' | 'saved' | 'failed' } | null>(null)
let fade: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(fade))

/** saves run one after the other, each with the section as it is when its turn comes */
let queue: Promise<unknown> = Promise.resolve()

async function persist(id: string | null) {
  clearTimeout(fade)
  if (id) saveState.value = { id, state: 'saving' }
  const run = queue.then(() => props.save(items.value.filter((c) => c.name.trim())))
  queue = run
  const ok = await run
  if (!id) return
  saveState.value = { id, state: ok ? 'saved' : 'failed' }
  if (ok) fade = setTimeout(() => (saveState.value = null), 2500)
}
const stateOf = (c: RobotComponent) => (saveState.value?.id === c.id ? saveState.value?.state : null) ?? null

/** A change while editing: saved at once once the row has a name. */
function changed(c: RobotComponent) {
  if (c.name.trim()) persist(c.id!)
}

function open(c: RobotComponent) {
  if (!props.editable || openId.value === c.id) return
  close()
  openId.value = c.id!
}
/** Close the open row: saved and confirmed, or dropped when it never got a name. */
function close() {
  const c = items.value.find((x) => x.id === openId.value)
  openId.value = null
  if (!c) return
  if (c.name.trim()) return persist(c.id!)
  items.value.splice(items.value.indexOf(c), 1)
  persist(null)
}

function add() {
  close()
  const c: RobotComponent = { id: crypto.randomUUID(), name: '', type: '', quantity: 1, status: 'ok', note: '' }
  items.value.push(c)
  openId.value = c.id!
}
/** A copy right below the original, named "… copy 1" (or the next free number), open for editing. */
function copy(c: RobotComponent) {
  close()
  const twin: RobotComponent = {
    ...c,
    id: crypto.randomUUID(),
    name: copyName(
      c.name,
      items.value.map((x) => x.name),
    ),
  }
  items.value.splice(items.value.indexOf(c) + 1, 0, twin)
  openId.value = twin.id!
  persist(twin.id!)
}
function remove(c: RobotComponent) {
  openId.value = null
  items.value.splice(items.value.indexOf(c), 1)
  persist(null)
}

const STATUS_BORDER: Partial<Record<RobotComponent['status'], string>> = {
  faulty: 'border-s-bad border-s-[3px]',
  degraded: 'border-s-warn border-s-[3px]',
  disconnected: 'border-s-info border-s-[3px]',
}
const statusBorder = (c: RobotComponent) => STATUS_BORDER[c.status] ?? ''
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-if="!items.length" class="gym-empty">{{ t('robots.noComponents') }}</div>
    <div
      v-for="c in items"
      :key="c.id"
      class="rounded-lg border transition-colors"
      :class="[
        statusBorder(c),
        openId === c.id ? 'border-primary/60 bg-surface-50 dark:bg-surface-900' : 'border-surface-200 dark:border-surface-800',
      ]"
    >
      <!-- condensed: what it is at a glance -->
      <div v-if="openId !== c.id" class="flex items-center gap-1">
        <button
          type="button"
          class="flex min-w-0 grow items-center gap-3 rounded-lg px-3 py-2 text-start outline-none"
          :class="
            props.editable
              ? 'cursor-pointer hover:bg-surface-50 focus-visible:bg-surface-50 dark:hover:bg-surface-900 dark:focus-visible:bg-surface-900'
              : 'cursor-default'
          "
          :disabled="!props.editable"
          :title="props.editable ? t('robots.component.edit') : undefined"
          @click="open(c)"
        >
          <div class="flex min-w-0 grow flex-col sm:flex-row sm:items-baseline sm:gap-3">
            <span class="truncate font-semibold">{{ c.name }}</span>
            <span class="truncate text-sm text-surface-500 dark:text-surface-400">{{
              c.type || t('robots.component.noType')
            }}</span>
            <span
              v-if="c.note"
              class="text-xs text-surface-500 dark:text-surface-400"
              :class="props.editable ? 'truncate' : ''"
              >{{ c.note }}</span
            >
          </div>
          <span class="shrink-0 font-mono text-sm text-surface-600 tabular-nums dark:text-surface-300">×{{ c.quantity }}</span>
          <Pill class="shrink-0" :tone="COMPONENT_STATUS_TONE[c.status]">{{ t(`robots.componentStatus.${c.status}`) }}</Pill>
          <span
            v-if="stateOf(c) === 'saved'"
            class="text-ok flex shrink-0 items-center gap-1 text-xs font-semibold"
            role="status"
          >
            <IconCheckmark aria-hidden="true" />{{ t('robots.component.saved') }}
          </span>
          <span v-else-if="stateOf(c) === 'saving'" class="shrink-0 text-xs text-surface-500" role="status">{{
            t('robots.component.saving')
          }}</span>
          <IconWarning v-else-if="stateOf(c) === 'failed'" class="text-bad shrink-0" aria-hidden="true" />
          <IconEdit v-if="props.editable" class="shrink-0 text-surface-400" aria-hidden="true" />
        </button>
        <SecondaryButton
          v-if="props.editable"
          variant="text"
          rounded
          size="small"
          class="me-1 shrink-0"
          :title="t('robots.component.copy')"
          :aria-label="t('robots.component.copy')"
          @click="copy(c)"
        >
          <template #icon><IconCopy /></template>
        </SecondaryButton>
      </div>

      <!-- open: every field, saved on the fly -->
      <div v-else class="flex flex-col gap-3 p-3">
        <div class="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_minmax(0,0.9fr)]">
          <FormField :label="t('robots.component.name')" required>
            <InputText
              v-model="c.name"
              fluid
              size="small"
              autofocus
              :placeholder="t('robots.component.namePlaceholder')"
              @change="changed(c)"
              @keydown.enter="close"
            />
          </FormField>
          <FormField :label="t('robots.component.type')">
            <InputText
              v-model="c.type"
              fluid
              size="small"
              :placeholder="t('robots.component.typePlaceholder')"
              @change="changed(c)"
              @keydown.enter="close"
            />
          </FormField>
          <FormField :label="t('robots.component.quantity')">
            <NumberInput
              :model-value="c.quantity"
              fluid
              size="small"
              @update:model-value="(v: number | null) => (c.quantity = v ?? 0)"
              @change="changed(c)"
            />
          </FormField>
          <FormField :label="t('robots.component.status')">
            <Select
              v-model="c.status"
              :options="statusOptions"
              option-label="label"
              option-value="value"
              size="small"
              fluid
              @change="changed(c)"
            >
              <template #value="{ value }">
                <Pill :tone="COMPONENT_STATUS_TONE[value as RobotComponent['status']]">{{
                  t(`robots.componentStatus.${value}`)
                }}</Pill>
              </template>
            </Select>
          </FormField>
        </div>
        <FormField :label="t('robots.component.note')">
          <InputText v-model="c.note" fluid size="small" @change="changed(c)" @keydown.enter="close" />
        </FormField>
        <div class="flex flex-wrap items-center gap-2">
          <SecondaryButton size="small" variant="text" class="text-bad!" :label="t('robots.component.remove')" @click="remove(c)">
            <template #icon><IconTrash /></template>
          </SecondaryButton>
          <SecondaryButton v-if="c.name.trim()" size="small" variant="text" :label="t('robots.component.copy')" @click="copy(c)">
            <template #icon><IconCopy /></template>
          </SecondaryButton>
          <span class="ms-auto text-xs text-surface-500 dark:text-surface-400" role="status">
            <template v-if="!c.name.trim()">{{ t('robots.component.unsaved') }}</template>
            <template v-else-if="stateOf(c) === 'saving'">{{ t('robots.component.saving') }}</template>
            <span v-else-if="stateOf(c) === 'saved'" class="text-ok inline-flex items-center gap-1 font-semibold">
              <IconCheckmark aria-hidden="true" />{{ t('robots.component.saved') }}
            </span>
          </span>
          <Button size="small" :label="t('robots.component.done')" @click="close">
            <template #icon><IconCheckmark /></template>
          </Button>
        </div>
      </div>
    </div>
    <div v-if="props.editable">
      <SecondaryButton size="small" variant="text" :label="t('robots.component.add')" @click="add">
        <template #icon><IconAdd /></template>
      </SecondaryButton>
    </div>
  </div>
</template>
