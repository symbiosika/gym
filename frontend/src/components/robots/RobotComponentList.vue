<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { COMPONENT_STATUSES, type RobotComponent } from '@/types/gym'
import { COMPONENT_STATUS_TONE } from '@/utils/robots'
import IconAdd from '~icons/carbon/add'
import IconClose from '~icons/carbon/close'

/**
 * One capability section of a robot (sensors, actuators, …) as an editable
 * list: name, type, quantity, status, note. Emits `save` with the whole
 * section after a change; a row without a name is not sent until it has one.
 */
const props = defineProps<{ editable: boolean }>()
const items = defineModel<RobotComponent[]>({ required: true })
const emit = defineEmits<{ save: [RobotComponent[]] }>()
const { t } = useI18n()

const statusOptions = computed(() => COMPONENT_STATUSES.map((s) => ({ label: t(`robots.componentStatus.${s}`), value: s })))

function save() {
  emit(
    'save',
    items.value.filter((c) => c.name.trim()),
  )
}
function add() {
  items.value.push({ name: '', type: '', quantity: 1, status: 'ok', note: '' })
}
function remove(i: number) {
  items.value.splice(i, 1)
  save()
}

const rowGrid =
  'grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_4.5rem_minmax(0,0.9fr)_2.25rem] items-center gap-2 max-sm:grid-cols-[minmax(0,1fr)_4.5rem_2.25rem]'
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-if="!items.length" class="gym-empty">{{ t('robots.noComponents') }}</div>
    <template v-else>
      <div :class="[rowGrid, 'max-sm:hidden']">
        <span class="gym-field mb-0">{{ t('robots.component.name') }}</span>
        <span class="gym-field mb-0">{{ t('robots.component.type') }}</span>
        <span class="gym-field mb-0">{{ t('robots.component.quantity') }}</span>
        <span class="gym-field mb-0">{{ t('robots.component.status') }}</span>
        <span></span>
      </div>
      <div
        v-for="(c, i) in items"
        :key="c.id ?? `new-${i}`"
        class="rounded-lg border border-surface-200 p-2 dark:border-surface-800"
        :class="
          c.status === 'faulty' ? 'border-s-bad border-s-[3px]' : c.status === 'degraded' ? 'border-s-warn border-s-[3px]' : ''
        "
      >
        <div :class="rowGrid">
          <InputText
            v-model="c.name"
            fluid
            size="small"
            :placeholder="t('robots.component.namePlaceholder')"
            :aria-label="t('robots.component.name')"
            :disabled="!props.editable"
            @change="save"
          />
          <InputText
            v-model="c.type"
            fluid
            size="small"
            class="max-sm:hidden"
            :placeholder="t('robots.component.typePlaceholder')"
            :aria-label="t('robots.component.type')"
            :disabled="!props.editable"
            @change="save"
          />
          <NumberInput
            :model-value="c.quantity"
            fluid
            size="small"
            :aria-label="t('robots.component.quantity')"
            :disabled="!props.editable"
            @update:model-value="(v: number | null) => (c.quantity = v ?? 0)"
            @change="save"
          />
          <Select
            v-model="c.status"
            :options="statusOptions"
            option-label="label"
            option-value="value"
            size="small"
            class="max-sm:hidden"
            :aria-label="t('robots.component.status')"
            :disabled="!props.editable"
            @change="save"
          >
            <template #value="{ value }">
              <Pill :tone="COMPONENT_STATUS_TONE[value as RobotComponent['status']]">{{
                t(`robots.componentStatus.${value}`)
              }}</Pill>
            </template>
          </Select>
          <SecondaryButton
            v-if="props.editable"
            variant="text"
            rounded
            size="small"
            :title="t('robots.component.remove')"
            :aria-label="t('robots.component.remove')"
            @click="remove(i)"
          >
            <template #icon><IconClose /></template>
          </SecondaryButton>
          <span v-else></span>
        </div>
        <!-- on a phone type and status move under the name -->
        <div class="mt-2 grid grid-cols-2 gap-2 sm:hidden">
          <InputText
            v-model="c.type"
            fluid
            size="small"
            :placeholder="t('robots.component.typePlaceholder')"
            :aria-label="t('robots.component.type')"
            :disabled="!props.editable"
            @change="save"
          />
          <Select
            v-model="c.status"
            :options="statusOptions"
            option-label="label"
            option-value="value"
            size="small"
            :aria-label="t('robots.component.status')"
            :disabled="!props.editable"
            @change="save"
          />
        </div>
        <InputText
          v-if="props.editable || c.note"
          v-model="c.note"
          fluid
          size="small"
          class="mt-2"
          :placeholder="t('robots.component.note')"
          :aria-label="t('robots.component.note')"
          :disabled="!props.editable"
          @change="save"
        />
      </div>
    </template>
    <div v-if="props.editable">
      <SecondaryButton size="small" variant="text" :label="t('robots.component.add')" @click="add">
        <template #icon><IconAdd /></template>
      </SecondaryButton>
    </div>
  </div>
</template>
