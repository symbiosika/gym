<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SpecDraftView } from '@/types/gym'
import { agreement, disagrees, type PreviewRow, type Verdict } from '@/utils/specSample'
import IconSearch from '~icons/carbon/search'
import IconUp from '~icons/carbon/thumbs-up'
import IconDown from '~icons/carbon/thumbs-down'

/**
 * The left side of the workbench: the episodes of the sample with the verdict
 * the spec gives them right now, the person's own word, and where the two
 * differ. An episode the person knows by number is opened from the field on
 * top; one outside the sample is analysed first and joins the list.
 */
const props = defineProps<{ draft: SpecDraftView; rows: PreviewRow[]; selected: number | null; datasetEpisodes: number | null }>()
const emit = defineEmits<{ select: [episode: number]; add: [episode: number] }>()
const { t } = useI18n()

const filter = ref<'all' | 'differ' | 'out' | 'judged'>('all')
const number = ref('')
const stats = computed(() => agreement(props.rows, props.draft.judgments))
const judgment = (episode: number) => props.draft.judgments[String(episode)]
const pending = computed(() =>
  props.draft.extraRuns.filter((r) => r.status === 'queued' || r.status === 'running').flatMap((r) => r.episodes),
)
const failed = computed(() => props.draft.extraRuns.filter((r) => r.status === 'failed'))

const shown = computed(() =>
  props.rows.filter((r) =>
    filter.value === 'differ'
      ? disagrees(r.verdict, judgment(r.episode))
      : filter.value === 'out'
        ? r.verdict !== 'accept'
        : filter.value === 'judged'
          ? !!judgment(r.episode)
          : true,
  ),
)
const tone = (v: Verdict) => (v === 'accept' ? 'ok' : v === 'review' ? 'warn' : 'bad')

function open() {
  const n = Number(number.value)
  if (!Number.isInteger(n) || n < 0) return
  if (props.rows.some((r) => r.episode === n)) emit('select', n)
  else emit('add', n)
  number.value = ''
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3">
    <form class="flex gap-1.5" @submit.prevent="open">
      <InputText
        v-model="number"
        inputmode="numeric"
        size="small"
        class="min-w-0 grow font-mono!"
        :placeholder="t('specWizard.bench.openPlaceholder', { max: datasetEpisodes != null ? datasetEpisodes - 1 : '?' })"
        :aria-label="t('specWizard.bench.open')"
      />
      <SecondaryButton type="submit" size="small" :aria-label="t('specWizard.bench.open')">
        <template #icon><IconSearch class="size-4" /></template>
      </SecondaryButton>
    </form>

    <div class="rounded-lg bg-surface-50 p-2 text-xs dark:bg-surface-800/40">
      <template v-if="stats.judged">
        <span class="font-semibold" :class="stats.differ.length ? 'text-warn' : 'text-ok'">{{
          t('specWizard.bench.agree', { n: stats.agree, of: stats.judged })
        }}</span>
      </template>
      <span v-else class="text-surface-500 dark:text-surface-400">{{ t('specWizard.bench.judgeHint') }}</span>
    </div>

    <div class="flex flex-wrap gap-1">
      <button
        v-for="f in ['all', 'differ', 'out', 'judged'] as const"
        :key="f"
        type="button"
        class="cursor-pointer rounded-md border px-2 py-0.5 text-xs"
        :class="filter === f ? 'border-primary bg-primary/10 text-primary' : 'border-surface-300 dark:border-surface-700'"
        @click="filter = f"
      >
        {{ t(`specWizard.bench.filter.${f}`) }}
      </button>
    </div>

    <ol class="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1">
      <li v-for="r in shown" :key="r.episode">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors"
          :class="r.episode === selected ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-surface-100 dark:hover:bg-surface-800'"
          @click="emit('select', r.episode)"
        >
          <span class="w-12 font-mono text-xs">E{{ r.episode }}</span>
          <Pill :tone="tone(r.verdict)">{{ t(`verdict.${r.verdict}`) }}</Pill>
          <span class="grow" />
          <span
            v-if="disagrees(r.verdict, judgment(r.episode))"
            class="bg-warn size-2 rounded-full"
            :title="t('specWizard.bench.differs')"
          />
          <IconUp v-if="judgment(r.episode) === 'accept'" class="text-ok size-3.5" />
          <IconDown v-else-if="judgment(r.episode) === 'reject'" class="text-bad size-3.5" />
        </button>
      </li>
      <li v-for="n in pending" :key="`p${n}`" class="flex items-center gap-2 px-2 py-1.5 text-sm text-surface-500">
        <span class="w-12 font-mono text-xs">E{{ n }}</span>
        <span class="animate-pulse text-xs">{{ t('specWizard.bench.analysing') }}</span>
      </li>
      <li v-if="!shown.length && !pending.length" class="gym-empty text-xs">{{ t('specWizard.bench.noneShown') }}</li>
    </ol>
    <p v-for="r in failed" :key="r.jobId" class="text-bad text-xs">
      {{ t('specWizard.bench.addFailed', { list: r.episodes.join(', ') }) }} {{ r.error }}
    </p>
  </div>
</template>
