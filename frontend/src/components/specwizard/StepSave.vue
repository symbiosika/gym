<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleReport, SpecDraftView } from '@/types/gym'
import { toYaml, validateSpec, type SpecForm } from '@/utils/spec'
import IconPlay from '~icons/carbon/play'
import IconSave from '~icons/carbon/save'
import IconArrow from '~icons/carbon/arrow-right'

/**
 * The last step of the spec wizard: a test run of the drafted spec over the
 * same episodes of the sample, compared with what the auto mode decided, and
 * then the name the spec is stored under and whether the skill uses it from
 * now on. Storing ends the wizard and lets the sample go.
 */
const props = defineProps<{
  draft: SpecDraftView
  form: SpecForm
  name: string
  analysis: SampleReport | null
  test: SampleReport | null
  busy: boolean
}>()
const emit = defineEmits<{
  'update:name': [name: string]
  test: []
  finish: [body: { name: string; assignToSkill: boolean }]
}>()
const { t } = useI18n()

const assign = ref(true)
const errors = computed(() => validateSpec(props.form))
const testing = computed(() => props.draft.testStatus === 'queued' || props.draft.testStatus === 'running')
const testProgress = computed(() => {
  const p = props.draft.testProgress
  const at = p.soft ?? p.hard
  return at && at.total ? `${at.done} / ${at.total}` : ''
})

/** the episodes of both runs side by side: what the auto mode said, what the drafted spec says */
const compare = computed(() => {
  if (!props.test) return []
  const before = new Map((props.analysis?.episodes ?? []).map((e) => [e.episode, e.score.verdict]))
  return props.test.episodes.map((e) => ({
    episode: e.episode,
    before: before.get(e.episode) ?? null,
    after: e.score.verdict,
    total: e.score.total,
    flags: e.score.flags,
  }))
})
const tone = (v: string | null) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')
const yaml = computed(() => toYaml(props.form, props.name || 'spec'))
</script>

<template>
  <div class="flex flex-col gap-6">
    <section>
      <SectionHeader :title="t('specWizard.save.testTitle')" :hint="t('specWizard.save.testHint')">
        <SecondaryButton
          :label="draft.testStatus === 'none' ? t('specWizard.save.testRun') : t('specWizard.save.testAgain')"
          :loading="testing"
          :disabled="testing || !!errors.length"
          @click="emit('test')"
        >
          <template #icon><IconPlay class="size-4" /></template>
        </SecondaryButton>
      </SectionHeader>
      <div v-if="testing" class="gym-note">{{ t('specWizard.save.testRunning') }} {{ testProgress }}</div>
      <div v-else-if="draft.testStatus === 'failed'" class="gym-note border-s-bad">
        {{ t('specWizard.save.testFailed') }}
        <span class="block font-mono text-xs">{{ draft.testError }}</span>
      </div>
      <div v-else-if="test" class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('specWizard.save.episode') }}</th>
              <th>{{ t('specWizard.save.auto') }}</th>
              <th></th>
              <th>{{ t('specWizard.save.yours') }}</th>
              <th>{{ t('specWizard.save.total') }}</th>
              <th>{{ t('specWizard.save.flags') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in compare" :key="row.episode">
              <td class="font-mono text-xs">{{ row.episode }}</td>
              <td>
                <Pill v-if="row.before" :tone="tone(row.before)">{{ t(`verdict.${row.before}`) }}</Pill>
              </td>
              <td><IconArrow class="size-3.5 text-surface-400" /></td>
              <td>
                <Pill :tone="tone(row.after)">{{ t(`verdict.${row.after}`) }}</Pill>
              </td>
              <td class="font-mono text-xs tabular-nums">{{ row.total == null ? '?' : row.total.toFixed(2) }}</td>
              <td>
                <span class="flex flex-wrap gap-1"
                  ><Pill v-for="f in row.flags" :key="f">{{ f }}</Pill></span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="gym-empty">{{ t('specWizard.save.testNone') }}</div>
    </section>

    <section>
      <SectionHeader :title="t('specWizard.save.storeTitle')" :hint="t('specWizard.save.storeHint')" />
      <div v-if="errors.length" class="gym-note border-s-bad mb-3">
        <span v-for="e in errors" :key="e" class="block">{{ t(`spec.error.${e}`) }}</span>
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField :label="t('specWizard.save.name')" :hint="t('specWizard.save.nameHint')" required>
          <InputText
            :model-value="name"
            fluid
            class="font-mono!"
            @update:model-value="emit('update:name', String($event ?? ''))"
          />
        </FormField>
        <div v-if="draft.skillId" class="flex items-end">
          <label class="flex items-center gap-2 text-sm">
            <Checkbox v-model="assign" binary />
            {{ t('specWizard.save.assign', { skill: draft.skillName ?? '' }) }}
          </label>
        </div>
      </div>
      <details class="group mt-4">
        <summary class="cursor-pointer text-sm text-surface-600 select-none dark:text-surface-300">
          {{ t('specWizard.save.yaml') }}
        </summary>
        <pre
          class="mt-2 max-h-96 overflow-auto rounded-lg border border-surface-300 bg-surface-50 p-3 font-mono text-xs dark:border-surface-700 dark:bg-surface-900"
          >{{ yaml }}</pre
        >
      </details>
      <div class="mt-5 flex flex-wrap items-center gap-3">
        <Button
          :label="t('specWizard.save.store')"
          :loading="busy"
          :disabled="busy || !!errors.length || !name.trim()"
          @click="emit('finish', { name, assignToSkill: assign })"
        >
          <template #icon><IconSave class="size-4" /></template>
        </Button>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.save.storeNote') }}</span>
      </div>
    </section>
  </div>
</template>
