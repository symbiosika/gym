<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import { NONE } from '@/utils/select'
import { defaultGroupColumn, groupCount, runSheetTemplate, sheetToCsv } from '@/utils/runSheet'
import { downloadBlob } from '@/utils/download'
import { fmtDate } from '@/utils/time'
import type { SkillStrategy } from '@/types/gym'
import IconDownload from '~icons/carbon/download'
import IconUpload from '~icons/carbon/upload'

/**
 * The run sheet of a skill: a CSV with one row per episode to record. It is
 * read once and kept as rows; the person picks the column that groups the
 * rows into plan steps. A block may take the sheet over as its recording
 * plan, nothing more: the sheet is a guide. A template laid out the way a
 * sheet becomes plan steps is there to download, fill in elsewhere and upload
 * again; so is the sheet that is in, to change it outside GYM.
 */
const props = defineProps<{ tenantId: string; skillId: string; strategy: SkillStrategy; task?: string }>()
const emit = defineEmits<{ update: [strategy: SkillStrategy]; error: [message: string] }>()
const { t, locale } = useI18n()
const dialog = useDialog()

const sheet = computed(() => props.strategy.runSheet)
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const PREVIEW_ROWS = 20

const groupOptions = computed(() => [
  { value: NONE, label: t('strategy.runSheet.noGroup') },
  ...(sheet.value?.columns ?? []).map((c) => ({ value: c, label: c })),
])
const groupBy = computed({
  get: () => sheet.value?.groupBy ?? NONE,
  set: (value: string) => void regroup(value === NONE ? null : value),
})

async function send(fileName: string, csv: string, group: string | null): Promise<SkillStrategy | null> {
  busy.value = true
  try {
    const next = await gymApi.setRunSheet(props.tenantId, props.skillId, { fileName, csv, groupBy: group })
    emit('update', next)
    return next
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
    return null
  } finally {
    busy.value = false
  }
}

/** A new file: grouped by its "layout" column when it has one, which the person can change afterwards. */
async function chosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const csv = await file.text()
  // the server reads the file; only then are its columns known for certain
  const read = await send(file.name, csv, null)
  const group = read?.runSheet ? defaultGroupColumn(read.runSheet.columns) : null
  if (group) await send(file.name, csv, group)
}

/** The template, with the skill's task as the prompt; semicolons for a German spreadsheet. */
function downloadTemplate() {
  const csv = runSheetTemplate(props.task ?? '', locale.value === 'de' ? ';' : ',')
  downloadBlob(t('strategy.runSheet.templateFile'), new Blob([csv], { type: 'text/csv;charset=utf-8' }))
}

/** The sheet as it is in, to change it outside GYM and upload it again. */
function downloadSheet() {
  if (!sheet.value) return
  downloadBlob(
    sheet.value.fileName || 'run-sheet.csv',
    new Blob(['\uFEFF' + sheetToCsv(sheet.value)], { type: 'text/csv;charset=utf-8' }),
  )
}

/** The server keeps the rows, not the file: the same rows go back with the other column. */
async function regroup(group: string | null) {
  if (!sheet.value || group === sheet.value.groupBy) return
  await send(sheet.value.fileName, sheetToCsv(sheet.value), group)
}

async function remove() {
  if (
    !(await dialog.confirm({
      title: t('strategy.runSheet.removeConfirm'),
      text: t('strategy.runSheet.removeText'),
      danger: true,
    }))
  )
    return
  busy.value = true
  try {
    emit('update', await gymApi.removeRunSheet(props.tenantId, props.skillId))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section>
    <SectionHeader :title="t('strategy.runSheet.title')" :hint="t('strategy.runSheet.hint')">
      <SecondaryButton
        size="small"
        :label="t('strategy.runSheet.template')"
        :title="t('strategy.runSheet.templateHint')"
        @click="downloadTemplate"
      >
        <template #icon><IconDownload /></template>
      </SecondaryButton>
      <SecondaryButton v-if="sheet" size="small" :label="t('strategy.runSheet.download')" @click="downloadSheet">
        <template #icon><IconDownload /></template>
      </SecondaryButton>
      <SecondaryButton
        size="small"
        :disabled="busy"
        :label="sheet ? t('strategy.runSheet.replace') : t('strategy.runSheet.upload')"
        @click="fileInput?.click()"
      >
        <template #icon><IconUpload /></template>
      </SecondaryButton>
      <SecondaryButton v-if="sheet" size="small" class="text-bad!" :disabled="busy" :label="t('app.delete')" @click="remove" />
    </SectionHeader>
    <input ref="fileInput" type="file" accept=".csv,text/csv" hidden @change="chosen" />

    <div v-if="!sheet" class="gym-empty">{{ t('strategy.runSheet.none') }}</div>
    <template v-else>
      <div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <FormField class="w-56" :label="t('strategy.runSheet.groupBy')" :hint="t('strategy.runSheet.groupByHint')">
          <Select v-model="groupBy" fluid :disabled="busy" :options="groupOptions" option-label="label" option-value="value" />
        </FormField>
        <p class="pb-2 font-mono text-xs text-surface-500 dark:text-surface-400">
          {{ sheet.fileName }} · {{ t('strategy.runSheet.counts', { rows: sheet.rows.length, groups: groupCount(sheet) }) }} ·
          {{ fmtDate(sheet.importedAt, locale) }}
        </p>
      </div>
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th v-for="c in sheet.columns" :key="c" :class="c === sheet.groupBy ? 'text-primary' : ''">{{ c }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in sheet.rows.slice(0, PREVIEW_ROWS)" :key="i">
              <td class="num font-mono text-xs text-surface-500 dark:text-surface-400">{{ i + 1 }}</td>
              <td v-for="c in sheet.columns" :key="c" class="whitespace-nowrap">{{ row[c] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="sheet.rows.length > PREVIEW_ROWS" class="mt-1.5 text-xs text-surface-500 dark:text-surface-400">
        {{ t('strategy.runSheet.more', { n: sheet.rows.length - PREVIEW_ROWS }) }}
      </p>
    </template>
  </section>
</template>
