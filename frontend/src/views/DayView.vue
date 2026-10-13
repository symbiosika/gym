<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import type { AuditEntry, BlockView, DayView as DayData } from '@/types/gym'
import { fmtDateLong, fmtDateTime, fmtMinutes, fmtSecs, fmtTime } from '@/utils/time'
import IconTrash from '~icons/carbon/trash-can'

/**
 * One day protocol: the cell's record of the day. Who was there, the blocks
 * that were worked (recording and evaluation, for which skill), the times,
 * the downtimes, notes, the print link. The wizard itself runs on a block.
 */
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const ui = useUi()
const dialog = useDialog()
const tenantId = computed(() => String(route.params.tenantId))
const dayId = computed(() => String(route.params.dayId))

const day = ref<DayData | null>(null)
const audit = ref<AuditEntry[]>([])
const notes = ref('')
const operatorName = ref('')
const tab = ref('blocks')
const tabs = computed(() => [
  { value: 'blocks', label: t('dayView.tabs.blocks') },
  { value: 'audit', label: t('dayView.tabs.audit') },
])
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

async function load() {
  try {
    day.value = await gymApi.day(tenantId.value, dayId.value)
    notes.value = day.value.notes
    operatorName.value = day.value.operatorName
    audit.value = await gymApi.dayAudit(tenantId.value, dayId.value)
  } catch (e) {
    fail(e)
  }
}
onMounted(load)
watch(dayId, load)

async function saveHeader() {
  if (!day.value) return
  if (notes.value === day.value.notes && operatorName.value === day.value.operatorName) return
  try {
    day.value = await gymApi.updateDay(tenantId.value, dayId.value, { notes: notes.value, operatorName: operatorName.value })
  } catch (e) {
    fail(e)
  }
}

const downtimeReason = ref('')
const downtimeMinutes = ref<number | null>(null)
const canAddDowntime = computed(() => downtimeReason.value.trim().length > 0 && (downtimeMinutes.value ?? 0) > 0)
async function addDowntime() {
  if (!canAddDowntime.value) return
  try {
    day.value = await gymApi.addDowntime(tenantId.value, dayId.value, {
      reason: downtimeReason.value.trim(),
      minutes: Math.round(downtimeMinutes.value!),
    })
    downtimeReason.value = ''
    downtimeMinutes.value = null
  } catch (e) {
    fail(e)
  }
}
async function removeDowntime(eventId: string) {
  try {
    day.value = await gymApi.removeDowntime(tenantId.value, dayId.value, eventId)
  } catch (e) {
    fail(e)
  }
}

async function closeDay() {
  if (!(await dialog.confirm({ title: t('dayView.closeConfirm') }))) return
  try {
    day.value = await gymApi.closeDay(tenantId.value, dayId.value)
  } catch (e) {
    fail(e)
  }
}
async function removeBlock(b: BlockView) {
  if (
    !(await dialog.confirm({
      title: t('dayView.deleteBlock'),
      text: t('dayView.deleteBlockConfirm', { skill: b.skill.name, n: b.datasets.length }),
      ok: t('app.delete'),
      danger: true,
    }))
  )
    return
  try {
    await gymApi.deleteBlock(tenantId.value, b.id)
    await load()
  } catch (e) {
    fail(e)
  }
}
async function remove() {
  if (!day.value) return
  if (
    !(await dialog.confirm({
      title: t('dayView.deleteConfirm'),
      text: t('dayView.deleteText', { n: day.value.blocks.length }),
      ok: t('app.delete'),
      danger: true,
    }))
  )
    return
  try {
    await gymApi.deleteDay(tenantId.value, dayId.value)
    router.push({ name: 'Analysis', params: { tenantId: tenantId.value } })
  } catch (e) {
    fail(e)
  }
}

const detailsOf = (a: AuditEntry) =>
  Object.entries(a.details)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
</script>

<template>
  <div class="gym-wrap">
    <div v-if="!day" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <template v-else>
      <PageTitle :title="day.cell.name" :sub="fmtDateLong(day.date, locale)">
        <Pill :tone="day.closedAt ? 'neutral' : day.open ? 'ok' : 'accent'">{{
          day.closedAt ? t('day.closed') : day.open ? t('dayView.open') : t('dayView.idle')
        }}</Pill>
        <RouterLink :to="{ name: 'StartBlock', params: { tenantId } }">
          <Button size="small" :label="t('dayView.addBlock')" />
        </RouterLink>
        <a :href="`#/print/${day.shareId}`" target="_blank" rel="noopener">
          <SecondaryButton size="small" :label="t('day.print')" />
        </a>
        <SecondaryButton v-if="!day.closedAt" size="small" :label="t('dayView.close')" @click="closeDay" />
        <SecondaryButton size="small" class="text-bad!" :label="t('app.delete')" @click="remove" />
      </PageTitle>

      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          :label="t('analysis.totals.episodes')"
          :value="`${day.totals.accepted} / ${day.totals.episodes}`"
          :sub="t('day.recorded')"
          hero
        />
        <KpiTile
          :label="t('analysis.totals.teleop')"
          :value="fmtMinutes(day.times.teleopMinutes)"
          :sub="day.times.teleopRunning ? t('dayView.running') : undefined"
          :tone="day.times.teleopRunning ? 'ok' : 'neutral'"
        />
        <KpiTile
          :label="t('analysis.totals.evaluation')"
          :value="day.evaluation.blocks ? `${day.evaluation.accepted} / ${day.evaluation.episodes}` : '–'"
          :sub="
            day.evaluation.blocks
              ? `${fmtMinutes(day.times.evaluationMinutes)} · ${t('block.succeeded')}`
              : t('dayView.noEvaluation')
          "
        />
        <KpiTile
          :label="t('analysis.totals.recorded')"
          :value="fmtSecs(day.times.recordedSeconds)"
          :sub="t('analysis.totals.recordedHint')"
        />
        <KpiTile
          :label="t('analysis.totals.downtime')"
          :value="fmtMinutes(day.times.downtimeMinutes)"
          :tone="day.times.downtimeMinutes > 0 ? 'warn' : 'neutral'"
        />
      </div>

      <div class="mt-5 grid gap-4 sm:grid-cols-3">
        <FormField :label="t('day.operator')">
          <InputText v-model="operatorName" fluid @blur="saveHeader" />
        </FormField>
        <FormField class="sm:col-span-2" :label="t('brief.notes')">
          <InputText v-model="notes" fluid :placeholder="t('brief.notesPlaceholder')" @blur="saveHeader" />
        </FormField>
      </div>

      <TabBar v-model="tab" class="mt-6" :tabs="tabs" />

      <section v-if="tab === 'blocks'" class="mt-4">
        <div v-if="!day.blocks.length" class="gym-empty">{{ t('home.noBlocks') }}</div>
        <div v-else class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{{ t('block.kindLabel') }}</th>
                <th>{{ t('block.skill') }}</th>
                <th>{{ t('day.step') }}</th>
                <th>{{ t('recording.teleopTime') }}</th>
                <th class="num">{{ t('review.datasets') }}</th>
                <th class="num">{{ t('verdict.accept') }} / {{ t('skill.episodes') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(b, i) in day.blocks" :key="b.id">
                <td class="font-mono text-xs">{{ String(i + 1).padStart(2, '0') }}</td>
                <td>
                  <Pill :tone="b.kind === 'evaluation' ? 'warn' : 'accent'">{{ t(`block.kind.${b.kind}`) }}</Pill>
                </td>
                <td>
                  <RouterLink
                    class="text-primary font-medium hover:underline"
                    :to="{ name: 'Skill', params: { tenantId, skillId: b.skillId } }"
                    >{{ b.skill.name }}</RouterLink
                  >
                  <div v-if="b.policy" class="text-xs text-surface-500 dark:text-surface-400">
                    {{ t('block.policy') }} {{ b.policy.name }}
                  </div>
                </td>
                <td>
                  <Pill :tone="b.step === 'closed' ? 'neutral' : 'accent'">{{ t(`day.steps.${b.step}`) }}</Pill>
                </td>
                <td class="font-mono text-xs whitespace-nowrap">
                  {{ fmtTime(b.teleopStartedAt) }} – {{ fmtTime(b.teleopEndedAt) }} · {{ fmtMinutes(b.times.teleopMinutes) }}
                </td>
                <td class="num">{{ b.datasets.length }}</td>
                <td class="num whitespace-nowrap">{{ b.totals.accepted }} / {{ b.totals.episodes }}</td>
                <td>
                  <div class="flex gap-1.5">
                    <RouterLink :to="{ name: 'Block', params: { tenantId, blockId: b.id } }">
                      <SecondaryButton size="small" :label="t('app.open')" />
                    </RouterLink>
                    <SecondaryButton size="small" class="text-bad!" :label="t('app.delete')" @click="removeBlock(b)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <SectionHeader class="mt-6" n="" :title="t('recording.downtime')" :hint="t('recording.downtimeHint')" />
        <div class="flex flex-wrap items-end gap-3">
          <FormField class="min-w-56 grow" :label="t('recording.downtimeReason')">
            <InputText v-model="downtimeReason" fluid :placeholder="t('recording.downtimeExample')" @keyup.enter="addDowntime" />
          </FormField>
          <FormField class="w-32" :label="t('recording.downtimeMinutes')">
            <NumberInput v-model="downtimeMinutes" fluid :min="1" :max="1440" />
          </FormField>
          <Button class="mb-0.5" :disabled="!canAddDowntime" :label="t('recording.downtimeAdd')" @click="addDowntime" />
        </div>
        <div v-if="day.downtime.length" class="gym-panel mt-3 overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('recording.downtimeAt') }}</th>
                <th>{{ t('recording.downtimeReason') }}</th>
                <th class="num">{{ t('recording.downtimeMinutes') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in day.downtime" :key="d.id">
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtTime(d.at) }}</td>
                <td>{{ d.reason }}</td>
                <td class="num whitespace-nowrap">{{ fmtMinutes(d.minutes) }}</td>
                <td class="w-10">
                  <button
                    type="button"
                    class="text-bad cursor-pointer p-1 hover:opacity-70"
                    :title="t('recording.downtimeRemove')"
                    @click="removeDowntime(d.id)"
                  >
                    <IconTrash class="size-4" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="gym-empty mt-3">{{ t('recording.downtimeNone') }}</div>
      </section>

      <section v-else class="mt-4">
        <div class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('skill.when') }}</th>
                <th>{{ t('skill.who') }}</th>
                <th>{{ t('skill.action') }}</th>
                <th>{{ t('skill.details') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in audit" :key="a.id">
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtDateTime(a.createdAt, locale) }}</td>
                <td class="whitespace-nowrap">{{ a.userName }}</td>
                <td class="font-mono text-xs whitespace-nowrap">{{ a.action }}</td>
                <td class="min-w-64 text-xs text-surface-500 dark:text-surface-400">{{ detailsOf(a) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
