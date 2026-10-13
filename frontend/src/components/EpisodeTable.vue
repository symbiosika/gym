<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Episode, EpisodeVerdict, HumanVerdict, SelectionView } from '@/types/gym'
import { fmtDate, fmtSecs, fmtTime } from '@/utils/time'
import IconCheck from '~icons/carbon/checkmark'
import IconClose from '~icons/carbon/close'

/**
 * Every episode of every recording dataset of a skill in one table, with the critics'
 * verdict, score and the flags that decided it. `selected` holds the
 * operator's decisions by episode id.
 *
 * The verdict shown is the effective one: where the operator overruled the
 * critics (accept or reject), their word counts and the critics' stays beside
 * it. The selection spans every recording block of the skill, so every
 * dataset says its day and cell, and the ones of `currentBlockId` are marked.
 */
const props = defineProps<{
  selection: SelectionView
  selected: Record<string, boolean>
  readonly?: boolean
  /** the block the wizard is in: its datasets are marked */
  currentBlockId?: string
  /** a verdict is being saved */
  busy?: boolean
}>()
const emit = defineEmits<{
  toggle: [episodeId: string, value: boolean]
  toggleMany: [ids: string[], value: boolean]
  verdict: [episodeId: string, value: HumanVerdict | null]
}>()
const { t, locale } = useI18n()

/** the datasets of the block the wizard is in come first: those are the ones just recorded */
const datasets = computed(() =>
  props.currentBlockId
    ? [...props.selection.datasets].sort(
        (a, b) => Number(b.dataset.blockId === props.currentBlockId) - Number(a.dataset.blockId === props.currentBlockId),
      )
    : props.selection.datasets,
)
/** the critics' segment, when it is the one that counts, in the colour of their verdict */
const criticsSegment = (e: Episode) =>
  e.humanVerdict != null
    ? segment(false, 'neutral')
    : [
        segment(false, 'neutral'),
        e.verdict === 'accept'
          ? 'bg-ok-soft! text-ok!'
          : e.verdict === 'reject'
            ? 'bg-bad-soft! text-bad!'
            : 'bg-warn-soft! text-warn!',
      ].join(' ')
const rows = computed(() => props.selection.datasets.flatMap((d) => d.episodes.map((e) => ({ dataset: d.dataset, e }))))
const allOf = (ids: string[]) => ids.every((id) => props.selected[id])
const verdictTone = (v: EpisodeVerdict) => (v === 'accept' ? 'ok' : v === 'reject' ? 'bad' : v === 'review' ? 'warn' : 'neutral')
const score = (v: number | null) => (v == null ? '–' : v.toFixed(2))
const effective = (e: Episode): EpisodeVerdict => e.humanVerdict ?? e.verdict
/** the reason in one line; the full text is the tooltip */
const why = (e: Episode) => e.reason?.why || e.flags.join(', ') || ''

const segment = (active: boolean, tone: 'ok' | 'bad' | 'neutral') =>
  [
    'inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap transition-colors disabled:cursor-default',
    active
      ? tone === 'ok'
        ? 'bg-ok text-white'
        : tone === 'bad'
          ? 'bg-bad text-white'
          : 'bg-surface-700 text-white dark:bg-surface-200 dark:text-surface-900'
      : 'text-surface-600 hover:bg-surface-200 dark:text-surface-300 dark:hover:bg-surface-700',
  ].join(' ')
</script>

<template>
  <div class="gym-panel overflow-x-auto">
    <table class="gym-table">
      <thead>
        <tr>
          <th class="w-8" :title="t('selection.exportHead')">{{ t('selection.exportShort') }}</th>
          <th class="num">#</th>
          <th>{{ t('selection.task') }}</th>
          <th class="num">{{ t('selection.duration') }}</th>
          <th :title="readonly ? undefined : t('selection.verdictHint')">{{ t('selection.verdict') }}</th>
          <th class="num">{{ t('selection.score') }}</th>
          <th>{{ t('selection.why') }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="d in datasets" :key="d.dataset.id">
          <tr class="bg-surface-100/70 dark:bg-surface-800/40">
            <td>
              <Checkbox
                v-if="!readonly"
                binary
                :model-value="allOf(d.episodes.map((e) => e.id))"
                :title="t('selection.toggleDataset')"
                :aria-label="`${t('selection.toggleDataset')}: ${d.dataset.name}`"
                @update:model-value="
                  emit(
                    'toggleMany',
                    d.episodes.map((e) => e.id),
                    $event as boolean,
                  )
                "
              />
            </td>
            <td colspan="6">
              <b>{{ d.dataset.name }}</b>
              <Pill v-if="currentBlockId && d.dataset.blockId === currentBlockId" tone="ok" class="ms-2">{{
                t('selection.thisBlock')
              }}</Pill>
              <span class="text-xs text-surface-500 dark:text-surface-400">
                · {{ fmtDate(d.dataset.date, locale) }} {{ fmtTime(d.dataset.createdAt) }} · {{ d.dataset.cellName }} ·
                {{ t('selection.groupCount', { n: d.episodes.filter((e) => selected[e.id]).length, total: d.episodes.length }) }}
              </span>
              <Pill v-if="d.dataset.analysisStatus !== 'done'" tone="warn" class="ms-2">{{
                t(`analysisStatus.${d.dataset.analysisStatus}`)
              }}</Pill>
            </td>
          </tr>
          <tr
            v-for="row in rows.filter((r) => r.dataset.id === d.dataset.id)"
            :key="row.e.id"
            :class="selected[row.e.id] ? '' : 'opacity-50'"
          >
            <td>
              <Checkbox
                binary
                :disabled="readonly"
                :model-value="!!selected[row.e.id]"
                :aria-label="t('selection.exportEpisode', { n: row.e.index })"
                @update:model-value="emit('toggle', row.e.id, $event as boolean)"
              />
            </td>
            <td class="num">{{ row.e.index }}</td>
            <td class="max-w-64 truncate" :title="row.e.task">{{ row.e.task || '–' }}</td>
            <td class="num whitespace-nowrap">
              {{ fmtSecs(row.e.durationSeconds) }}
            </td>
            <td class="whitespace-nowrap">
              <Pill v-if="readonly" :tone="verdictTone(effective(row.e))">{{ t(`verdict.${effective(row.e)}`) }}</Pill>
              <!--
                One control for the verdict: the critics' word, or the person's
                accept or reject over it. It counts in every figure and moves
                the export tick with it.
              -->
              <div v-else class="inline-flex gap-0.5 rounded-lg bg-surface-100 p-0.5 dark:bg-surface-800" role="group">
                <button
                  type="button"
                  :class="criticsSegment(row.e)"
                  :disabled="busy"
                  :aria-pressed="row.e.humanVerdict == null"
                  :title="t('selection.asCritics')"
                  @click="row.e.humanVerdict != null && emit('verdict', row.e.id, null)"
                >
                  {{ t('selection.criticsShort') }}:
                  <span
                    class="ms-1"
                    :class="
                      row.e.humanVerdict == null
                        ? ''
                        : row.e.verdict === 'accept'
                          ? 'text-ok'
                          : row.e.verdict === 'reject'
                            ? 'text-bad'
                            : 'text-warn'
                    "
                    >{{ t(`verdict.${row.e.verdict}`) }}</span
                  >
                </button>
                <button
                  type="button"
                  :class="segment(row.e.humanVerdict === 'accept', 'ok')"
                  :disabled="busy"
                  :aria-pressed="row.e.humanVerdict === 'accept'"
                  :title="t('selection.iAccept')"
                  :aria-label="t('selection.iAccept')"
                  @click="row.e.humanVerdict !== 'accept' && emit('verdict', row.e.id, 'accept')"
                >
                  <IconCheck class="size-3.5" />
                </button>
                <button
                  type="button"
                  :class="segment(row.e.humanVerdict === 'reject', 'bad')"
                  :disabled="busy"
                  :aria-pressed="row.e.humanVerdict === 'reject'"
                  :title="t('selection.iReject')"
                  :aria-label="t('selection.iReject')"
                  @click="row.e.humanVerdict !== 'reject' && emit('verdict', row.e.id, 'reject')"
                >
                  <IconClose class="size-3.5" />
                </button>
              </div>
              <div
                v-if="row.e.humanVerdict && row.e.reviewedByName"
                class="mt-0.5 text-xs text-surface-500 dark:text-surface-400"
              >
                {{ row.e.reviewedByName }}
              </div>
            </td>
            <td class="num">{{ score(row.e.totalScore) }}</td>
            <td class="max-w-72 text-xs text-surface-500 dark:text-surface-400">
              <div class="truncate" :title="why(row.e)">{{ why(row.e) || '–' }}</div>
              <!-- what a critic could not do on this episode; a failed VLM lands here, the text is the tooltip -->
              <Pill v-if="row.e.error" tone="bad" class="mt-0.5" :title="row.e.error">{{ t('selection.criticError') }}</Pill>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
