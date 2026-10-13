<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import { NONE } from '@/utils/select'
import type { AuditEntry, EvaluationReportRecord, PolicyRecord, SelectionView, SkillView as SkillData } from '@/types/gym'
import { fmtDate, fmtDateTime, fmtMinutes, fmtPercent } from '@/utils/time'
import SectionHeader from '@/components/SectionHeader.vue'
import EpisodeTable from '@/components/EpisodeTable.vue'
import SpecPicker from '@/components/SpecPicker.vue'

/**
 * One skill for the analyst: the blocks it was worked in (by day and cell),
 * its episodes, its evaluations over time, its policies, exports, audit log.
 */
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const gym = useGym()
const ui = useUi()
const dialog = useDialog()
const tenantId = computed(() => String(route.params.tenantId))
const skillId = computed(() => String(route.params.skillId))

const skill = ref<SkillData | null>(null)
const selection = ref<SelectionView | null>(null)
const audit = ref<AuditEntry[]>([])
const reports = ref<EvaluationReportRecord[]>([])
const tab = ref('blocks')
const editing = ref(false)
const form = ref<{ name: string; taskDescription: string; collectionId: string; criticSpecName: string | null }>({
  name: '',
  taskDescription: '',
  collectionId: NONE,
  criticSpecName: null,
})
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

const tabs = computed(() =>
  (['blocks', 'evaluations', 'policies', 'episodes', 'audit'] as const).map((v) => ({ value: v, label: t(`skill.tabs.${v}`) })),
)
const collectionOptions = computed(() => [
  { label: t('start.noCollection'), value: NONE },
  ...gym.collections.map((c) => ({ label: c.name, value: c.id })),
])

async function load() {
  try {
    skill.value = await gymApi.skill(tenantId.value, skillId.value)
    form.value = {
      name: skill.value.name,
      taskDescription: skill.value.taskDescription,
      collectionId: skill.value.collectionId ?? NONE,
      criticSpecName: skill.value.criticSpecName,
    }
    selection.value = await gymApi.selection(tenantId.value, skillId.value)
    audit.value = await gymApi.skillAudit(tenantId.value, skillId.value)
    reports.value = await gymApi.evaluationReports(tenantId.value, skillId.value)
  } catch (e) {
    fail(e)
  }
}
onMounted(load)
watch(skillId, load)

const selectedMap = computed(() => {
  const map: Record<string, boolean> = {}
  for (const d of selection.value?.datasets ?? []) for (const e of d.episodes) map[e.id] = e.selected
  return map
})
/** the evaluations oldest first, so the success rate reads as a course over time */
const evaluationsByDate = computed(() => [...(skill.value?.evaluations ?? [])].sort((a, b) => a.date.localeCompare(b.date)))
const rateTone = (r: number | null) => (r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad')
const barClass = { neutral: 'bg-surface-400', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' } as const

// evaluation reports: tick blocks in the evaluations table, give the report a name
const picked = ref<Record<string, boolean>>({})
const reportName = ref('')
const creating = ref(false)
const pickedIds = computed(() => evaluationsByDate.value.map((e) => e.blockId).filter((id) => picked.value[id]))
const blockLabel = (id: string) => {
  const e = skill.value?.evaluations.find((x) => x.blockId === id)
  return e ? (e.policyName ?? fmtDate(e.date, locale.value)) : '?'
}
async function createReport() {
  if (!pickedIds.value.length || !reportName.value.trim()) return
  creating.value = true
  try {
    const report = await gymApi.createEvaluationReport(tenantId.value, skillId.value, {
      name: reportName.value.trim(),
      blockIds: pickedIds.value,
    })
    router.push({ name: 'EvaluationReport', params: { tenantId: tenantId.value, reportId: report.id } })
  } catch (e) {
    fail(e)
  } finally {
    creating.value = false
  }
}

const detailsOf = (a: AuditEntry) =>
  Object.entries(a.details)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')

async function save() {
  try {
    await gymApi.updateSkill(tenantId.value, skillId.value, {
      ...form.value,
      collectionId: form.value.collectionId === NONE ? null : form.value.collectionId,
    })
    editing.value = false
    await load()
  } catch (e) {
    fail(e)
  }
}
async function setStatus(status: 'active' | 'archived') {
  if (status === 'archived' && !(await dialog.confirm({ title: t('skill.archiveConfirm') }))) return
  try {
    await gymApi.updateSkill(tenantId.value, skillId.value, { status })
    await load()
  } catch (e) {
    fail(e)
  }
}
async function remove() {
  if (!(await dialog.confirm({ title: t('skill.deleteConfirm'), text: t('app.confirmDelete'), danger: true }))) return
  try {
    await gymApi.deleteSkill(tenantId.value, skillId.value)
    router.push({ name: 'Analysis', params: { tenantId: tenantId.value } })
  } catch (e) {
    fail(e)
  }
}

// policies
const newPolicy = ref<{ name: string; exportId: string; trainedAt: string; notes: string }>({
  name: '',
  exportId: NONE,
  trainedAt: '',
  notes: '',
})
const exportOptions = computed(() => [
  { label: t('skill.noExport'), value: NONE },
  ...(skill.value?.exports ?? []).map((x) => ({
    label: `${x.name} · ${fmtDate(x.createdAt, locale.value)} · ${x.selection.episodes}`,
    value: x.id,
  })),
])
const exportName = (id: string | null) => skill.value?.exports.find((x) => x.id === id)?.name ?? '–'
async function addPolicy() {
  if (!newPolicy.value.name.trim()) return
  try {
    await gymApi.createPolicy(tenantId.value, skillId.value, {
      name: newPolicy.value.name.trim(),
      exportId: newPolicy.value.exportId === NONE ? null : newPolicy.value.exportId,
      trainedAt: newPolicy.value.trainedAt ? new Date(newPolicy.value.trainedAt).toISOString() : null,
      notes: newPolicy.value.notes.trim(),
    })
    newPolicy.value = { name: '', exportId: NONE, trainedAt: '', notes: '' }
    await load()
  } catch (e) {
    fail(e)
  }
}
async function savePolicy(p: PolicyRecord) {
  try {
    await gymApi.updatePolicy(tenantId.value, p.id, { name: p.name, notes: p.notes, exportId: p.exportId })
  } catch (e) {
    fail(e)
  }
}
async function removePolicy(p: PolicyRecord) {
  if (
    !(await dialog.confirm({ title: t('skill.deletePolicy', { name: p.name }), text: t('skill.deletePolicyHint'), danger: true }))
  )
    return
  try {
    await gymApi.deletePolicy(tenantId.value, p.id)
    await load()
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="gym-wrap">
    <div v-if="!skill" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <template v-else>
      <PageTitle
        :title="skill.name"
        :sub="`${skill.collectionName ?? t('start.noCollection')}${skill.firstDate ? ' · ' + fmtDate(skill.firstDate, locale) : ''}${skill.lastDate && skill.lastDate !== skill.firstDate ? ' – ' + fmtDate(skill.lastDate, locale) : ''}`"
      >
        <Pill :tone="skill.status === 'active' ? 'ok' : 'neutral'">{{ t(`skill.status.${skill.status}`) }}</Pill>
        <SecondaryButton size="small" :label="t('app.edit')" @click="editing = !editing" />
        <RouterLink :to="{ name: 'StartBlock', params: { tenantId }, query: { skillId: skill.id, kind: 'recording' } }">
          <Button size="small" :label="t('continue.record')" />
        </RouterLink>
        <RouterLink :to="{ name: 'StartBlock', params: { tenantId }, query: { skillId: skill.id, kind: 'evaluation' } }">
          <SecondaryButton size="small" :label="t('continue.evaluate')" />
        </RouterLink>
        <SecondaryButton
          v-if="skill.status === 'active'"
          size="small"
          :label="t('skill.archive')"
          @click="setStatus('archived')"
        />
        <SecondaryButton v-else size="small" :label="t('skill.reactivate')" @click="setStatus('active')" />
        <SecondaryButton size="small" class="text-bad!" :label="t('app.delete')" @click="remove" />
      </PageTitle>

      <p v-if="skill.taskDescription && !editing" class="text-surface-600 dark:text-surface-300">{{ skill.taskDescription }}</p>
      <p v-if="!editing" class="mt-1 text-xs text-surface-500 dark:text-surface-400">
        {{ t('skill.spec') }}: {{ skill.criticSpecName ?? t('skill.specAuto') }}
      </p>

      <div v-if="editing" class="gym-panel mt-3 p-4">
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField :label="t('skill.name')">
            <InputText v-model="form.name" fluid />
          </FormField>
          <FormField :label="t('skill.task')">
            <Textarea v-model="form.taskDescription" rows="2" fluid />
          </FormField>
          <FormField :label="t('skill.collection')">
            <Select v-model="form.collectionId" fluid :options="collectionOptions" option-label="label" option-value="value" />
          </FormField>
          <FormField :label="t('skill.spec')">
            <SpecPicker v-model="form.criticSpecName" :tenant-id="tenantId" />
          </FormField>
        </div>
        <div class="mt-4 flex gap-2">
          <SecondaryButton :label="t('app.cancel')" @click="editing = false" />
          <Button :label="t('app.save')" @click="save" />
        </div>
      </div>

      <div class="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          :label="t('skill.episodes')"
          :value="String(skill.episodes)"
          :sub="`${skill.acceptedEpisodes} ${t('verdict.accept')}`"
          hero
        />
        <KpiTile :label="t('skill.selected')" :value="String(skill.selectedEpisodes)" />
        <KpiTile
          :label="t('skill.days')"
          :value="String(skill.days)"
          :sub="`${skill.recordingBlocks} ${t('skill.recordingBlocks')}`"
        />
        <KpiTile :label="t('skill.datasets')" :value="String(skill.datasets)" />
        <KpiTile :label="t('skill.tabs.policies')" :value="String(skill.policies)" />
        <KpiTile
          :label="t('skill.lastEvaluation')"
          :value="skill.lastEvaluation ? fmtPercent(skill.lastEvaluation.successRatePercent) : '–'"
          :sub="
            skill.lastEvaluation
              ? `${fmtDate(skill.lastEvaluation.date, locale)}${skill.lastEvaluation.policyName ? ' · ' + skill.lastEvaluation.policyName : ''}`
              : t('skill.noEvaluations')
          "
          :bar="skill.lastEvaluation?.successRatePercent ?? null"
          :tone="rateTone(skill.lastEvaluation?.successRatePercent ?? null)"
        />
      </div>

      <TabBar v-model="tab" class="mt-6" :tabs="tabs" />

      <section v-if="tab === 'blocks'" class="mt-4">
        <div v-if="!skill.blocks_.length" class="gym-empty">{{ t('skill.noBlocks') }}</div>
        <div v-else class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('day.date') }}</th>
                <th>{{ t('skill.cell') }}</th>
                <th>{{ t('block.kindLabel') }}</th>
                <th>{{ t('day.operator') }}</th>
                <th>{{ t('day.step') }}</th>
                <th>{{ t('recording.teleopTime') }}</th>
                <th class="num">{{ t('review.datasets') }}</th>
                <th class="num">{{ t('verdict.accept') }} / {{ t('skill.episodes') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in skill.blocks_" :key="b.id">
                <td class="font-mono text-xs whitespace-nowrap">
                  <RouterLink
                    class="text-primary hover:underline"
                    :to="{ name: 'Day', params: { tenantId, dayId: b.dayProtocolId } }"
                    >{{ fmtDate(b.date, locale) }}</RouterLink
                  >
                </td>
                <td class="whitespace-nowrap">{{ b.cell.name }}</td>
                <td>
                  <Pill :tone="b.kind === 'evaluation' ? 'warn' : 'accent'">{{ t(`block.kind.${b.kind}`) }}</Pill>
                  <span v-if="b.policy" class="ms-1 text-xs text-surface-500 dark:text-surface-400">{{ b.policy.name }}</span>
                </td>
                <td class="whitespace-nowrap">{{ b.operatorName }}</td>
                <td>
                  <Pill :tone="b.step === 'closed' ? 'neutral' : 'accent'">{{ t(`day.steps.${b.step}`) }}</Pill>
                </td>
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtMinutes(b.times.teleopMinutes) }}</td>
                <td class="num">{{ b.datasets.length }}</td>
                <td class="num whitespace-nowrap">{{ b.totals.accepted }} / {{ b.totals.episodes }}</td>
                <td>
                  <RouterLink :to="{ name: 'Block', params: { tenantId, blockId: b.id } }">
                    <SecondaryButton size="small" :label="t('app.open')" />
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <SectionHeader class="mt-6" n="" :title="t('skill.exports')" />
        <div v-if="!skill.exports.length" class="gym-empty">{{ t('skill.noExports') }}</div>
        <div v-else class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('skill.exportDate') }}</th>
                <th>{{ t('skill.name') }}</th>
                <th class="num">{{ t('skill.episodes') }}</th>
                <th class="num">{{ t('skill.datasets') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in skill.exports" :key="x.id">
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtDateTime(x.createdAt, locale) }}</td>
                <td>{{ x.name }}</td>
                <td class="num">{{ x.selection.episodes }}</td>
                <td class="num">{{ x.selection.datasets.length }}</td>
                <td>
                  <a :href="gymApi.exportDownloadUrl(tenantId, x.id)">
                    <SecondaryButton size="small" :label="t('skill.download')" />
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else-if="tab === 'evaluations'" class="mt-4">
        <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('skill.evaluationsLead') }}</p>
        <div v-if="!evaluationsByDate.length" class="gym-empty">{{ t('skill.noEvaluations') }}</div>
        <div v-else class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th class="w-8" :title="t('report.pickBlocks')"></th>
                <th>{{ t('day.date') }}</th>
                <th>{{ t('skill.cell') }}</th>
                <th>{{ t('block.policy') }}</th>
                <th class="num">{{ t('skill.rollouts') }}</th>
                <th class="num">{{ t('block.succeeded') }}</th>
                <th class="num">{{ t('skill.successRate') }}</th>
                <th></th>
                <th class="num">{{ t('skill.minutes') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in evaluationsByDate" :key="e.blockId">
                <td>
                  <Checkbox v-model="picked[e.blockId]" binary :disabled="!e.episodes" :title="t('report.pickBlocks')" />
                </td>
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtDate(e.date, locale) }}</td>
                <td class="whitespace-nowrap">{{ e.cellName }}</td>
                <td>{{ e.policyName ?? '–' }}</td>
                <td class="num">
                  {{ e.episodes }}<span v-if="e.targetEpisodes" class="text-surface-500"> / {{ e.targetEpisodes }}</span>
                </td>
                <td class="num">{{ e.accepted }}</td>
                <td class="num">
                  <Pill :tone="rateTone(e.successRatePercent)">{{ fmtPercent(e.successRatePercent) }}</Pill>
                </td>
                <td>
                  <div class="h-1.5 w-24 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
                    <i
                      class="block h-full rounded-full"
                      :class="barClass[rateTone(e.successRatePercent)]"
                      :style="{ width: `${e.successRatePercent ?? 0}%` }"
                    ></i>
                  </div>
                </td>
                <td class="num">{{ fmtMinutes(e.minutes) }}</td>
                <td>
                  <RouterLink :to="{ name: 'Block', params: { tenantId, blockId: e.blockId } }">
                    <SecondaryButton size="small" :label="t('app.open')" />
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- a report over the ticked blocks -->
        <div
          v-if="evaluationsByDate.length"
          class="gym-panel mt-3 grid items-end gap-3 border-dashed p-3 sm:grid-cols-[1fr_auto]"
        >
          <FormField
            :label="t('report.name')"
            :hint="
              pickedIds.length
                ? `${t('report.selectedBlocks', { n: pickedIds.length })}: ${pickedIds.map(blockLabel).join(' · ')}`
                : t('report.createHint')
            "
            required
          >
            <InputText v-model="reportName" fluid :placeholder="t('report.namePlaceholder')" @keyup.enter="createReport" />
          </FormField>
          <Button
            :disabled="!pickedIds.length || !reportName.trim() || creating"
            :loading="creating"
            :label="t('report.create')"
            @click="createReport"
          />
        </div>

        <SectionHeader class="mt-6" n="" :title="t('report.reports')" :hint="t('report.lead')" />
        <div v-if="!reports.length" class="gym-empty">{{ t('report.none') }}</div>
        <div v-else class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('report.name') }}</th>
                <th>{{ t('report.blocks') }}</th>
                <th>{{ t('report.updated') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in reports" :key="r.id">
                <td class="font-semibold">{{ r.name }}</td>
                <td class="text-xs text-surface-500 dark:text-surface-400">{{ r.blockIds.map(blockLabel).join(' · ') }}</td>
                <td class="font-mono text-xs whitespace-nowrap">{{ fmtDateTime(r.updatedAt, locale) }}</td>
                <td class="whitespace-nowrap">
                  <RouterLink :to="{ name: 'EvaluationReport', params: { tenantId, reportId: r.id } }">
                    <SecondaryButton size="small" :label="t('report.open')" />
                  </RouterLink>
                  <a class="ms-1" :href="`#/eval-report/${r.shareId}`" target="_blank" rel="noopener">
                    <SecondaryButton size="small" :label="t('report.print')" />
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else-if="tab === 'policies'" class="mt-4">
        <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('skill.policiesLead') }}</p>
        <div v-if="!skill.policies_.length" class="gym-empty">{{ t('skill.noPolicies') }}</div>
        <div v-else class="flex flex-col gap-1.5">
          <div
            v-for="p in skill.policies_"
            :key="p.id"
            class="gym-panel grid items-center gap-3 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <FormField :label="t('skill.name')">
              <InputText v-model="p.name" fluid @change="savePolicy(p)" />
            </FormField>
            <FormField :label="t('skill.trainedFrom')">
              <Select
                v-model="p.exportId"
                fluid
                :options="exportOptions"
                option-label="label"
                option-value="value"
                @change="savePolicy(p)"
              />
            </FormField>
            <FormField :label="t('skill.policyNotes')" :hint="p.trainedAt ? fmtDate(p.trainedAt, locale) : undefined">
              <InputText v-model="p.notes" fluid @change="savePolicy(p)" />
            </FormField>
            <SecondaryButton size="small" class="text-bad! self-end" :label="t('app.delete')" @click="removePolicy(p)" />
          </div>
        </div>
        <div class="gym-panel mt-3 grid items-end gap-3 border-dashed p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <FormField :label="t('skill.newPolicy')" required>
            <InputText v-model="newPolicy.name" fluid :placeholder="t('skill.policyPlaceholder')" @keyup.enter="addPolicy" />
          </FormField>
          <FormField :label="t('skill.trainedFrom')">
            <Select v-model="newPolicy.exportId" fluid :options="exportOptions" option-label="label" option-value="value" />
          </FormField>
          <FormField :label="t('skill.trainedAt')">
            <InputText v-model="newPolicy.trainedAt" type="date" fluid />
          </FormField>
          <Button :disabled="!newPolicy.name.trim()" :label="t('skill.addPolicy')" @click="addPolicy" />
        </div>
        <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">
          {{ t('skill.trainedFromHint', { name: exportName(newPolicy.exportId || null) }) }}
        </p>
      </section>

      <section v-else-if="tab === 'episodes'" class="mt-4">
        <div v-if="!selection || !selection.datasets.length" class="gym-empty">{{ t('skill.noEpisodes') }}</div>
        <EpisodeTable v-else :selection="selection" :selected="selectedMap" readonly />
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
