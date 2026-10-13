<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi, type UploadHandle } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import type { BlockView, DatasetSummary } from '@/types/gym'
import { fmtBytes, fmtDateTime } from '@/utils/time'
import IconUpload from '~icons/carbon/cloud-upload'
import IconClose from '~icons/carbon/close'
import IconTrash from '~icons/carbon/trash-can'
import SpecPicker from '@/components/SpecPicker.vue'

/**
 * Step 4: upload the LeRobot datasets of the recording, each as one zip (data,
 * videos, meta). Several zips can be dropped at once; they are uploaded one
 * after the other and every one goes to the data critics as a dataset of its
 * own. The results arrive in the next step.
 *
 * The datasets already uploaded for the block are listed below the drop zone.
 * One that should not have been uploaded is removed from here: it goes with
 * its episodes, its stored zip and its critics job, so it drops out of the
 * analysis, the selection and every figure of the block.
 */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t, locale } = useI18n()
const gym = useGym()
const dialog = useDialog()

/** one zip in the list, from the drop until it is uploaded */
interface Pending {
  key: number
  file: File
  name: string
  percent: number
  state: 'waiting' | 'uploading' | 'done' | 'failed'
  error: string
  /** the chunked upload of this zip; kept across attempts so a retry resumes it */
  handle: UploadHandle
}

const queue = ref<Pending[]>([])
const hot = ref(false)
const busy = ref(false)
const specBusy = ref(false)
const specOpen = ref(false)
const removing = ref('')
const input = ref<HTMLInputElement | null>(null)
let seq = 0

const waiting = computed(() => queue.value.filter((x) => x.state === 'waiting'))
const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed'

function take(list: FileList | null) {
  const files = Array.from(list ?? [])
  const zips = files.filter(isZip)
  if (zips.length < files.length) emit('error', t('upload.onlyZip'))
  for (const file of zips) {
    queue.value.push({
      key: seq++,
      file,
      name: file.name.replace(/\.zip$/i, ''),
      percent: 0,
      state: 'waiting',
      error: '',
      handle: {},
    })
  }
}
function onDrop(ev: DragEvent) {
  hot.value = false
  take(ev.dataTransfer?.files ?? null)
}
function onPick(ev: Event) {
  const el = ev.target as HTMLInputElement
  take(el.files)
  el.value = ''
}
function remove(item: Pending) {
  if (item.state === 'uploading') return
  // an upload that was started but never finished holds chunks on the server
  if (item.handle.uploadId) {
    gymApi.abortDatasetUpload(props.tenantId, props.block.id, item.handle.uploadId).catch(() => undefined)
    item.handle.uploadId = undefined
  }
  queue.value = queue.value.filter((x) => x !== item)
}
/** The handle stays: what already arrived is not sent a second time. */
function retry(item: Pending) {
  item.state = 'waiting'
  item.error = ''
}

/** The spec is the skill's: changing it here changes it for every upload of the skill from now on. */
async function setSpec(name: string | null) {
  if (name === props.block.skill.criticSpecName) return
  specBusy.value = true
  try {
    await gymApi.updateSkill(props.tenantId, props.block.skillId, { criticSpecName: name })
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    specBusy.value = false
  }
}

/** Every waiting zip, one after the other; a failure stays in the list, the rest go on. */
async function upload() {
  if (busy.value || !waiting.value.length) return
  busy.value = true
  let uploaded = 0
  try {
    for (const item of queue.value) {
      if (item.state !== 'waiting') continue
      item.state = 'uploading'
      item.percent = 0
      try {
        await gymApi.uploadDataset(
          props.tenantId,
          props.block.id,
          item.file,
          item.name.trim() || undefined,
          (p) => (item.percent = p),
          item.handle,
        )
        item.state = 'done'
        uploaded++
      } catch (e) {
        item.state = 'failed'
        item.error = e instanceof Error ? e.message : String(e)
        emit('error', item.error)
      }
    }
  } finally {
    busy.value = false
  }
  if (uploaded) {
    try {
      emit('update', await gymApi.block(props.tenantId, props.block.id))
      queue.value = queue.value.filter((x) => x.state !== 'done')
    } catch (e) {
      emit('error', e instanceof Error ? e.message : String(e))
    }
  }
}
const statusTone = (s: DatasetSummary['analysisStatus']) => (s === 'done' ? 'ok' : s === 'failed' ? 'bad' : 'warn')

async function removeDataset(d: DatasetSummary) {
  if (removing.value) return
  if (
    !(await dialog.confirm({
      title: t('upload.removeDatasetConfirm'),
      text: t('upload.removeDatasetText', { name: d.name }),
      danger: true,
    }))
  )
    return
  removing.value = d.id
  try {
    await gymApi.deleteDataset(props.tenantId, d.id)
    emit('update', await gymApi.block(props.tenantId, props.block.id))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    removing.value = ''
  }
}

async function toReview() {
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'review'))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

async function back() {
  try {
    emit('update', await gymApi.startRecording(props.tenantId, props.block.id))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ t('upload.title') }}
    </h2>
    <p class="mt-1 mb-4 text-surface-600 dark:text-surface-300">
      {{ block.kind === 'evaluation' ? t('upload.leadEvaluation') : t('upload.lead') }}
    </p>

    <Message v-if="!gym.critics.reachable" severity="warn" class="mb-4">
      {{ t('upload.criticsUnreachable') }}
      <span class="opacity-80">{{ gym.critics.error }}</span>
    </Message>

    <button
      type="button"
      class="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-panel border-2 border-dashed px-5 py-10 transition-colors"
      :class="
        hot
          ? 'border-primary bg-primary/5'
          : 'border-surface-300 bg-surface-50 hover:border-primary dark:border-surface-700 dark:bg-surface-800/30'
      "
      @dragover.prevent="hot = true"
      @dragleave="hot = false"
      @drop.prevent="onDrop"
      @click="input?.click()"
    >
      <IconUpload class="size-7 text-surface-400" />
      <b class="font-display text-base font-semibold">{{ t('upload.drop') }}</b>
      <span class="text-sm text-surface-500 dark:text-surface-400">{{ t('upload.dropHint') }}</span>
    </button>
    <input ref="input" type="file" hidden multiple accept=".zip,application/zip" @change="onPick" />

    <div v-if="queue.length" class="mt-4">
      <div class="gym-field mb-2">{{ t('upload.files') }} · {{ queue.length }}</div>
      <div class="flex flex-col gap-2">
        <div
          v-for="item in queue"
          :key="item.key"
          class="grid items-center gap-x-4 gap-y-2 rounded-panel border border-surface-300 bg-surface-50 p-3 sm:grid-cols-[1fr_1fr_auto] dark:border-surface-800 dark:bg-surface-800/30"
        >
          <div class="min-w-0">
            <div class="truncate font-mono text-sm" :title="item.file.name">{{ item.file.name }}</div>
            <div class="text-xs text-surface-500 dark:text-surface-400">{{ fmtBytes(item.file.size) }}</div>
          </div>
          <FormField :label="t('upload.name')">
            <InputText
              v-model="item.name"
              fluid
              :disabled="item.state !== 'waiting' && item.state !== 'failed'"
              :placeholder="t('upload.namePlaceholder')"
            />
          </FormField>
          <div class="flex items-center gap-2 justify-self-end">
            <Pill v-if="item.state === 'waiting'">{{ t('upload.waiting') }}</Pill>
            <Pill v-else-if="item.state === 'done'" tone="ok">{{ t('upload.done') }}</Pill>
            <template v-else-if="item.state === 'failed'">
              <Pill tone="bad" :title="item.error">{{ t('upload.failed') }}</Pill>
              <SecondaryButton size="small" :label="t('upload.retry')" @click="retry(item)" />
            </template>
            <span v-else class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400">{{
              item.percent < 100 ? `${item.percent} %` : t('upload.handingOver')
            }}</span>
            <button
              v-if="item.state !== 'uploading'"
              type="button"
              class="cursor-pointer p-1 text-surface-500 hover:text-bad"
              :title="t('upload.remove')"
              :aria-label="t('upload.remove')"
              @click="remove(item)"
            >
              <IconClose class="size-4" />
            </button>
          </div>
          <div
            v-if="item.state === 'uploading'"
            class="h-1.5 overflow-hidden rounded-full bg-surface-200 sm:col-span-3 dark:bg-surface-800"
          >
            <i class="bg-primary block h-full rounded-full transition-[width]" :style="{ width: `${item.percent}%` }"></i>
          </div>
          <div v-if="item.state === 'failed' && item.error" class="text-bad text-xs sm:col-span-3">{{ item.error }}</div>
        </div>
      </div>
    </div>

    <div v-if="block.datasets.length" class="mt-6">
      <div class="gym-field mb-2">{{ t('upload.uploaded') }} · {{ block.datasets.length }}</div>
      <div class="flex flex-col gap-2">
        <div
          v-for="d in block.datasets"
          :key="d.id"
          class="flex items-center gap-4 rounded-panel border border-surface-300 bg-surface-50 p-3 dark:border-surface-800 dark:bg-surface-800/30"
        >
          <div class="min-w-0 grow">
            <div class="truncate font-medium" :title="d.name">{{ d.name }}</div>
            <div class="text-xs text-surface-500 dark:text-surface-400">
              {{ fmtDateTime(d.createdAt, locale) }}
              <template v-if="d.episodeCount"> · {{ t('upload.episodes', { n: d.episodeCount }) }}</template>
            </div>
          </div>
          <Pill :tone="statusTone(d.analysisStatus)">{{ t(`analysisStatus.${d.analysisStatus}`) }}</Pill>
          <SecondaryButton
            size="small"
            :disabled="busy || !!removing"
            :loading="removing === d.id"
            :label="t('upload.removeDataset')"
            :aria-label="`${t('upload.removeDataset')}: ${d.name}`"
            @click="removeDataset(d)"
          >
            <template #icon><IconTrash class="size-4" /></template>
          </SecondaryButton>
        </div>
      </div>
      <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('upload.already') }}</p>
    </div>

    <!-- the spec is the skill's and rarely changes: one line, opened on demand -->
    <div class="mt-4 rounded-panel border border-surface-300 px-3.5 py-2.5 dark:border-surface-800">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="gym-field mb-0">{{ t('upload.spec') }}</span>
        <b class="font-medium">{{ block.skill.criticSpecName ?? t('upload.specAuto') }}</b>
        <span class="grow"></span>
        <button type="button" class="text-primary cursor-pointer text-sm hover:underline" @click="specOpen = !specOpen">
          {{ specOpen ? t('app.close') : t('upload.specChange') }}
        </button>
      </div>
      <FormField v-if="specOpen" class="mt-2.5" :hint="t('upload.specHint')">
        <SpecPicker
          :model-value="block.skill.criticSpecName"
          :tenant-id="tenantId"
          :disabled="busy || specBusy"
          @update:model-value="setSpec"
        />
      </FormField>
    </div>

    <div class="gym-stepnav">
      <!-- explicit: this opens the recording again and its clock runs -->
      <SecondaryButton
        :disabled="busy"
        :label="block.kind === 'evaluation' ? t('review.runMore') : t('review.recordMore')"
        @click="back"
      />
      <span class="grow"></span>
      <!-- nothing left to send: the way on is the analysis of what is already there -->
      <Button v-if="!waiting.length && block.datasets.length && !busy" :label="t('upload.toReview')" @click="toReview" />
      <template v-else>
        <span v-if="!waiting.length" class="text-xs text-surface-500 dark:text-surface-400">{{ t('upload.nothingYet') }}</span>
        <Button
          :disabled="!waiting.length || busy"
          :loading="busy"
          :label="waiting.length > 1 ? t('upload.uploadMany', { n: waiting.length }) : t('upload.upload')"
          @click="upload"
        />
      </template>
    </div>
  </div>
</template>
