<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import type { CriticsHardCriticInfo, CriticsSpecInfo } from '@/types/gym'
import { fromSpec, fromYaml, presetSpec, toYaml, validateSpec, type PresetId, type SpecForm } from '@/utils/spec'
import Modal from '@/components/Modal.vue'
import SpecForm_ from '@/components/spec/SpecForm.vue'
import SpecPresetPicker from '@/components/spec/SpecPresetPicker.vue'
import IconUpload from '~icons/carbon/upload'
import IconAdd from '~icons/carbon/add'
import IconTrash from '~icons/carbon/trash-can'

/**
 * The place where critics specs are maintained: the list on the left, the
 * picked spec on the right as a form (task, objects, success indicators,
 * technical checks, scoring) with the YAML behind it one tab away. A new spec
 * starts from a preset, the pattern of the task. A spec says what the critics
 * check for a task, so it is read, written, uploaded and removed here instead
 * of only in the critics service. The list says which skills work with which
 * spec, so removing one is never a surprise.
 */
const props = defineProps<{ tenantId: string }>()
const visible = defineModel<boolean>('visible', { required: true })
/** the name the picker should select after the dialog closes, when one was written */
const emit = defineEmits<{ picked: [name: string] }>()
const { t } = useI18n()
const gym = useGym()
const ui = useUi()
const dialog = useDialog()

const specs = ref<CriticsSpecInfo[]>([])
const critics = ref<CriticsHardCriticInfo[]>([])
const loading = ref(false)
const listError = ref('')
const busy = ref('')

/** the spec in the editor: null while nothing is open */
const form = ref<SpecForm | null>(null)
const name = ref('')
const usedBy = ref<string[]>([])
const isNew = ref(false)
/** what was loaded or last saved, to know when the form was edited */
const snapshot = ref('')
/** presets while a new spec has no shape yet, then the form or the YAML */
const view = ref<'presets' | 'form' | 'yaml'>('form')
const yamlText = ref('')
const yamlError = ref('')
const errors = ref<string[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const tabs = computed(() => [
  { value: 'form', label: t('spec.tabForm') },
  { value: 'yaml', label: t('spec.tabYaml') },
])
const stateOf = () => JSON.stringify({ name: name.value, form: form.value })
const dirty = computed(() => (view.value === 'presets' ? false : isNew.value || stateOf() !== snapshot.value))
const open = computed(() => form.value !== null || view.value === 'presets')
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

async function loadList() {
  loading.value = true
  try {
    specs.value = await gymApi.specs(props.tenantId)
    listError.value = ''
  } catch (e) {
    // an unreachable critics service is already said above the list; no banner on top of it
    specs.value = []
    listError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(visible, (on) => {
  if (!on) return
  closeEditor()
  loadList()
  // the parameters of the technical checks; without the service the form still lists every check
  gymApi.hardCritics(props.tenantId).then(
    (rows) => (critics.value = rows),
    () => (critics.value = []),
  )
})

function closeEditor() {
  form.value = null
  name.value = ''
  usedBy.value = []
  isNew.value = false
  snapshot.value = ''
  view.value = 'form'
  yamlText.value = ''
  yamlError.value = ''
  errors.value = []
}

function show(loaded: SpecForm, specName: string, users: string[], fresh: boolean) {
  form.value = loaded
  name.value = specName
  usedBy.value = users
  isNew.value = fresh
  view.value = 'form'
  yamlError.value = ''
  errors.value = []
  snapshot.value = stateOf()
}

async function openSpec(spec: CriticsSpecInfo) {
  if (dirty.value && !(await confirmDiscard())) return
  busy.value = `open:${spec.name}`
  try {
    const detail = await gymApi.spec(props.tenantId, spec.name)
    show(detail.spec ? fromSpec(detail.spec) : fromYaml(detail.yaml), detail.name, detail.usedBy, false)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function newSpec() {
  if (dirty.value && !(await confirmDiscard())) return
  form.value = null
  name.value = ''
  usedBy.value = []
  isNew.value = true
  errors.value = []
  view.value = 'presets'
}

function pickPreset(id: PresetId) {
  show(presetSpec(id), '', [], true)
}

const confirmDiscard = () =>
  dialog.confirm({ title: t('spec.discardTitle'), text: t('spec.discardText'), ok: t('spec.discardOk'), danger: true })

/** The YAML view shows the form as text; leaving it reads the text back into the form. */
function switchView(next: string) {
  if (!form.value) return
  if (next === 'yaml' && view.value !== 'yaml') {
    yamlText.value = toYaml(form.value, name.value.trim() || 'new-spec')
    yamlError.value = ''
    view.value = 'yaml'
    return
  }
  if (next === 'form' && view.value === 'yaml') {
    if (!applyYaml()) return
    view.value = 'form'
  }
}

/** Read the YAML text into the form; false when it does not parse, with the reason shown under the text. */
function applyYaml(): boolean {
  try {
    const parsed = fromYaml(yamlText.value)
    const own = (yamlText.value.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (own && !name.value.trim()) name.value = own
    form.value = parsed
    yamlError.value = ''
    return true
  } catch (e) {
    yamlError.value = e instanceof Error ? e.message : String(e)
    return false
  }
}

const canSave = computed(() => !!form.value && !!name.value.trim() && !busy.value && gym.critics.reachable)

async function save() {
  if (!form.value || !name.value.trim()) return
  if (view.value === 'yaml' && !applyYaml()) return
  errors.value = validateSpec(form.value)
  if (errors.value.length) return
  busy.value = 'save'
  try {
    const saved = await gymApi.saveSpec(props.tenantId, name.value.trim(), toYaml(form.value, name.value.trim()))
    // read it back: the service settles the name and writes the spec in its own form
    const detail = await gymApi.spec(props.tenantId, saved.name)
    show(detail.spec ? fromSpec(detail.spec) : fromYaml(detail.yaml), detail.name, detail.usedBy, false)
    if (view.value === 'yaml') yamlText.value = toYaml(form.value, name.value)
    await Promise.all([loadList(), gym.reloadCritics(props.tenantId).catch(() => undefined)])
    ui.showBanner('ok', t('spec.saved', { name: saved.name }), 4000)
    emit('picked', saved.name)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function remove(spec: CriticsSpecInfo) {
  const users = spec.usedBy ?? []
  const ok = await dialog.confirm({
    title: t('spec.deleteTitle', { name: spec.name }),
    text: users.length ? t('spec.deleteUsed', { skills: users.join(', ') }) : t('spec.deleteHint'),
    danger: true,
  })
  if (!ok) return
  busy.value = `del:${spec.name}`
  try {
    await gymApi.deleteSpec(props.tenantId, spec.name)
    if (name.value === spec.name && !isNew.value) closeEditor()
    await Promise.all([loadList(), gym.reloadCritics(props.tenantId).catch(() => undefined)])
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function onFile(ev: Event) {
  const el = ev.target as HTMLInputElement
  const file = el.files?.[0]
  el.value = ''
  if (!file) return
  busy.value = 'upload'
  try {
    const spec = await gymApi.uploadSpec(props.tenantId, file)
    await Promise.all([loadList(), gym.reloadCritics(props.tenantId).catch(() => undefined)])
    closeEditor()
    await openSpec(spec)
    emit('picked', spec.name)
    ui.showBanner('ok', t('spec.uploaded', { name: spec.name }), 4000)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function close() {
  if (dirty.value && !(await confirmDiscard())) return
  visible.value = false
}
</script>

<template>
  <Modal
    :visible="visible"
    size="xl"
    :title="t('spec.manageTitle')"
    :hint="t('spec.manageHint')"
    @update:visible="$event ? (visible = true) : close()"
  >
    <Message v-if="!gym.critics.reachable" severity="warn" class="mb-4">
      {{ t('upload.criticsUnreachable') }}
      <span class="opacity-80">{{ gym.critics.error }}</span>
    </Message>

    <div class="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <div class="flex min-w-0 flex-col gap-2">
        <span class="gym-field mb-0">{{ t('spec.list') }} · {{ specs.length }}</span>
        <div class="flex flex-wrap gap-2">
          <Button
            class="whitespace-nowrap"
            size="small"
            :label="t('spec.new')"
            :disabled="!!busy || !gym.critics.reachable"
            @click="newSpec"
          >
            <template #icon><IconAdd class="size-4" /></template>
          </Button>
          <SecondaryButton
            class="whitespace-nowrap"
            size="small"
            :label="t('spec.upload')"
            :disabled="!!busy || !gym.critics.reachable"
            :title="t('spec.uploadHint')"
            @click="fileInput?.click()"
          >
            <template #icon><IconUpload class="size-4" /></template>
          </SecondaryButton>
          <input
            ref="fileInput"
            type="file"
            hidden
            accept=".yaml,.yml,.json,application/yaml,application/json"
            @change="onFile"
          />
        </div>

        <div v-if="loading" class="py-6 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
        <div v-else-if="listError" class="gym-note border-s-warn">{{ listError }}</div>
        <div v-else-if="!specs.length" class="gym-empty">{{ t('spec.empty') }}</div>
        <ul v-else class="flex max-h-[32rem] flex-col gap-1 overflow-y-auto pe-1">
          <li v-for="sp in specs" :key="sp.name" class="flex items-start gap-1">
            <button
              type="button"
              class="min-w-0 grow cursor-pointer rounded-md border px-2.5 py-2 text-start transition-colors"
              :class="
                sp.name === name && !isNew
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent hover:border-primary/40 hover:bg-primary/5'
              "
              @click="openSpec(sp)"
            >
              <span class="block truncate font-mono text-sm font-semibold">{{ sp.name }}</span>
              <span class="block truncate text-xs text-surface-500 dark:text-surface-400">{{ sp.task || t('spec.noTask') }}</span>
              <span v-if="sp.usedBy?.length" class="mt-1 inline-flex">
                <Pill tone="accent">{{ t('spec.usedByN', { n: sp.usedBy.length }) }}</Pill>
              </span>
            </button>
            <button
              type="button"
              class="cursor-pointer p-1.5 text-surface-500 hover:text-bad"
              :title="t('app.delete')"
              :aria-label="t('app.delete')"
              :disabled="busy === `del:${sp.name}`"
              @click="remove(sp)"
            >
              <IconTrash class="size-4" />
            </button>
          </li>
        </ul>

        <div class="gym-note mt-2 hidden text-xs lg:block">
          <p>{{ t('spec.what') }}</p>
          <ul class="mt-1.5 ms-4 list-disc space-y-0.5">
            <li>{{ t('spec.whatTask') }}</li>
            <li>{{ t('spec.whatSoft') }}</li>
            <li>{{ t('spec.whatHard') }}</li>
          </ul>
          <p class="mt-1.5">{{ t('spec.whatAuto') }}</p>
        </div>
      </div>

      <div v-if="!open" class="gym-empty self-start">{{ t('spec.pickOne') }}</div>

      <SpecPresetPicker v-else-if="view === 'presets'" @pick="pickPreset" />

      <div v-else-if="form" class="flex min-w-0 flex-col gap-4">
        <div class="flex flex-wrap items-end gap-3">
          <FormField class="min-w-0 grow" :label="t('spec.name')" :hint="t('spec.nameHint')" required>
            <InputText v-model="name" fluid :placeholder="t('spec.namePlaceholder')" />
          </FormField>
          <TabBar :model-value="view" :tabs="tabs" class="mb-5" @update:model-value="switchView" />
        </div>
        <div v-if="usedBy.length" class="-mt-2 text-xs text-surface-500 dark:text-surface-400">
          {{ t('spec.usedBy', { skills: usedBy.join(', ') }) }}
        </div>

        <SpecForm_ v-if="view === 'form'" v-model="form" :critics="critics" />

        <FormField v-else :label="t('spec.yaml')" :hint="t('spec.yamlHint')">
          <Textarea v-model="yamlText" rows="24" fluid class="font-mono! text-xs!" spellcheck="false" @blur="applyYaml" />
          <span v-if="yamlError" class="text-bad mt-1 font-mono text-xs">{{ yamlError }}</span>
        </FormField>

        <div v-if="errors.length" class="gym-note border-s-bad">
          <p class="font-semibold">{{ t('spec.errorTitle') }}</p>
          <ul class="mt-1 ms-4 list-disc">
            <li v-for="err in errors" :key="err">{{ t(`spec.error.${err}`) }}</li>
          </ul>
        </div>
      </div>
    </div>

    <template #footer>
      <SecondaryButton :label="t('app.close')" @click="close" />
      <span class="grow"></span>
      <span v-if="dirty && form" class="text-warn font-mono text-xs">{{ t('app.unsaved') }}</span>
      <Button v-if="form" :label="t('app.save')" :loading="busy === 'save'" :disabled="!canSave" @click="save" />
    </template>
  </Modal>
</template>
