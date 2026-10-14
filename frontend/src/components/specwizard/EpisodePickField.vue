<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatEpisodes, parseEpisodes } from '@/utils/episodes'

/**
 * Episodes picked the way pages are picked for printing: "1-3,6,8". Says
 * under the field what the pick names, or why it names nothing, before
 * anything is sent. Enter submits.
 */
const props = defineProps<{
  /** the number of episodes in the dataset, when known: a pick beyond is refused */
  datasetEpisodes?: number | null
  placeholder?: string
  /** a single line without the hint below, for toolbars */
  compact?: boolean
  /** the accessible name when no label stands next to the field */
  label?: string
}>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ submit: [episodes: number[], pick: string] }>()
const { t } = useI18n()

const state = computed(() => {
  const parsed = parseEpisodes(model.value)
  if (!parsed.ok)
    return { episodes: [] as number[], error: t(`specWizard.pick.${parsed.error}`, { part: parsed.part, max: 500 }) }
  const total = props.datasetEpisodes
  const beyond = total != null ? parsed.episodes.filter((e) => e >= total) : []
  if (beyond.length) return { episodes: [] as number[], error: t('specWizard.pick.beyond', { last: total! - 1 }) }
  return { episodes: parsed.episodes, error: '' }
})
const valid = computed(() => !state.value.error && state.value.episodes.length > 0)

function submit() {
  if (valid.value) emit('submit', state.value.episodes, formatEpisodes(state.value.episodes))
}

defineExpose({ valid, episodes: computed(() => state.value.episodes) })
</script>

<template>
  <div class="min-w-0">
    <InputText
      v-model="model"
      class="w-full font-mono"
      :size="compact ? 'small' : undefined"
      :placeholder="placeholder ?? t('specWizard.pick.placeholder')"
      :invalid="!!state.error"
      inputmode="numeric"
      spellcheck="false"
      :aria-label="label"
      @keydown.enter.prevent="submit"
    />
    <div v-if="!compact" class="mt-1 text-xs" :class="state.error ? 'text-bad' : 'text-surface-500 dark:text-surface-400'">
      <template v-if="state.error">{{ state.error }}</template>
      <template v-else-if="state.episodes.length">
        {{ t('specWizard.pick.count', { n: state.episodes.length }) }}
        <span class="font-mono">{{ formatEpisodes(state.episodes) }}</span>
      </template>
      <template v-else>{{ t('specWizard.pick.hint') }}</template>
    </div>
    <div v-else-if="state.error" class="text-bad mt-1 text-xs">{{ state.error }}</div>
  </div>
</template>
