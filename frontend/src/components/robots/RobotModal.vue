<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useApp } from '@/stores/app'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import {
  CAPABILITY_SECTIONS,
  ROBOT_STATUSES,
  type AuditEntry,
  type CapabilitySection,
  type Robot,
  type RobotComponent,
  type RobotInput,
  type RobotPlatform,
  type SectionChange,
} from '@/types/gym'
import { fmtDateTime } from '@/utils/time'
import { ROBOT_STATUS_TONE, robotLabel, sectionChangeLines } from '@/utils/robots'
import SectionHeader from '@/components/SectionHeader.vue'
import RobotThumb from './RobotThumb.vue'
import RobotComponentList from './RobotComponentList.vue'
import IconUpload from '~icons/carbon/upload'
import IconTrash from '~icons/carbon/trash-can'
import IconLocation from '~icons/carbon/location'

/**
 * Everything about one robot: photo, names, status and cell, the platform
 * reference, the six capability sections and its history. Every change is
 * saved at once, a section as a whole. With `robotId` null it creates a robot
 * from its technical name first and then shows it like any other.
 */
const props = defineProps<{ tenantId: string; robotId: string | null }>()
const visible = defineModel<boolean>('visible', { required: true })
const emit = defineEmits<{ changed: [Robot]; deleted: [string] }>()
const { t, locale } = useI18n()
const app = useApp()
const ui = useUi()
const dialog = useDialog()
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

const robot = ref<Robot | null>(null)
const audit = ref<AuditEntry[]>([])
const draft = ref({ technicalName: '', personalName: '' })
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const editable = computed(() => app.isAdmin)

watch(
  () => [visible.value, props.robotId] as const,
  async ([open, id]) => {
    if (!open) return
    robot.value = null
    audit.value = []
    draft.value = { technicalName: '', personalName: '' }
    if (!id) return
    try {
      robot.value = await gymApi.robot(props.tenantId, id)
      await loadAudit()
    } catch (e) {
      fail(e)
    }
  },
  { immediate: true },
)

async function loadAudit() {
  if (robot.value) audit.value = await gymApi.robotAudit(props.tenantId, robot.value.id).catch(() => [])
}

const title = computed(() => (robot.value ? robotLabel(robot.value) : t('robots.new')))
const statusOptions = computed(() => ROBOT_STATUSES.map((s) => ({ label: t(`robots.status.${s}`), value: s })))
const platformFields: (keyof RobotPlatform)[] = ['manufacturer', 'model', 'serialNumber', 'productVersion']

async function create() {
  if (!draft.value.technicalName.trim()) return
  busy.value = true
  try {
    robot.value = await gymApi.createRobot(props.tenantId, draft.value)
    emit('changed', robot.value)
    await loadAudit()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/**
 * Save what changed and take the robot back as the backend has it. The
 * sections stay as they are on screen: their rows carry ids of their own, a
 * row may be open for editing, and one without a name is not stored yet.
 * `quiet` leaves the confirmation to the caller (the sections show it on the row).
 */
async function save(body: RobotInput, quiet = false): Promise<boolean> {
  if (!robot.value) return false
  try {
    const saved = await gymApi.updateRobot(props.tenantId, robot.value.id, body)
    robot.value = { ...saved, capabilities: robot.value.capabilities }
    emit('changed', saved)
    if (!quiet) ui.showBanner('ok', t('app.saved'), 1500)
    await loadAudit()
    return true
  } catch (e) {
    fail(e)
    return false
  }
}

const saveSection = (section: CapabilitySection, items: RobotComponent[]) => save({ capabilities: { [section]: items } }, true)

async function uploadImage(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  ;(ev.target as HTMLInputElement).value = ''
  if (!file || !robot.value) return
  busy.value = true
  try {
    robot.value = await gymApi.uploadRobotImage(props.tenantId, robot.value.id, file)
    emit('changed', robot.value)
    await loadAudit()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function removeImage() {
  if (!robot.value) return
  try {
    robot.value = await gymApi.removeRobotImage(props.tenantId, robot.value.id)
    emit('changed', robot.value)
    await loadAudit()
  } catch (e) {
    fail(e)
  }
}

async function remove() {
  if (!robot.value) return
  const r = robot.value
  if (!(await dialog.confirm({ title: t('robots.delete', { name: robotLabel(r) }), text: t('robots.deleteHint'), danger: true })))
    return
  try {
    await gymApi.deleteRobot(props.tenantId, r.id)
    visible.value = false
    emit('deleted', r.id)
  } catch (e) {
    fail(e)
  }
}

/** A few names, the rest counted: "Cam, Lidar, Hand +2 more". */
function names(list: string[]): string {
  const shown = list.slice(0, 3).join(', ')
  return list.length > 3 ? `${shown} ${t('robots.audit.more', { n: list.length - 3 })}` : shown
}

/** A change: the status, the platform and per section what happened to which component, else "changed". */
function describeUpdate(d: Record<string, unknown>): string {
  const parts: string[] = []
  const status = d.status as { from: string; to: string } | undefined
  if (status)
    parts.push(t('robots.audit.statusChanged', { from: t(`robots.status.${status.from}`), to: t(`robots.status.${status.to}`) }))
  const changed = (d.changed as string[] | undefined) ?? []
  if (changed.includes('platform')) parts.push(t('robots.audit.platform'))
  for (const line of sectionChangeLines(d.sections as Partial<Record<CapabilitySection, SectionChange>> | undefined)) {
    parts.push(
      t(`robots.audit.component.${line.kind}`, {
        what: t(`robots.componentNoun.${line.section}`, line.names.length),
        names: names(line.names),
      }),
    )
  }
  if (changed.some((k) => ['technicalName', 'personalName', 'notes'].includes(k))) parts.push(t('robots.audit.updated'))
  return parts.length ? parts.join(' · ') : t('robots.audit.updated')
}

/** One line of the history in words. */
function describe(a: AuditEntry): string {
  const d = a.details as Record<string, unknown>
  const s = (k: string) => String(d[k] ?? '')
  switch (a.action) {
    case 'robot.created':
      return t('robots.audit.created')
    case 'robot.updated':
      return describeUpdate(d)
    case 'robot.assigned':
      return d.fromCellName
        ? t('robots.audit.moved', { from: s('fromCellName'), cell: s('cellName') })
        : t('robots.audit.assigned', { cell: s('cellName') })
    case 'robot.unassigned':
      return t('robots.audit.unassigned', { cell: s('cellName') })
    case 'robot.image':
      return t('robots.audit.image')
    case 'robot.image.removed':
      return t('robots.audit.imageRemoved')
    default:
      return a.action
  }
}
</script>

<template>
  <Modal v-model:visible="visible" :title="title" :hint="robot && robot.personalName ? robot.technicalName : ''" size="xl">
    <!-- create: the technical name first -->
    <form v-if="!props.robotId && !robot" class="flex flex-col gap-4" @submit.prevent="create">
      <p class="gym-note">{{ t('robots.createHint') }}</p>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField :label="t('robots.field.technicalName')" :hint="t('robots.field.technicalNameHint')" required>
          <InputText v-model="draft.technicalName" fluid autofocus :placeholder="t('robots.field.technicalNamePlaceholder')" />
        </FormField>
        <FormField :label="t('robots.field.personalName')" :hint="t('robots.field.personalNameHint')">
          <InputText v-model="draft.personalName" fluid :placeholder="t('robots.field.personalNamePlaceholder')" />
        </FormField>
      </div>
      <div class="flex justify-end">
        <Button type="submit" :label="t('robots.create')" :disabled="!draft.technicalName.trim() || busy" :loading="busy" />
      </div>
    </form>

    <div v-else-if="robot" class="flex flex-col gap-7">
      <p v-if="!editable" class="gym-note">{{ t('robots.readOnly') }}</p>

      <section>
        <SectionHeader n="01" :title="t('robots.sections.profile')" />
        <div class="grid gap-5 md:grid-cols-[10rem_minmax(0,1fr)]">
          <div class="flex flex-col items-start gap-2">
            <RobotThumb :tenant-id="props.tenantId" :robot="robot" size="lg" />
            <template v-if="editable">
              <input ref="fileInput" type="file" accept="image/*" hidden @change="uploadImage" />
              <SecondaryButton
                size="small"
                variant="text"
                :label="robot.hasImage ? t('robots.photo.replace') : t('robots.photo.upload')"
                :loading="busy"
                @click="fileInput?.click()"
              >
                <template #icon><IconUpload /></template>
              </SecondaryButton>
              <SecondaryButton
                v-if="robot.hasImage"
                size="small"
                variant="text"
                :label="t('robots.photo.remove')"
                @click="removeImage"
              >
                <template #icon><IconTrash /></template>
              </SecondaryButton>
            </template>
          </div>
          <div class="grid content-start gap-4 sm:grid-cols-2">
            <FormField :label="t('robots.field.technicalName')" :hint="t('robots.field.technicalNameHint')" required>
              <InputText
                v-model="robot.technicalName"
                fluid
                class="font-mono"
                :disabled="!editable"
                @change="robot.technicalName.trim() && save({ technicalName: robot.technicalName })"
              />
            </FormField>
            <FormField :label="t('robots.field.personalName')" :hint="t('robots.field.personalNameHint')">
              <InputText
                v-model="robot.personalName"
                fluid
                :placeholder="t('robots.field.personalNamePlaceholder')"
                :disabled="!editable"
                @change="save({ personalName: robot.personalName })"
              />
            </FormField>
            <FormField :label="t('robots.field.status')">
              <Select
                v-model="robot.status"
                :options="statusOptions"
                option-label="label"
                option-value="value"
                :disabled="!editable"
                @change="save({ status: robot.status })"
              >
                <template #value="{ value }">
                  <Pill :tone="ROBOT_STATUS_TONE[value as Robot['status']]">{{ t(`robots.status.${value}`) }}</Pill>
                </template>
              </Select>
            </FormField>
            <FormField :label="t('robots.field.cell')" :hint="t('robots.field.cellHint')">
              <div class="flex min-h-10 items-center gap-2 text-sm">
                <IconLocation class="shrink-0 text-surface-400" aria-hidden="true" />
                <template v-if="robot.cell">
                  <span class="font-semibold">{{ robot.cell.name }}</span>
                  <span v-if="robot.cell.location" class="text-surface-500 dark:text-surface-400">{{ robot.cell.location }}</span>
                  <Pill v-if="!robot.cell.active">{{ t('robots.cellInactive') }}</Pill>
                </template>
                <span v-else class="text-surface-500 dark:text-surface-400">{{ t('robots.notInCell') }}</span>
              </div>
            </FormField>
            <FormField :label="t('robots.field.notes')" class="sm:col-span-2">
              <Textarea
                v-model="robot.notes"
                rows="2"
                auto-resize
                fluid
                :disabled="!editable"
                @change="save({ notes: robot.notes })"
              />
            </FormField>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader n="02" :title="t('robots.sections.platform')" :hint="t('robots.sectionHint.platform')" />
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField v-for="f in platformFields" :key="f" :label="t(`robots.platform.${f}`)">
            <InputText
              v-model="robot.platform[f]"
              fluid
              :class="f === 'serialNumber' || f === 'productVersion' ? 'font-mono' : ''"
              :disabled="!editable"
              @change="save({ platform: { [f]: robot.platform[f] } })"
            />
          </FormField>
        </div>
      </section>

      <section v-for="(s, i) in CAPABILITY_SECTIONS" :key="s">
        <SectionHeader
          :n="String(i + 3).padStart(2, '0')"
          :title="t(`robots.sections.${s}`)"
          :hint="t(`robots.sectionHint.${s}`)"
        />
        <RobotComponentList
          v-model="robot.capabilities[s]"
          :editable="editable"
          :save="(items: RobotComponent[]) => saveSection(s, items)"
        />
      </section>

      <section>
        <SectionHeader :n="String(CAPABILITY_SECTIONS.length + 3).padStart(2, '0')" :title="t('robots.sections.history')" />
        <div v-if="!audit.length" class="gym-empty">{{ t('robots.noHistory') }}</div>
        <ol v-else class="flex flex-col gap-1 text-sm">
          <li v-for="a in audit" :key="a.id" class="flex flex-wrap items-baseline gap-x-3">
            <span class="font-mono text-xs whitespace-nowrap text-surface-500 dark:text-surface-400">{{
              fmtDateTime(a.createdAt, locale)
            }}</span>
            <span>{{ describe(a) }}</span>
            <span class="text-xs text-surface-500 dark:text-surface-400">{{ a.userName }}</span>
          </li>
        </ol>
      </section>
    </div>

    <template v-if="robot && editable" #footer>
      <SecondaryButton size="small" class="text-bad!" :label="t('app.delete')" @click="remove">
        <template #icon><IconTrash /></template>
      </SecondaryButton>
      <Button class="ms-auto" :label="t('app.close')" @click="visible = false" />
    </template>
  </Modal>
</template>
