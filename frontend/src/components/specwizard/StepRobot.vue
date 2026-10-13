<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport } from '@/types/gym'
import type { SpecForm } from '@/utils/spec'
import SampleSheet from '@/components/specwizard/SampleSheet.vue'
import IconCamera from '~icons/carbon/camera'
import IconCheck from '~icons/carbon/checkmark'

/**
 * The robot step of the spec wizard: the robot type, the arm that works and
 * the camera the vision-language model looks at first. The cameras are the
 * ones the sample carries; the contact sheet next to them shows one row per
 * camera in the same order, so the person picks by what a camera sees and
 * not by its key.
 */
const form = defineModel<SpecForm>({ required: true })
const props = defineProps<{ report: SampleReport | null; sheetSrc: string | null; episode: number | null }>()
const { t } = useI18n()

const ARMS = ['left', 'right']
const armOptions = computed(() => [...new Set([...ARMS, ...form.value.robot.activeArms])])
function toggleArm(arm: string) {
  const arms = form.value.robot.activeArms
  form.value.robot.activeArms = arms.includes(arm) ? arms.filter((a) => a !== arm) : [...arms, arm]
}
const cameras = computed(() => props.report?.cameras ?? [])
/** `observation.images.wrist_left` reads as `wrist left` */
const cameraName = (key: string) => key.split('.').pop()!.replace(/[_-]+/g, ' ')
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[1fr_1fr]">
    <div class="flex flex-col gap-5">
      <FormField :label="t('spec.robotType')" :hint="t('specWizard.robot.typeHint')">
        <InputText v-model="form.robot.type" fluid :placeholder="report?.robot_type || 'humanoid_v1'" />
      </FormField>

      <div>
        <span class="gym-field">{{ t('spec.activeArms') }}</span>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors"
            :class="
              !form.robot.activeArms.length
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-surface-300 hover:border-primary dark:border-surface-700'
            "
            @click="form.robot.activeArms = []"
          >
            {{ t('specWizard.robot.allArms') }}
          </button>
          <button
            v-for="arm in armOptions"
            :key="arm"
            type="button"
            class="cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors"
            :class="
              form.robot.activeArms.includes(arm)
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-surface-300 hover:border-primary dark:border-surface-700'
            "
            :aria-pressed="form.robot.activeArms.includes(arm)"
            @click="toggleArm(arm)"
          >
            {{ t(`specWizard.robot.arm.${arm}`, arm) }}
          </button>
        </div>
        <p class="mt-1 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.robot.armsHint') }}</p>
      </div>

      <div>
        <span class="gym-field">{{ t('spec.primaryCamera') }}</span>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            class="flex cursor-pointer items-center gap-2 rounded-panel border p-3 text-start text-sm transition-colors"
            :class="
              !form.robot.primaryCamera
                ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                : 'border-surface-300 hover:border-primary dark:border-surface-700'
            "
            @click="form.robot.primaryCamera = ''"
          >
            <IconCheck v-if="!form.robot.primaryCamera" class="text-primary size-4 shrink-0" />
            <span>
              <span class="block font-medium">{{ t('specWizard.robot.autoCamera') }}</span>
              <span class="block text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.robot.autoCameraHint') }}</span>
            </span>
          </button>
          <button
            v-for="(cam, i) in cameras"
            :key="cam"
            type="button"
            class="flex cursor-pointer items-center gap-2 rounded-panel border p-3 text-start text-sm transition-colors"
            :class="
              form.robot.primaryCamera === cam
                ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                : 'border-surface-300 hover:border-primary dark:border-surface-700'
            "
            @click="form.robot.primaryCamera = cam"
          >
            <IconCamera class="size-4 shrink-0 text-surface-500" />
            <span class="min-w-0">
              <span class="block font-medium capitalize">{{ cameraName(cam) }}</span>
              <span class="block truncate font-mono text-[11px] text-surface-500 dark:text-surface-400"
                >{{ t('specWizard.robot.row', { n: i + 1 }) }} · {{ cam }}</span
              >
            </span>
          </button>
        </div>
        <p class="mt-1 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.robot.cameraHint') }}</p>
      </div>
    </div>

    <div v-if="sheetSrc && episode != null">
      <span class="gym-field">{{ t('specWizard.robot.look') }}</span>
      <SampleSheet :src="sheetSrc" :episode="episode" :caption="t('specWizard.robot.lookHint')" />
    </div>
  </div>
</template>
