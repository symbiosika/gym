<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi, type UploadHandle } from '@/api/gym'
import { useGym } from '@/stores/gym'
import type { BlockKind, SkillListItem, SpecDraftView } from '@/types/gym'
import { fmtBytes } from '@/utils/time'
import { formatEpisodes, parseEpisodes } from '@/utils/episodes'
import EpisodePickField from './EpisodePickField.vue'
import IconUpload from '~icons/carbon/cloud-upload'
import IconCheck from '~icons/carbon/checkmark-filled'

/**
 * Step 1 of the spec wizard: what the spec is for and the sample it is worked
 * out from. The skill, the purpose and the episodes to analyse (a pick like "0-9") are
 * saved at once; the zip goes up in
 * chunks like any dataset and stays only for the time of the wizard. The
 * analysis starts by itself once the upload is complete.
 */
const props = defineProps<{ draft: SpecDraftView; tenantId: string; skills: SkillListItem[] }>()
const emit = defineEmits<{ update: [draft: SpecDraftView]; error: [message: string] }>()
const { t } = useI18n()
const gym = useGym()

const skillOptions = computed(() => [
  { label: t('specWizard.noSkill'), value: null as string | null },
  ...props.skills.map((s) => ({ label: s.name, value: s.id as string | null })),
])
const purposeOptions = computed(() =>
  (['recording', 'evaluation'] as BlockKind[]).map((p) => ({
    value: p,
    label: t(`specWizard.purpose.${p}`),
    hint: t(`specWizard.purposeHint.${p}`),
  })),
)

async function save(body: Parameters<typeof gymApi.updateSpecDraft>[2]) {
  try {
    emit('update', await gymApi.updateSpecDraft(props.tenantId, props.draft.id, body))
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
}

const pick = ref(props.draft.episodeSelection)
// saved shortly after the last keystroke, and only a pick that names episodes
let pickTimer: ReturnType<typeof setTimeout> | undefined
watch(pick, () => {
  clearTimeout(pickTimer)
  pickTimer = setTimeout(commitPick, 700)
})
onBeforeUnmount(() => clearTimeout(pickTimer))
function commitPick() {
  clearTimeout(pickTimer)
  const parsed = parseEpisodes(pick.value)
  if (!parsed.ok || !parsed.episodes.length) return
  const text = formatEpisodes(parsed.episodes)
  if (text !== props.draft.episodeSelection) void save({ episodes: text })
}

// ------------------------------------------------------------------ upload
const hot = ref(false)
const input = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const percent = ref(0)
const uploading = ref(false)
const failed = ref('')
let handle: UploadHandle = {}

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed'

function take(list: FileList | null) {
  const picked = Array.from(list ?? []).find(isZip)
  if (!picked) {
    if (list?.length) emit('error', t('specWizard.zipOnly'))
    return
  }
  file.value = picked
  handle = {}
  void upload()
}
function onDrop(e: DragEvent) {
  hot.value = false
  take(e.dataTransfer?.files ?? null)
}
function onPick(e: Event) {
  const el = e.target as HTMLInputElement
  take(el.files)
  el.value = ''
}

async function upload() {
  if (!file.value || uploading.value) return
  commitPick()
  uploading.value = true
  failed.value = ''
  try {
    const next = await gymApi.uploadSpecSample(props.tenantId, props.draft.id, file.value, (p) => (percent.value = p), handle)
    file.value = null
    emit('update', next)
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploading.value = false
  }
}

const hasSample = computed(() => props.draft.storageParts.length > 0)
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">{{ t('specWizard.sample.title') }}</h2>
    <p class="mt-1 mb-5 text-surface-600 dark:text-surface-300">{{ t('specWizard.sample.lead') }}</p>

    <Message v-if="!gym.critics.reachable" severity="warn" class="mb-4">
      {{ t('upload.criticsUnreachable') }}
      <span class="opacity-80">{{ gym.critics.error }}</span>
    </Message>

    <div class="grid gap-5 lg:grid-cols-2">
      <FormField :label="t('specWizard.sample.skill')" :hint="t('specWizard.sample.skillHint')">
        <Select
          :model-value="draft.skillId"
          :options="skillOptions"
          option-label="label"
          option-value="value"
          filter
          fluid
          @update:model-value="save({ skillId: $event as string | null })"
        />
      </FormField>

      <FormField :label="t('specWizard.sample.size')" :hint="t('specWizard.sample.sizeHint')">
        <EpisodePickField v-model="pick" @submit="commitPick" />
      </FormField>

      <div class="lg:col-span-2">
        <span class="gym-field">{{ t('specWizard.sample.purpose') }}</span>
        <div class="grid gap-2 sm:grid-cols-2" role="radiogroup">
          <button
            v-for="p in purposeOptions"
            :key="p.value"
            type="button"
            role="radio"
            :aria-checked="draft.purpose === p.value"
            class="cursor-pointer rounded-panel border p-3 text-start transition-colors"
            :class="
              draft.purpose === p.value
                ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                : 'border-surface-300 hover:border-primary dark:border-surface-700'
            "
            @click="draft.purpose !== p.value && save({ purpose: p.value })"
          >
            <span class="block font-medium">{{ p.label }}</span>
            <span class="block text-sm text-surface-500 dark:text-surface-400">{{ p.hint }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="mt-6">
      <span class="gym-field">{{ t('specWizard.sample.file') }}</span>
      <div
        v-if="hasSample && !uploading && !file"
        class="mb-3 flex flex-wrap items-center gap-3 rounded-panel border border-surface-300 bg-surface-50 p-3 dark:border-surface-800 dark:bg-surface-800/30"
      >
        <IconCheck class="text-ok size-5" />
        <div class="min-w-0 grow">
          <div class="truncate font-mono text-sm">{{ draft.fileName }}</div>
          <div class="text-xs text-surface-500 dark:text-surface-400">
            {{ fmtBytes(draft.bytes) }} · {{ t('specWizard.sample.temporary') }}
          </div>
        </div>
      </div>
      <button
        type="button"
        class="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-panel border-2 border-dashed px-5 py-8 transition-colors disabled:cursor-wait"
        :class="
          hot
            ? 'border-primary bg-primary/5'
            : 'border-surface-300 bg-surface-50 hover:border-primary dark:border-surface-700 dark:bg-surface-800/30'
        "
        :disabled="uploading"
        @dragover.prevent="hot = true"
        @dragleave="hot = false"
        @drop.prevent="onDrop"
        @click="input?.click()"
      >
        <IconUpload class="size-7 text-surface-400" />
        <b class="font-display text-base font-semibold">{{
          hasSample ? t('specWizard.sample.replace') : t('specWizard.sample.drop')
        }}</b>
        <span class="text-sm text-surface-500 dark:text-surface-400">{{ t('specWizard.sample.dropHint') }}</span>
      </button>
      <input ref="input" type="file" hidden accept=".zip,application/zip" @change="onPick" />

      <div v-if="file" class="mt-3 rounded-panel border border-surface-300 p-3 dark:border-surface-700">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="truncate font-mono">{{ file.name }}</span>
          <span class="font-mono text-xs tabular-nums text-surface-500 dark:text-surface-400">
            {{ percent < 100 ? `${percent} %` : t('specWizard.sample.handover') }}
          </span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
          <div class="h-full bg-primary transition-[width]" :style="{ width: `${percent}%` }" />
        </div>
        <div v-if="failed" class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-bad text-sm">{{ failed }}</span>
          <SecondaryButton size="small" :label="t('upload.retry')" @click="upload" />
        </div>
      </div>
    </div>
  </div>
</template>
