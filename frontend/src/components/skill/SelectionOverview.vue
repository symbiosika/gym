<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import { downloadBlob } from '@/utils/download'
import { defaultExportName, narrowSelection } from '@/utils/selectionOverview'
import { fmtDate, today } from '@/utils/time'
import type { SelectionOverview, SelectionOverviewRow, SelectionView } from '@/types/gym'
import EpisodeTable from '@/components/EpisodeTable.vue'
import SelectionMetrics from '@/components/skill/SelectionMetrics.vue'
import IconChevronDown from '~icons/carbon/chevron-down'
import IconChevronRight from '~icons/carbon/chevron-right'
import IconDownload from '~icons/carbon/download'
import IconLaunch from '~icons/carbon/launch'

/**
 * The Episodes tab of a skill: its recording datasets, one row each, with
 * what is selected of them, and the figures over the selection as a whole.
 *
 * A dataset is taken in or out of the selection here as a whole; which of its
 * episodes are ticked is decided in the block's wizard and only looked at
 * here (a row opens to its episodes, read-only); each row links to the
 * selection step of its block, where the ticks and the pending reviews are
 * dealt with. Three ways out: the light export, the merged dataset of
 * everything selected (both under a name the person may change), and one
 * dataset unfiltered with all its episodes.
 */
const props = defineProps<{ tenantId: string; skillId: string; skillName: string }>()
const emit = defineEmits<{
  /** something a saved export of the skill depends on changed: the caller reads the skill again */
  exported: []
}>()
const { t, locale } = useI18n()
const ui = useUi()
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

const overview = ref<SelectionOverview | null>(null)
/** the episodes themselves, read once a row is opened */
const selection = ref<SelectionView | null>(null)
const open = ref<Record<string, boolean>>({})
/** what is running: 'export', 'merged', `all:<datasetId>` or `inc:<datasetId>` */
const busy = ref('')
/** the name of the export, the merged dataset's folder and the zip; starts as the skill and the day */
const exportName = ref(defaultExportName(props.skillName, today()))
/** the selection step of a dataset's block, opened to look at; the wizard says how to work there */
const selectionStepOf = (row: SelectionOverviewRow) => ({
  name: 'Block',
  params: { tenantId: props.tenantId, blockId: row.dataset.blockId },
  query: { step: 'selection' },
})

async function load() {
  try {
    overview.value = await gymApi.selectionOverview(props.tenantId, props.skillId)
  } catch (e) {
    fail(e)
  }
}
watch(
  () => props.skillId,
  () => {
    exportName.value = defaultExportName(props.skillName, today())
    overview.value = null
    selection.value = null
    open.value = {}
    void load()
  },
  { immediate: true },
)

const datasetNames = computed(() =>
  Object.fromEntries((overview.value?.datasets ?? []).map((d) => [d.dataset.id, d.dataset.name])),
)
const anySelected = computed(() => (overview.value?.totals.selected ?? 0) > 0)

async function toggle(row: SelectionOverviewRow) {
  const id = row.dataset.id
  open.value = { ...open.value, [id]: !open.value[id] }
  if (open.value[id] && !selection.value) {
    try {
      selection.value = await gymApi.selection(props.tenantId, props.skillId)
    } catch (e) {
      fail(e)
    }
  }
}
const episodesOf = (id: string) => (selection.value ? narrowSelection(selection.value, id) : null)
const tickedOf = (view: SelectionView) =>
  Object.fromEntries(view.datasets.flatMap((d) => d.episodes.map((e) => [e.id, e.selected])))

async function setIncluded(row: SelectionOverviewRow, included: boolean) {
  busy.value = `inc:${row.dataset.id}`
  try {
    await gymApi.setDatasetIncluded(props.tenantId, row.dataset.id, included)
    await load()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/** The light export or the merged dataset of everything selected; both are saved as an export of the skill. */
async function exportSelection(kind: 'export' | 'merged') {
  busy.value = kind
  try {
    const call = kind === 'merged' ? gymApi.createDatasetExport : gymApi.createExport
    const { blob, fileName } = await call(props.tenantId, props.skillId, exportName.value)
    downloadBlob(fileName, blob)
    emit('exported')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/** One dataset with all its episodes. A download only, nothing is saved as an export. */
async function exportAll(row: SelectionOverviewRow) {
  busy.value = `all:${row.dataset.id}`
  try {
    const { blob, fileName } = await gymApi.exportUnfiltered(props.tenantId, row.dataset.id)
    downloadBlob(fileName, blob)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div v-if="!overview" class="py-10 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
  <div v-else-if="!overview.datasets.length" class="gym-empty">{{ t('skill.noEpisodes') }}</div>
  <div v-else class="flex flex-col gap-8">
    <section>
      <SectionHeader
        :title="t('skill.episodesTab.datasets')"
        :hint="t('skill.episodesTab.selectedOf', { n: overview.totals.selected, total: overview.totals.episodes })"
      >
        <SecondaryButton
          size="small"
          :disabled="!anySelected || !!busy"
          :loading="busy === 'export'"
          :label="t('skill.episodesTab.export')"
          :title="anySelected ? t('skill.episodesTab.exportHint') : t('skill.episodesTab.nothingSelected')"
          @click="exportSelection('export')"
        />
        <Button
          size="small"
          :disabled="!anySelected || !!busy"
          :loading="busy === 'merged'"
          :label="busy === 'merged' ? t('skill.episodesTab.merging') : t('skill.episodesTab.exportMerged')"
          :title="anySelected ? t('skill.episodesTab.exportMergedHint') : t('skill.episodesTab.nothingSelected')"
          @click="exportSelection('merged')"
        />
      </SectionHeader>
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('skill.episodesTab.lead') }}</p>
      <FormField class="mb-3 max-w-md" :label="t('selection.exportName')" :hint="t('selection.exportNameHint')">
        <InputText v-model="exportName" fluid :disabled="!!busy" maxlength="120" />
      </FormField>

      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th :title="t('skill.episodesTab.includedHint')">{{ t('skill.episodesTab.included') }}</th>
              <th>{{ t('analysis.dataset') }}</th>
              <th>{{ t('day.date') }} · {{ t('skill.cell') }}</th>
              <th class="num">{{ t('skill.selected') }}</th>
              <th class="num">{{ t('verdict.accept') }}</th>
              <th class="num">{{ t('verdict.review') }}</th>
              <th class="num">{{ t('verdict.reject') }}</th>
              <th class="num" :title="t('skill.episodesTab.graspSpreadHint')">{{ t('skill.episodesTab.graspSpread') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in overview.datasets" :key="row.dataset.id">
              <tr :class="row.dataset.included ? '' : 'opacity-60'">
                <td>
                  <Checkbox
                    binary
                    :model-value="row.dataset.included"
                    :disabled="busy === `inc:${row.dataset.id}`"
                    :aria-label="t('skill.episodesTab.includedHint')"
                    @update:model-value="(value: boolean) => setIncluded(row, value)"
                  />
                </td>
                <td>
                  <button
                    type="button"
                    class="flex cursor-pointer items-center gap-1 text-start font-medium hover:text-primary"
                    :aria-expanded="!!open[row.dataset.id]"
                    :title="t('skill.episodesTab.showEpisodes')"
                    @click="toggle(row)"
                  >
                    <IconChevronDown v-if="open[row.dataset.id]" class="shrink-0" aria-hidden="true" />
                    <IconChevronRight v-else class="shrink-0" aria-hidden="true" />
                    {{ row.dataset.name }}
                  </button>
                  <span class="ms-5 flex flex-wrap gap-1.5 pt-0.5 empty:hidden">
                    <Pill v-if="!row.dataset.included">{{ t('skill.episodesTab.excluded') }}</Pill>
                    <RouterLink
                      v-if="row.reviewPending"
                      :to="selectionStepOf(row)"
                      :title="t('skill.episodesTab.toSelection')"
                      class="hover:underline"
                      ><Pill tone="warn">{{ t('skill.episodesTab.reviewPending', { n: row.reviewPending }) }}</Pill></RouterLink
                    >
                    <Pill v-if="row.dataset.analysisStatus !== 'done'" tone="info">{{
                      t(`analysisStatus.${row.dataset.analysisStatus}`)
                    }}</Pill>
                  </span>
                </td>
                <td class="whitespace-nowrap">
                  <RouterLink
                    class="font-mono text-xs text-primary hover:underline"
                    :to="{ name: 'Block', params: { tenantId, blockId: row.dataset.blockId } }"
                    :title="t('skill.episodesTab.toBlock')"
                    >{{ fmtDate(row.dataset.date, locale) }}</RouterLink
                  >
                  · {{ row.dataset.cellName }}
                </td>
                <td class="num whitespace-nowrap">{{ row.selected }} / {{ row.episodes }}</td>
                <td class="num">{{ row.accepted }}</td>
                <td class="num">{{ row.review }}</td>
                <td class="num">{{ row.rejected }}</td>
                <td class="num font-mono text-xs whitespace-nowrap">
                  {{ row.graspSpreadCm != null ? `${row.graspSpreadCm.toFixed(1)} cm` : '–' }}
                </td>
                <td class="text-end whitespace-nowrap">
                  <RouterLink
                    :to="selectionStepOf(row)"
                    class="me-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    :title="t('skill.episodesTab.toSelection')"
                    ><IconLaunch class="size-3.5" aria-hidden="true" />{{ t('skill.episodesTab.selectionStep') }}</RouterLink
                  >
                  <SecondaryButton
                    size="small"
                    :disabled="!row.dataset.stored || !!busy"
                    :loading="busy === `all:${row.dataset.id}`"
                    :label="t('skill.episodesTab.exportAll')"
                    :title="
                      row.dataset.stored
                        ? t('skill.episodesTab.exportAllHint', { n: row.episodes })
                        : t('skill.episodesTab.notStored')
                    "
                    @click="exportAll(row)"
                  >
                    <template #icon><IconDownload /></template>
                  </SecondaryButton>
                </td>
              </tr>
              <tr v-if="open[row.dataset.id]">
                <td colspan="9" class="bg-surface-50! p-3! dark:bg-surface-800/30!">
                  <div v-if="!episodesOf(row.dataset.id)" class="py-4 text-center font-mono text-xs text-surface-500">
                    {{ t('app.loading') }} …
                  </div>
                  <template v-else>
                    <p class="mb-2 text-xs text-surface-500 dark:text-surface-400">{{ t('skill.episodesTab.readOnly') }}</p>
                    <EpisodeTable
                      :selection="episodesOf(row.dataset.id)!"
                      :selected="tickedOf(episodesOf(row.dataset.id)!)"
                      readonly
                    />
                  </template>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <SelectionMetrics :metrics="overview.metrics" :points="overview.points" :names="datasetNames" />
  </div>
</template>
