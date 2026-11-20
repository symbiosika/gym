<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import type { PromptCheckEpisode, PromptCheckStatus, PromptCheckView, PromptVariants } from '@/types/gym'
import { distribution, variantLines } from '@/utils/prompts'
import Modal from '@/components/Modal.vue'
import IconRenew from '~icons/carbon/renew'

/**
 * The prompts of a block's datasets, opened from the upload step like the
 * spec manager. Two parts:
 *
 * - Check: the data critics place every episode by the appearance of what it
 *   picked among the skill's other datasets and say ok, propose (with the
 *   prompt that fits) or review. A dataset recorded under one stand-in prompt
 *   comes back as groups of episodes that look alike, to be named once each.
 *   Nothing is changed until the person saves; the upload itself is never
 *   rewritten, the merged export writes the prompt.
 * - Paraphrases: per prompt of the skill a list of variants, spread evenly
 *   over its episodes in a merged export (with or without the prompt itself).
 */
const props = defineProps<{
  tenantId: string
  skillId: string
  /** the block's datasets that the critics have judged */
  datasets: { id: string; name: string }[]
  /** shown by the guided tour: nothing is saved */
  readonly?: boolean
}>()
const visible = defineModel<boolean>('visible', { required: true })
const { t } = useI18n()
const ui = useUi()

const tab = ref<'check' | 'variants'>('check')
const tabs = computed(() => [
  { value: 'check', label: t('prompts.tabCheck') },
  { value: 'variants', label: t('prompts.tabVariants') },
])
const datasetId = ref('')
const view = ref<PromptCheckView | null>(null)
const loading = ref(false)
const error = ref('')
const saving = ref(false)
/** episode index → the prompt chosen here and not yet saved; null = back to the recorded one */
const edits = ref<Record<number, string | null>>({})
/** group → the prompt chosen for it (groups mode) */
const groupNames = ref<Record<number, string>>({})
/** the paraphrases being edited: prompt → lines, keep the original */
const variantText = ref<Record<string, string>>({})
const keepOriginal = ref<Record<string, boolean>>({})

watch(
  () => [visible.value, props.datasets.map((d) => d.id).join()],
  () => {
    if (!visible.value) return
    if (!props.datasets.some((d) => d.id === datasetId.value)) datasetId.value = props.datasets[0]?.id ?? ''
    void load()
  },
  { immediate: true },
)
watch(datasetId, (now, before) => {
  if (before && now !== before) void load()
})

async function load() {
  if (!datasetId.value) return
  loading.value = true
  error.value = ''
  edits.value = {}
  groupNames.value = {}
  try {
    view.value = await gymApi.datasetPrompts(props.tenantId, datasetId.value)
    resetVariants(view.value.variants)
  } catch (e) {
    view.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function resetVariants(v: PromptVariants) {
  variantText.value = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, s.variants.join('\n')]))
  keepOriginal.value = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, s.keepOriginal]))
}

const datasetOptions = computed(() => props.datasets.map((d) => ({ value: d.id, label: d.name })))
const candidateOptions = computed(() => (view.value?.candidates ?? []).map((c) => ({ value: c, label: c })))
const current = (e: PromptCheckEpisode) => (e.index in edits.value ? (edits.value[e.index] ?? e.task) : e.prompt)
const changedCount = computed(() => {
  if (!view.value) return 0
  return view.value.episodes.filter((e) => e.index in edits.value && current(e) !== e.prompt).length
})
const proposals = computed(() => (view.value?.episodes ?? []).filter((e) => e.status === 'propose' && e.proposed))
const groups = computed(() => {
  const out = new Map<number, PromptCheckEpisode[]>()
  for (const e of view.value?.episodes ?? []) if (e.group != null) out.set(e.group, [...(out.get(e.group) ?? []), e])
  return [...out.entries()].sort((a, b) => a[0] - b[0])
})

const TONES: Record<PromptCheckStatus, 'ok' | 'accent' | 'warn' | 'neutral'> = {
  ok: 'ok',
  propose: 'accent',
  review: 'warn',
  no_signature: 'neutral',
  not_analysed: 'neutral',
}
const tone = (s: PromptCheckStatus) => TONES[s]
const pct = (v: number | null) => (v == null ? '' : `${Math.round(v * 100)} %`)

function setPrompt(e: PromptCheckEpisode, prompt: string | null) {
  edits.value = { ...edits.value, [e.index]: prompt && prompt !== e.task ? prompt : null }
}
function takeProposals() {
  const next = { ...edits.value }
  for (const e of proposals.value) next[e.index] = e.proposed!
  edits.value = next
}
function nameGroup(group: number, prompt: string) {
  groupNames.value = { ...groupNames.value, [group]: prompt }
  const next = { ...edits.value }
  for (const [g, eps] of groups.value) if (g === group) for (const e of eps) next[e.index] = prompt !== e.task ? prompt : null
  edits.value = next
}

async function savePrompts() {
  if (!view.value || props.readonly) return
  const changes = view.value.episodes
    .filter((e) => e.index in edits.value && current(e) !== e.prompt)
    .map((e) => ({ index: e.index, prompt: edits.value[e.index] ?? null }))
  if (!changes.length) return
  saving.value = true
  try {
    const res = await gymApi.setDatasetPrompts(props.tenantId, datasetId.value, changes)
    ui.showBanner('ok', t('prompts.saved', { n: res.changed }))
    await load()
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

/** the prompts paraphrases can be given for: the skill's selection and those that already have some */
const variantPrompts = computed(() => {
  const counts = view.value?.selectionCounts ?? {}
  return [...new Set([...Object.keys(counts), ...Object.keys(view.value?.variants ?? {})])].sort(
    (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0),
  )
})
const preview = (prompt: string) =>
  distribution(
    view.value?.selectionCounts[prompt] ?? 0,
    variantLines(variantText.value[prompt] ?? ''),
    keepOriginal.value[prompt] ?? true,
  )

async function saveVariants() {
  if (props.readonly) return
  const body: PromptVariants = {}
  for (const p of variantPrompts.value) {
    const lines = variantLines(variantText.value[p] ?? '')
    if (lines.length) body[p] = { variants: lines, keepOriginal: keepOriginal.value[p] ?? true }
  }
  saving.value = true
  try {
    const saved = await gymApi.setPromptVariants(props.tenantId, props.skillId, body)
    if (view.value) view.value.variants = saved
    resetVariants(saved)
    ui.showBanner('ok', t('prompts.variantsSaved'))
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal v-model:visible="visible" size="xl" :title="t('prompts.title')" :hint="t('prompts.hint')">
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <TabBar v-model="tab" :tabs="tabs" />
      <span class="grow"></span>
      <Select
        v-if="tab === 'check' && datasetOptions.length > 1"
        v-model="datasetId"
        :options="datasetOptions"
        option-label="label"
        option-value="value"
        size="small"
        :aria-label="t('analysis.dataset')"
      />
      <SecondaryButton size="small" :loading="loading" :label="t('prompts.recheck')" @click="load">
        <template #icon><IconRenew /></template>
      </SecondaryButton>
    </div>

    <Message v-if="error" severity="warn" class="mb-3">{{ t('prompts.failed') }} {{ error }}</Message>
    <div v-else-if="loading && !view" class="gym-empty">{{ t('app.loading') }} …</div>

    <!-- the check -->
    <template v-if="view && tab === 'check'">
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">
        {{ view.mode === 'groups' ? t('prompts.leadGroups') : view.mode ? t('prompts.lead') : t('prompts.notAnalysed') }}
      </p>
      <div class="mb-3 flex flex-wrap items-center gap-1.5">
        <Pill v-for="(n, status) in view.counts" :key="status" :tone="tone(status as PromptCheckStatus)">
          {{ t(`prompts.status.${status}`) }} {{ n }}
        </Pill>
        <span
          v-for="c in view.confusable"
          :key="c.prompts.join()"
          class="text-xs text-surface-500 dark:text-surface-400"
          :title="c.prompts.join(' / ')"
        >
          · {{ t('prompts.confusable', { rate: pct(c.rate) }) }} {{ c.prompts.join(' / ') }}
        </span>
        <span class="grow"></span>
        <SecondaryButton
          v-if="proposals.length"
          size="small"
          :label="t('prompts.takeProposals', { n: proposals.length })"
          @click="takeProposals"
        />
      </div>

      <!-- a stand-in prompt: name each group of look-alike episodes once -->
      <div v-if="view.mode === 'groups' && groups.length" class="gym-panel mb-3 flex flex-col gap-2 p-3">
        <div v-for="[g, eps] in groups" :key="g" class="flex flex-wrap items-center gap-2 text-sm">
          <Pill tone="info">{{ t('prompts.group', { n: g }) }}</Pill>
          <span class="text-xs text-surface-500">{{ t('prompts.groupEpisodes', { n: eps.length }) }}</span>
          <span class="font-mono text-xs text-surface-500">{{ eps.map((e) => e.index).join(', ') }}</span>
          <span class="grow"></span>
          <Select
            :model-value="groupNames[g] ?? null"
            :options="candidateOptions"
            option-label="label"
            option-value="value"
            editable
            size="small"
            class="w-80"
            :placeholder="t('prompts.nameGroup')"
            @update:model-value="(v: string) => nameGroup(g, v)"
          />
        </div>
      </div>

      <div class="gym-panel max-h-[55vh] overflow-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>{{ t('prompts.recorded') }}</th>
              <th>{{ t('prompts.critics') }}</th>
              <th>{{ t('prompts.prompt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in view.episodes" :key="e.episodeId" :class="e.index in edits ? 'bg-primary/5' : ''">
              <td class="num font-mono text-xs">{{ e.index }}</td>
              <td class="max-w-56 truncate text-xs text-surface-500" :title="e.task">{{ e.task }}</td>
              <td class="whitespace-nowrap">
                <Pill :tone="tone(e.status)" :title="e.reason ? t(`prompts.reason.${e.reason}`) : undefined">
                  {{ t(`prompts.status.${e.status}`) }}
                </Pill>
                <span v-if="e.confidence != null" class="ms-1 font-mono text-xs text-surface-500">{{ pct(e.confidence) }}</span>
                <button
                  v-if="e.proposed && current(e) !== e.proposed"
                  type="button"
                  class="ms-2 cursor-pointer text-xs text-primary hover:underline"
                  :title="e.proposed"
                  @click="setPrompt(e, e.proposed)"
                >
                  {{ t('prompts.take') }}
                </button>
              </td>
              <td class="min-w-80">
                <Select
                  :model-value="current(e)"
                  :options="candidateOptions"
                  option-label="label"
                  option-value="value"
                  editable
                  size="small"
                  class="w-full"
                  :disabled="readonly"
                  :aria-label="t('prompts.prompt')"
                  @update:model-value="(v: string) => setPrompt(e, v)"
                />
                <span v-if="e.promptOverride && !(e.index in edits)" class="text-xs text-surface-500">
                  {{ t('prompts.corrected') }}
                  <button type="button" class="cursor-pointer text-primary hover:underline" @click="setPrompt(e, null)">
                    {{ t('prompts.backToRecorded') }}
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- the paraphrases -->
    <template v-if="view && tab === 'variants'">
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('prompts.leadVariants') }}</p>
      <div v-if="!variantPrompts.length" class="gym-empty">{{ t('prompts.noPrompts') }}</div>
      <div v-for="p in variantPrompts" :key="p" class="gym-panel mb-3 p-3">
        <div class="mb-2 flex flex-wrap items-baseline gap-2">
          <b class="font-medium">{{ p }}</b>
          <span class="text-xs text-surface-500">{{ t('prompts.inSelection', { n: view.selectionCounts[p] ?? 0 }) }}</span>
        </div>
        <Textarea
          v-model="variantText[p]"
          rows="3"
          class="w-full font-mono text-sm"
          :placeholder="t('prompts.variantsPlaceholder')"
          :disabled="readonly"
        />
        <div class="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
          <label class="flex items-center gap-1.5">
            <Checkbox
              binary
              :model-value="keepOriginal[p] ?? true"
              :disabled="readonly"
              @update:model-value="(v: boolean) => (keepOriginal = { ...keepOriginal, [p]: v })"
            />
            {{ t('prompts.keepOriginal') }}
          </label>
          <span v-if="preview(p).length > 1" class="text-xs text-surface-500">
            {{
              t('prompts.spread', {
                parts: preview(p)
                  .map((x) => x.n)
                  .join(' / '),
              })
            }}
          </span>
        </div>
      </div>
    </template>

    <template #footer>
      <span v-if="tab === 'check' && changedCount" class="me-auto text-sm text-surface-600 dark:text-surface-300">
        {{ t('prompts.unsaved', { n: changedCount }) }}
      </span>
      <SecondaryButton :label="t('app.close')" @click="visible = false" />
      <Button
        v-if="tab === 'check'"
        :disabled="!changedCount || readonly"
        :loading="saving"
        :label="t('prompts.save')"
        @click="savePrompts"
      />
      <Button v-else :disabled="readonly" :loading="saving" :label="t('prompts.saveVariants')" @click="saveVariants" />
    </template>
  </Modal>
</template>
