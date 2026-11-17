<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import type { BlockView, RunSheet } from '@/types/gym'

/**
 * "Import from run sheet": takes the run sheet of the block's skill over as
 * the recording plan, all rows or a range of them. Shows nothing when the
 * skill has no run sheet, and nothing for an evaluation: a block that takes
 * no sheet over works as it always did.
 */
const props = defineProps<{ block: BlockView; tenantId: string; disabled?: boolean }>()
const emit = defineEmits<{
  /** about to replace the plan: the caller saves or drops what it holds */
  before: []
  update: [block: BlockView]
  error: [message: string]
}>()
const { t } = useI18n()
const dialog = useDialog()

const sheet = ref<RunSheet | null>(null)
const rows = ref('')
const busy = ref(false)

onMounted(async () => {
  if (props.block.kind !== 'recording') return
  try {
    sheet.value = (await gymApi.strategy(props.tenantId, props.block.skill.id)).runSheet
  } catch {
    // the sheet is an offer: without it the step is as it was
  }
})

async function take() {
  if (
    props.block.plan &&
    !(await dialog.confirm({
      title: t('plan.runSheet.confirm'),
      text: t('plan.runSheet.confirmText'),
      ok: t('plan.runSheet.import'),
    }))
  )
    return
  emit('before')
  busy.value = true
  try {
    emit('update', await gymApi.planFromRunSheet(props.tenantId, props.block.id, rows.value.trim() || undefined))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span v-if="sheet" class="flex items-center gap-1.5">
    <InputText
      v-model="rows"
      class="w-24"
      size="small"
      :placeholder="`1-${sheet.rows.length}`"
      :title="t('plan.runSheet.rowsHint', { n: sheet.rows.length })"
      :aria-label="t('plan.runSheet.rows')"
      @keyup.enter="take"
    />
    <SecondaryButton
      :disabled="disabled || busy"
      :loading="busy"
      :label="t('plan.runSheet.import')"
      :title="t('plan.runSheet.hint', { name: sheet.fileName, n: sheet.rows.length })"
      @click="take"
    />
  </span>
</template>
