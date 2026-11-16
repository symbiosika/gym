<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import { fmtBytes } from '@/utils/time'
import type { SkillStrategy, StrategyFile } from '@/types/gym'
import RunSheetPanel from '@/components/skill/RunSheetPanel.vue'
import IconClose from '~icons/carbon/close'
import IconPdf from '~icons/carbon/document-pdf'
import IconUpload from '~icons/carbon/upload'

/**
 * The strategy of a skill: how it is to be recorded, as its people wrote it
 * down. A description, pictures and PDFs, and the run sheet. All of it is
 * optional and none of it binds a block.
 */
const props = defineProps<{ tenantId: string; skillId: string }>()
const { t } = useI18n()
const ui = useUi()
const dialog = useDialog()

const strategy = ref<SkillStrategy | null>(null)
const text = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

/** what the server holds now; the description being typed is only replaced when it was not touched */
function adopt(next: SkillStrategy) {
  const untouched = text.value === (strategy.value?.text ?? '')
  strategy.value = next
  if (untouched) text.value = next.text
}
async function load() {
  try {
    strategy.value = null
    text.value = ''
    adopt(await gymApi.strategy(props.tenantId, props.skillId))
  } catch (e) {
    fail(e)
  }
}
onMounted(load)
watch(() => props.skillId, load)

async function saveText() {
  if (!strategy.value || text.value === strategy.value.text) return
  try {
    strategy.value = await gymApi.updateStrategyText(props.tenantId, props.skillId, text.value)
  } catch (e) {
    fail(e)
  }
}

const isImage = (f: StrategyFile) => f.mime.startsWith('image/')
const url = (f: StrategyFile) => gymApi.strategyFileUrl(props.tenantId, props.skillId, f.id)

async function chosen(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  busy.value = true
  try {
    // one after the other: each answer is the whole strategy, the last one counts
    for (const file of files) adopt(await gymApi.addStrategyFile(props.tenantId, props.skillId, file))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function removeFile(f: StrategyFile) {
  if (!(await dialog.confirm({ title: t('strategy.files.removeConfirm', { name: f.name }), danger: true }))) return
  try {
    adopt(await gymApi.removeStrategyFile(props.tenantId, props.skillId, f.id))
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div v-if="!strategy" class="py-10 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
  <div v-else class="flex flex-col gap-8">
    <p class="text-sm text-surface-600 dark:text-surface-300">{{ t('strategy.lead') }}</p>

    <section>
      <SectionHeader :title="t('strategy.text.title')" :hint="t('strategy.text.hint')" />
      <Textarea v-model="text" rows="8" fluid :placeholder="t('strategy.text.placeholder')" @blur="saveText" />
    </section>

    <section>
      <SectionHeader :title="t('strategy.files.title')" :hint="t('strategy.files.hint')">
        <SecondaryButton
          size="small"
          :disabled="busy"
          :loading="busy"
          :label="t('strategy.files.add')"
          @click="fileInput?.click()"
        >
          <template #icon><IconUpload /></template>
        </SecondaryButton>
      </SectionHeader>
      <input ref="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp,.pdf" multiple hidden @change="chosen" />
      <div v-if="!strategy.files.length" class="gym-empty">{{ t('strategy.files.none') }}</div>
      <div v-else class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <figure v-for="f in strategy.files" :key="f.id" class="gym-panel group relative overflow-hidden">
          <a :href="url(f)" target="_blank" rel="noopener noreferrer" class="block" :title="t('strategy.files.open')">
            <img v-if="isImage(f)" class="aspect-[4/3] w-full object-cover" :src="url(f)" :alt="f.name" loading="lazy" />
            <div v-else class="grid aspect-[4/3] w-full place-items-center bg-surface-100 text-surface-400 dark:bg-surface-800">
              <IconPdf class="size-10" aria-hidden="true" />
            </div>
          </a>
          <figcaption class="flex items-center gap-2 px-2.5 py-1.5 text-xs">
            <span class="min-w-0 grow truncate" :title="f.name">{{ f.name }}</span>
            <span class="shrink-0 font-mono text-surface-500 dark:text-surface-400">{{ fmtBytes(f.size) }}</span>
            <button
              type="button"
              class="shrink-0 cursor-pointer text-surface-500 hover:text-bad"
              :title="t('app.delete')"
              :aria-label="t('app.delete')"
              @click="removeFile(f)"
            >
              <IconClose />
            </button>
          </figcaption>
        </figure>
      </div>
    </section>

    <RunSheetPanel
      :tenant-id="tenantId"
      :skill-id="skillId"
      :strategy="strategy"
      @update="adopt"
      @error="(m) => ui.showBanner('err', m)"
    />
  </div>
</template>
