<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import type { BlockView, Episode, HumanVerdict, SelectionChange, SelectionView } from '@/types/gym'
import { downloadBlob } from '@/utils/download'
import { defaultExportName, narrowToBlock } from '@/utils/selectionOverview'
import { today } from '@/utils/time'
import EpisodeTable from '@/components/EpisodeTable.vue'
import IconCheck from '~icons/carbon/checkmark'
import IconDownload from '~icons/carbon/download'

/**
 * Step 6: the episodes of this block, its datasets in one table. Bad ones
 * start unchecked; the operator decides. The episodes of the skill's other
 * blocks are decided in their own selection step.
 *
 * The export takes the selection of the whole skill, this block's ticks with
 * the rest, under a name the operator may change. Two downloads, and the
 * difference matters. The **dataset** is the one to
 * take: the selected episodes of every upload merged into one LeRobot dataset,
 * renumbered, that goes straight into training. The **manifest** is the small
 * one: the episode lists and the critics' files, for a pipeline that reads the
 * uploads itself.
 *
 * The operator may also overrule the critics on an episode (accept or reject).
 * That is saved at once, the critics' verdict stays beside it, and the
 * episode goes in (accept) or out (reject) of the selection with it.
 */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t } = useI18n()
const dialog = useDialog()

/** the selection of the whole skill, as the server has it: the export takes all of it */
const selection = ref<SelectionView | null>(null)
/** what this step shows and decides: the datasets of this block */
const shown = computed(() => (selection.value ? narrowToBlock(selection.value, props.block.id) : null))
/** the ticks of this block's episodes */
const selected = ref<Record<string, boolean>>({})
const initial = ref<Record<string, boolean>>({})
const busy = ref<'' | 'dl' | 'ds' | 'close'>('')
const verdictBusy = ref(false)
const fail = (e: unknown) => emit('error', e instanceof Error ? e.message : String(e))

onMounted(load)
async function load() {
  try {
    show(await gymApi.selection(props.tenantId, props.block.skillId))
  } catch (e) {
    fail(e)
  }
}
/** Take a view of the server over; the ticks not saved yet stay as the operator left them. */
function show(view: SelectionView, keep: SelectionChange[] = []) {
  selection.value = view
  const map: Record<string, boolean> = {}
  for (const d of narrowToBlock(view, props.block.id).datasets) for (const e of d.episodes) map[e.id] = e.selected
  initial.value = { ...map }
  for (const c of keep) if (c.episodeId in map && c.selected !== undefined) map[c.episodeId] = c.selected
  selected.value = map
}

const count = computed(() => Object.values(selected.value).filter(Boolean).length)
const total = computed(() => Object.keys(selected.value).length)
/** what the export takes: the selected episodes of every dataset of the skill still in the selection, this block's as ticked here */
const exportCount = computed(() => {
  let n = 0
  for (const d of selection.value?.datasets ?? []) {
    if (d.dataset.included === false) continue
    for (const e of d.episodes) if (e.id in selected.value ? selected.value[e.id] : e.selected) n++
  }
  return n
})
/** the name of the export, the merged dataset's folder and the zip; starts as the skill and the day */
const exportName = ref(defaultExportName(props.block.skill.name, today()))
const changes = computed(() =>
  Object.entries(selected.value)
    .filter(([id, v]) => initial.value[id] !== v)
    .map(([episodeId, v]) => ({ episodeId, selected: v })),
)

/*
 * Every tick is saved on its own, a moment after the last one: a quick run
 * of clicks goes to the server as one change, and nothing is lost when the
 * operator steps back or leaves.
 */
const saving = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(changes, (list) => {
  clearTimeout(timer)
  if (list.length) timer = setTimeout(() => void saveChanges().catch(fail), 700)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  void saveChanges().catch(() => undefined)
})

const toggle = (id: string, v: boolean) => (selected.value[id] = v)
const toggleMany = (ids: string[], v: boolean) => ids.forEach((id) => (selected.value[id] = v))
function setAll(v: boolean) {
  for (const id of Object.keys(selected.value)) selected.value[id] = v
}
const effective = (e: Episode) => e.humanVerdict ?? e.verdict
function onlyAccepted() {
  for (const d of shown.value?.datasets ?? []) for (const e of d.episodes) selected.value[e.id] = effective(e) === 'accept'
}
function withReview() {
  for (const d of shown.value?.datasets ?? []) for (const e of d.episodes) selected.value[e.id] = effective(e) !== 'reject'
}

let inflight: Promise<void> | null = null
async function saveChanges() {
  clearTimeout(timer)
  if (inflight) await inflight
  if (!changes.value.length) return
  const sent = changes.value
  saving.value = true
  inflight = (async () => {
    const view = await gymApi.updateSelection(props.tenantId, props.block.skillId, sent)
    // ticks made while this was on its way stay as the operator left them
    const later = changes.value.filter((c) => !sent.some((x) => x.episodeId === c.episodeId && x.selected === c.selected))
    show(view, later)
  })()
  try {
    await inflight
  } finally {
    inflight = null
    saving.value = false
  }
}

/** The operator's verdict on one episode, saved at once; the other unsaved ticks are kept. */
async function setVerdict(episodeId: string, humanVerdict: HumanVerdict | null) {
  verdictBusy.value = true
  const keep = changes.value.filter((c) => c.episodeId !== episodeId)
  try {
    show(await gymApi.updateSelection(props.tenantId, props.block.skillId, [{ episodeId, humanVerdict }]), keep)
  } catch (e) {
    fail(e)
  } finally {
    verdictBusy.value = false
  }
}

async function download() {
  busy.value = 'dl'
  try {
    await saveChanges()
    const { blob, fileName } = await gymApi.createExport(props.tenantId, props.block.skillId, exportName.value)
    downloadBlob(fileName, blob)
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/**
 * The merged dataset. The data critics build it from the uploads they hold,
 * so this takes a while and the file is large; the button says so instead of
 * looking like it hung.
 */
async function downloadDataset() {
  busy.value = 'ds'
  try {
    await saveChanges()
    const { blob, fileName } = await gymApi.createDatasetExport(props.tenantId, props.block.skillId, exportName.value)
    downloadBlob(fileName, blob)
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
async function closeBlock() {
  if (!(await dialog.confirm({ title: t('closed.confirmTitle'), text: t('closed.confirmText'), ok: t('review.closeBlock') })))
    return
  busy.value = 'close'
  try {
    await saveChanges()
    emit('update', await gymApi.closeBlock(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
async function back() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'review'))
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ t('selection.title') }}
    </h2>
    <p class="mt-1 mb-4 text-surface-600 dark:text-surface-300">
      {{ t('selection.lead') }}
    </p>

    <div v-if="!shown" class="py-10 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <template v-else>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <span class="font-display text-2xl leading-none font-semibold tabular-nums"
          >{{ count }}<small class="text-sm text-surface-500"> / {{ total }}</small></span
        >
        <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('selection.selectedHint') }}</span>
        <span class="grow"></span>
        <SecondaryButton size="small" :label="t('selection.onlyAccepted')" @click="onlyAccepted" />
        <SecondaryButton size="small" :label="t('selection.withReview')" @click="withReview" />
        <SecondaryButton size="small" :label="t('selection.all')" @click="setAll(true)" />
        <SecondaryButton size="small" :label="t('selection.none')" @click="setAll(false)" />
      </div>

      <div v-if="!shown.datasets.length" class="gym-empty">{{ t('selection.noneInBlock') }}</div>
      <EpisodeTable
        v-else
        :selection="shown"
        :selected="selected"
        :busy="verdictBusy"
        @toggle="toggle"
        @toggle-many="toggleMany"
        @verdict="setVerdict"
      />

      <!-- the export: the merged dataset is the one to take, the manifest is for pipelines that read the uploads -->
      <section class="mt-5 rounded-panel border border-surface-300 p-4 dark:border-surface-800">
        <div class="flex flex-wrap items-center gap-2">
          <b class="font-display text-base font-semibold">{{ t('selection.exportTitle') }}</b>
          <span class="text-sm text-surface-500 dark:text-surface-400">{{ t('selection.exportCount', { n: exportCount }) }}</span>
        </div>
        <div class="mt-3 flex flex-wrap items-end gap-2">
          <FormField class="min-w-56 grow" :label="t('selection.exportName')" :hint="t('selection.exportNameHint')">
            <InputText v-model="exportName" fluid :disabled="!!busy" maxlength="120" />
          </FormField>
          <SecondaryButton
            :disabled="!exportCount || !!busy"
            :loading="busy === 'dl'"
            :label="busy === 'dl' ? t('selection.downloading') : t('selection.download')"
            @click="download"
          />
          <Button
            :disabled="!exportCount || !!busy"
            :loading="busy === 'ds'"
            :label="busy === 'ds' ? t('selection.datasetBuilding') : t('selection.datasetExport')"
            @click="downloadDataset"
          >
            <template v-if="busy !== 'ds'" #icon><IconDownload class="size-4" /></template>
          </Button>
        </div>
        <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">
          {{ busy === 'ds' ? t('selection.datasetBuildingHint') : t('selection.datasetHint') }}
        </p>
      </section>

      <div class="gym-stepnav">
        <SecondaryButton :label="t('app.back')" @click="back" />
        <span class="grow"></span>
        <span
          class="flex items-center gap-1 font-mono text-xs"
          :class="saving || changes.length ? 'text-surface-500 dark:text-surface-400' : 'text-ok'"
          role="status"
        >
          <template v-if="saving || changes.length">{{ t('app.saving') }} …</template>
          <template v-else><IconCheck class="size-3.5" />{{ t('app.saved') }}</template>
        </span>
        <Button :disabled="busy === 'close'" :loading="busy === 'close'" :label="t('selection.closeBlock')" @click="closeBlock" />
      </div>
    </template>
  </div>
</template>
