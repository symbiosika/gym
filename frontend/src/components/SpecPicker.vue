<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGym } from '@/stores/gym'
import SpecManager from '@/components/SpecManager.vue'
import { NONE } from '@/utils/select'
import IconSettings from '~icons/carbon/settings-adjust'
import IconMagic from '~icons/carbon/magic-wand'

/**
 * The critics spec of a skill: pick one of the specs the critics service
 * knows, or open the spec management next to it (read, write, upload, remove).
 * `null` stands for the automatic spec the critics derive from the dataset;
 * inside the select it is the empty string, so it shows as a chosen option and
 * not as an empty field.
 *
 * The wizard button leads into the spec wizard, which works a spec out from a
 * sample dataset; with `skillId` the new spec is meant for that skill.
 */
const props = defineProps<{ tenantId: string; disabled?: boolean; skillId?: string }>()
const model = defineModel<string | null>({ required: true })
const { t } = useI18n()
const gym = useGym()
const manageOpen = ref(false)

const AUTO = NONE
const selected = computed({
  get: () => model.value ?? AUTO,
  set: (value: string) => (model.value = value === AUTO ? null : value),
})

const options = computed(() => {
  const known = gym.critics.specs.map((sp) => ({
    label: sp.task ? `${sp.name} · ${sp.task}` : sp.name,
    value: sp.name,
  }))
  // a spec the skill names but the service no longer lists stays visible instead of falling back to auto
  if (model.value && !gym.critics.specs.some((sp) => sp.name === model.value)) {
    known.unshift({ label: model.value, value: model.value })
  }
  return [{ label: t('spec.auto'), value: AUTO }, ...known]
})

/** What the chosen spec checks, in one line under the select. */
const chosen = computed(() => gym.critics.specs.find((sp) => sp.name === model.value) ?? null)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-2">
      <Select
        v-model="selected"
        class="min-w-0 grow"
        :options="options"
        option-label="label"
        option-value="value"
        :disabled="disabled"
      />
      <RouterLink
        v-if="!disabled"
        :to="{ name: 'SpecWizard', params: { tenantId }, query: skillId ? { skillId } : {} }"
        :title="t('spec.wizardHint')"
        class="inline-flex"
      >
        <SecondaryButton :label="t('spec.wizard')" tabindex="-1">
          <template #icon><IconMagic class="size-4" /></template>
        </SecondaryButton>
      </RouterLink>
      <SecondaryButton :label="t('spec.manage')" :title="t('spec.manageHint')" :disabled="disabled" @click="manageOpen = true">
        <template #icon>
          <IconSettings class="size-4" />
        </template>
      </SecondaryButton>
    </div>
    <!-- what a picked spec checks is in its option label already; only auto and a spec the service lost need a word -->
    <p v-if="!model" class="text-xs text-surface-500 dark:text-surface-400">{{ t('spec.autoHint') }}</p>
    <p v-else-if="!chosen" class="text-warn text-xs">{{ t('spec.chosen', { name: model }) }}</p>

    <SpecManager v-model:visible="manageOpen" :tenant-id="tenantId" @picked="model = $event" />
  </div>
</template>
