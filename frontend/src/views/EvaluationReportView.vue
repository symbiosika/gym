<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useDialog } from '@/stores/dialog'
import { useUi } from '@/stores/ui'
import type { EvaluationReportSections, EvaluationReportView as ReportData, EvaluationSummary } from '@/types/gym'
import { fmtDate, fmtDateTime, fmtPercent } from '@/utils/time'
import EvaluationReportBody from '@/components/EvaluationReportBody.vue'
import SectionHeader from '@/components/SectionHeader.vue'

/**
 * One evaluation report of a skill: the figures computed from its blocks and
 * the text the team writes. The text is edited in place and saved on blur;
 * the blocks the report reads are ticked from the skill's evaluations. The
 * share link opens the same report read-only, for people without an account.
 */
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const ui = useUi()
const dialog = useDialog()
const tenantId = computed(() => String(route.params.tenantId))
const reportId = computed(() => String(route.params.reportId))

const report = ref<ReportData | null>(null)
const evaluations = ref<EvaluationSummary[]>([])
const editing = ref(false)
const name = ref('')
const sections = ref<EvaluationReportSections>({
  prompt: '',
  successCriteria: '',
  design: '',
  reset: '',
  caveats: '',
  working: '',
  needsReview: '',
  nextSteps: '',
})
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

async function load() {
  try {
    report.value = await gymApi.evaluationReport(tenantId.value, reportId.value)
    name.value = report.value.name
    sections.value = { ...report.value.sections }
    const skill = await gymApi.skill(tenantId.value, report.value.skillId)
    evaluations.value = [...skill.evaluations].sort((a, b) => a.date.localeCompare(b.date))
  } catch (e) {
    fail(e)
  }
}
onMounted(load)
watch(reportId, load)

const shareUrl = computed(() =>
  report.value ? `${location.origin}${location.pathname}#/eval-report/${report.value.shareId}` : '',
)
const inReport = computed(() => new Set(report.value?.blockIds ?? []))
const rateTone = (r: number | null) => (r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad')

async function saveSection(key: keyof EvaluationReportSections) {
  if (!report.value || sections.value[key].trim() === report.value.sections[key]) return
  try {
    report.value = await gymApi.updateEvaluationReport(tenantId.value, reportId.value, {
      sections: { [key]: sections.value[key] },
    })
  } catch (e) {
    fail(e)
  }
}
async function saveName() {
  if (!report.value || !name.value.trim() || name.value.trim() === report.value.name) return
  try {
    report.value = await gymApi.updateEvaluationReport(tenantId.value, reportId.value, { name: name.value.trim() })
  } catch (e) {
    fail(e)
  }
}
async function toggleBlock(blockId: string, on: boolean) {
  if (!report.value) return
  // the order of the report follows the order of the evaluations: oldest first
  const ids = evaluations.value.map((e) => e.blockId).filter((id) => (id === blockId ? on : inReport.value.has(id)))
  if (!ids.length) return
  try {
    report.value = await gymApi.updateEvaluationReport(tenantId.value, reportId.value, { blockIds: ids })
  } catch (e) {
    fail(e)
  }
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    ui.showBanner('ok', t('app.saved'))
  } catch {
    window.prompt(t('report.share'), shareUrl.value)
  }
}
async function remove() {
  if (!report.value) return
  if (!(await dialog.confirm({ title: t('report.deleteConfirm', { name: report.value.name }), danger: true }))) return
  try {
    await gymApi.deleteEvaluationReport(tenantId.value, reportId.value)
    router.push({ name: 'Skill', params: { tenantId: tenantId.value, skillId: report.value.skillId } })
  } catch (e) {
    fail(e)
  }
}

const sceneKeys = ['prompt', 'successCriteria', 'design', 'reset', 'caveats'] as const
const conclusionKeys = ['working', 'needsReview', 'nextSteps'] as const
</script>

<template>
  <div class="gym-wrap">
    <div v-if="!report" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <template v-else>
      <PageTitle
        :title="report.name"
        :sub="`${t('report.title')} · ${report.skill.name}${report.skill.collectionName ? ' · ' + report.skill.collectionName : ''} · ${t('report.updated')} ${fmtDateTime(report.updatedAt, locale)}`"
      >
        <SecondaryButton
          size="small"
          :label="editing ? t('report.doneEditing') : t('report.editSections')"
          @click="editing = !editing"
        />
        <SecondaryButton size="small" :label="t('report.share')" :title="shareUrl" @click="copyLink" />
        <a :href="`#/eval-report/${report.shareId}`" target="_blank" rel="noopener">
          <SecondaryButton size="small" :label="t('report.print')" />
        </a>
        <RouterLink :to="{ name: 'Skill', params: { tenantId, skillId: report.skillId } }">
          <SecondaryButton size="small" :label="t('report.toSkill')" />
        </RouterLink>
        <SecondaryButton size="small" class="text-bad!" :label="t('app.delete')" @click="remove" />
      </PageTitle>

      <p v-if="report.skill.taskDescription" class="mb-4 text-surface-600 dark:text-surface-300">
        {{ report.skill.taskDescription }}
      </p>

      <!-- the editable parts: name, the blocks the report reads, the written sections -->
      <div v-if="editing" class="mb-6 flex flex-col gap-5">
        <div class="gym-panel p-4">
          <FormField :label="t('report.name')" required>
            <InputText v-model="name" fluid @blur="saveName" @keyup.enter="saveName" />
          </FormField>
        </div>

        <section>
          <SectionHeader n="" :title="t('report.blocksInReport')" :hint="t('report.blocksHint')" />
          <div class="gym-panel overflow-x-auto">
            <table class="gym-table">
              <thead>
                <tr>
                  <th class="w-8"></th>
                  <th>{{ t('day.date') }}</th>
                  <th>{{ t('skill.cell') }}</th>
                  <th>{{ t('block.policy') }}</th>
                  <th class="num">{{ t('skill.rollouts') }}</th>
                  <th class="num">{{ t('skill.successRate') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in evaluations" :key="e.blockId" :class="inReport.has(e.blockId) ? '' : 'opacity-60'">
                  <td>
                    <Checkbox
                      binary
                      :model-value="inReport.has(e.blockId)"
                      @update:model-value="toggleBlock(e.blockId, $event as boolean)"
                    />
                  </td>
                  <td class="font-mono text-xs whitespace-nowrap">{{ fmtDate(e.date, locale) }}</td>
                  <td>{{ e.cellName }}</td>
                  <td>{{ e.policyName ?? '–' }}</td>
                  <td class="num">{{ e.episodes }}</td>
                  <td class="num">
                    <Pill :tone="rateTone(e.successRatePercent)">{{ fmtPercent(e.successRatePercent) }}</Pill>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHeader n="A" :title="t('report.sections.scene')" />
          <div class="gym-panel grid gap-4 p-4 sm:grid-cols-2">
            <FormField
              v-for="k in sceneKeys"
              :key="k"
              :label="t(`report.sections.${k}`)"
              :class="k === 'caveats' ? 'sm:col-span-2' : ''"
            >
              <Textarea v-model="sections[k]" rows="3" fluid @blur="saveSection(k)" />
            </FormField>
          </div>
        </section>

        <section>
          <SectionHeader n="F" :title="t('report.sections.conclusion')" />
          <div class="gym-panel grid gap-4 p-4 md:grid-cols-3">
            <FormField v-for="k in conclusionKeys" :key="k" :label="t(`report.sections.${k}`)">
              <Textarea v-model="sections[k]" rows="6" fluid @blur="saveSection(k)" />
            </FormField>
          </div>
        </section>
      </div>

      <EvaluationReportBody :figures="report.figures" :sections="report.sections" :tenant-id="tenantId" />
    </template>
  </div>
</template>
