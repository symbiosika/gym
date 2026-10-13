<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useUi } from '@/stores/ui'
import { NONE } from '@/utils/select'
import type { DayView, KpiResult, SkillListItem } from '@/types/gym'
import { addDays, fmtDate, fmtMinutes, fmtPercent, fmtSecs, today } from '@/utils/time'
import IconWarning from '~icons/carbon/warning-alt-filled'
import KpiTile from '@/components/KpiTile.vue'
import SectionHeader from '@/components/SectionHeader.vue'

/** The analyst's view: key figures for a period, per cell and per day, plus the skills and day protocols behind them. */
const route = useRoute()
const { t, locale } = useI18n()
const gym = useGym()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))

const from = ref(addDays(today(), -30))
const to = ref(today())
const cellId = ref(NONE)
const collectionId = ref(NONE)
const kpis = ref<KpiResult | null>(null)
const skills = ref<SkillListItem[]>([])
const days = ref<DayView[]>([])
const tab = ref('skills')

const tabs = computed(() => [
  { value: 'skills', label: t('analysis.skills') },
  { value: 'days', label: t('analysis.days') },
])
const cellOptions = computed(() => [
  { label: t('analysis.all'), value: NONE },
  ...gym.cells.map((c) => ({ label: c.name, value: c.id })),
])
const collectionOptions = computed(() => [
  { label: t('analysis.all'), value: NONE },
  ...gym.collections.map((c) => ({ label: c.name, value: c.id })),
])

async function load() {
  try {
    const f = {
      from: from.value,
      to: to.value,
      cellId: cellId.value === NONE ? undefined : cellId.value,
      collectionId: collectionId.value === NONE ? undefined : collectionId.value,
    }
    kpis.value = await gymApi.kpis(tenantId.value, f)
    skills.value = await gymApi.skills(tenantId.value, { collectionId: f.collectionId, limit: 500 })
    days.value = await gymApi.days(tenantId.value, {
      from: f.from,
      to: f.to,
      cellId: f.cellId,
      limit: 500,
    })
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  }
}
onMounted(load)
watch([from, to, cellId, collectionId], load)

const maxDay = computed(() => Math.max(1, ...(kpis.value?.perDay.map((d) => d.episodes) ?? [1])))
/**
 * The runs whose vision-language model did not answer. Their episodes were
 * judged by the hard critics alone, so every accept rate and every flag count
 * below is missing the half that looks at what happened in the scene. It goes
 * above the figures, not under them.
 */
const vlmFailures = computed(() => kpis.value?.vlmFailures ?? [])
const blockLink = (f: { blockId: string }) => ({ name: 'Block', params: { tenantId: tenantId.value, blockId: f.blockId } })
/** design.md: at least 80 % ok, at least 50 % warn, else bad. */
const rateTone = (r: number | null) => (r == null ? 'neutral' : r >= 80 ? 'ok' : r >= 50 ? 'warn' : 'bad')
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('analysis.title')" :sub="t('analysis.sub')" />

    <div class="mt-4 mb-5 flex flex-wrap items-end gap-3">
      <FormField class="w-36" :label="t('analysis.from')">
        <InputText v-model="from" type="date" fluid />
      </FormField>
      <FormField class="w-36" :label="t('analysis.to')">
        <InputText v-model="to" type="date" fluid />
      </FormField>
      <FormField class="w-44" :label="t('analysis.cell')">
        <Select v-model="cellId" fluid :options="cellOptions" option-label="label" option-value="value" />
      </FormField>
      <FormField class="w-44" :label="t('analysis.collection')">
        <Select v-model="collectionId" fluid :options="collectionOptions" option-label="label" option-value="value" />
      </FormField>
    </div>

    <template v-if="kpis">
      <!--
        Loud, above the figures: without the model the verdicts below are only
        half of the analysis, and nothing else on this page would say so.
      -->
      <section
        v-if="vlmFailures.length"
        class="mb-5 rounded-panel border border-s-[3px] border-bad/40 border-s-bad bg-bad-soft px-4 py-3.5"
        role="alert"
      >
        <div class="flex flex-wrap items-center gap-2">
          <IconWarning class="text-bad size-5 shrink-0" aria-hidden="true" />
          <b class="text-bad">{{ t('analysis.vlmFailedTitle', { n: vlmFailures.length }) }}</b>
        </div>
        <p class="mt-1.5 text-sm text-surface-700 dark:text-surface-200">{{ t('analysis.vlmFailedLead') }}</p>
        <div class="mt-2.5 overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('day.date') }}</th>
                <th>{{ t('analysis.cell') }}</th>
                <th>{{ t('block.skill') }}</th>
                <th>{{ t('analysis.dataset') }}</th>
                <th class="num">{{ t('analysis.vlmFailedColumn') }}</th>
                <th>{{ t('analysis.vlmFailedError') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in vlmFailures" :key="f.datasetId">
                <td class="font-mono text-xs whitespace-nowrap">
                  <RouterLink class="text-primary hover:underline" :to="blockLink(f)">{{ fmtDate(f.date, locale) }}</RouterLink>
                </td>
                <td class="whitespace-nowrap">{{ f.cellName }}</td>
                <td class="whitespace-nowrap">
                  {{ f.skillName }} <Pill v-if="f.kind === 'evaluation'" tone="warn">{{ t('block.kind.evaluation') }}</Pill>
                </td>
                <td>{{ f.datasetName }}</td>
                <td class="num whitespace-nowrap">{{ f.failedEpisodes }} / {{ f.episodes }}</td>
                <td class="font-mono text-xs">{{ f.error ?? '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- eight figures: two clean rows of four, one column on a phone -->
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          :label="t('analysis.totals.episodes')"
          :value="String(kpis.totals.episodes)"
          :sub="`${kpis.totals.accepted} ${t('verdict.accept')} · ${kpis.totals.review} ${t('verdict.review')} · ${kpis.totals.rejected} ${t('verdict.reject')}`"
          hero
        />
        <KpiTile
          :label="t('analysis.totals.acceptRate')"
          :value="fmtPercent(kpis.totals.acceptRatePercent)"
          :bar="kpis.totals.acceptRatePercent"
          :tone="rateTone(kpis.totals.acceptRatePercent)"
        />
        <KpiTile :label="t('analysis.totals.selected')" :value="String(kpis.totals.selected)" />
        <KpiTile
          :label="t('analysis.totals.teleop')"
          :value="fmtMinutes(kpis.totals.teleopMinutes)"
          :sub="
            kpis.totals.episodesPerHour != null ? `${kpis.totals.episodesPerHour} ${t('analysis.totals.perHour')}` : undefined
          "
        />
        <!-- the elapsed time that comes from the uploads, not from the tool -->
        <KpiTile
          :label="t('analysis.totals.recorded')"
          :value="fmtSecs(kpis.totals.recordedSeconds)"
          :sub="t('analysis.totals.recordedHint')"
        />
        <KpiTile
          :label="t('analysis.totals.downtime')"
          :value="fmtMinutes(kpis.totals.downtimeMinutes)"
          :sub="t('analysis.totals.downtimeHint')"
          :tone="kpis.totals.downtimeMinutes > 0 ? 'warn' : 'neutral'"
        />
        <KpiTile
          :label="t('analysis.totals.days')"
          :value="String(kpis.totals.days)"
          :sub="`${kpis.totals.blocks} ${t('analysis.totals.blocks')} · ${kpis.totals.skills} ${t('analysis.totals.skills')}`"
        />
        <!-- the evaluations apart from the recordings: a rollout is not training material -->
        <KpiTile
          :label="t('analysis.totals.evaluation')"
          :value="kpis.totals.evaluation.blocks ? fmtPercent(kpis.totals.evaluation.successRatePercent) : '–'"
          :sub="
            kpis.totals.evaluation.blocks
              ? `${kpis.totals.evaluation.accepted} / ${kpis.totals.evaluation.episodes} ${t('skill.rollouts')} · ${kpis.totals.evaluation.blocks} ${t('analysis.totals.blocks')} · ${fmtMinutes(kpis.totals.evaluation.minutes)}`
              : t('analysis.totals.noEvaluation')
          "
          :bar="kpis.totals.evaluation.blocks ? kpis.totals.evaluation.successRatePercent : null"
          :tone="kpis.totals.evaluation.blocks ? rateTone(kpis.totals.evaluation.successRatePercent) : 'neutral'"
        />
      </div>

      <div class="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader n="" :title="t('analysis.perDay')" />
          <div v-if="!kpis.perDay.length" class="gym-empty">
            {{ t('analysis.noData') }}
          </div>
          <div v-else class="gym-panel overflow-x-auto">
            <table class="gym-table">
              <thead>
                <tr>
                  <th>{{ t('day.date') }}</th>
                  <th class="num">{{ t('analysis.totals.episodes') }}</th>
                  <th class="num">{{ t('verdict.accept') }}</th>
                  <th class="num">{{ t('analysis.totals.teleop') }}</th>
                  <th class="num">{{ t('analysis.totals.evaluationShort') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in kpis.perDay" :key="d.date">
                  <td class="font-mono text-xs whitespace-nowrap">
                    {{ fmtDate(d.date, locale) }}
                  </td>
                  <td class="num">{{ d.episodes }}</td>
                  <td class="num">{{ d.accepted }}</td>
                  <td class="num whitespace-nowrap">
                    {{ fmtMinutes(d.teleopMinutes) }}
                  </td>
                  <td class="num whitespace-nowrap">{{ d.evaluationMinutes ? fmtMinutes(d.evaluationMinutes) : '–' }}</td>
                  <td>
                    <div class="h-1.5 w-24 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
                      <i class="bg-primary block h-full rounded-full" :style="{ width: `${(d.episodes / maxDay) * 100}%` }"></i>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHeader n="" :title="t('analysis.perCell')" />
          <div v-if="!kpis.perCell.length" class="gym-empty">
            {{ t('analysis.noData') }}
          </div>
          <div v-else class="gym-panel overflow-x-auto">
            <table class="gym-table">
              <thead>
                <tr>
                  <th>{{ t('analysis.cell') }}</th>
                  <th class="num">{{ t('analysis.totals.days') }}</th>
                  <th class="num">{{ t('analysis.totals.episodes') }}</th>
                  <th class="num">{{ t('analysis.totals.acceptRate') }}</th>
                  <th class="num">{{ t('analysis.totals.perHour') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in kpis.perCell" :key="c.cellId">
                  <td>{{ c.cellName }}</td>
                  <td class="num">{{ c.days }}</td>
                  <td class="num">{{ c.episodes }}</td>
                  <td class="num">{{ fmtPercent(c.acceptRatePercent) }}</td>
                  <td class="num">{{ c.episodesPerHour ?? '–' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="kpis.flags.length" class="mt-3 flex flex-wrap gap-1.5">
            <Pill v-for="f in kpis.flags" :key="f.flag">{{ f.count }} × {{ f.flag }}</Pill>
          </div>
        </section>
      </div>
    </template>

    <TabBar v-model="tab" class="mt-8" :tabs="tabs" />

    <div v-if="tab === 'skills'" class="gym-panel mt-3 overflow-x-auto">
      <table class="gym-table">
        <thead>
          <tr>
            <th>{{ t('continue.lastDay') }}</th>
            <th>{{ t('skill.name') }}</th>
            <th>{{ t('analysis.collection') }}</th>
            <th class="num">{{ t('skill.days') }}</th>
            <th class="num">{{ t('verdict.accept') }} / {{ t('skill.episodes') }}</th>
            <th class="num">{{ t('skill.lastEvaluation') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in skills"
            :key="s.id"
            class="hover:bg-surface-100 dark:hover:bg-surface-800/60 cursor-pointer"
            @click="$router.push({ name: 'Skill', params: { tenantId, skillId: s.id } })"
          >
            <td class="font-mono text-xs whitespace-nowrap">{{ s.lastDate ? fmtDate(s.lastDate, locale) : '–' }}</td>
            <td>{{ s.name }}</td>
            <td>{{ s.collectionName ?? '–' }}</td>
            <td class="num">{{ s.days }}</td>
            <td class="num whitespace-nowrap">{{ s.acceptedEpisodes }} / {{ s.episodes }}</td>
            <td class="num whitespace-nowrap">{{ s.lastEvaluation ? fmtPercent(s.lastEvaluation.successRatePercent) : '–' }}</td>
            <td>
              <Pill :tone="s.status === 'active' ? 'ok' : 'neutral'">{{ t(`skill.status.${s.status}`) }}</Pill>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!skills.length" class="gym-empty m-3">
        {{ t('analysis.noData') }}
      </div>
    </div>

    <div v-else class="gym-panel mt-3 overflow-x-auto">
      <table class="gym-table">
        <thead>
          <tr>
            <th>{{ t('day.date') }}</th>
            <th>{{ t('skill.cell') }}</th>
            <th>{{ t('dayView.tabs.blocks') }}</th>
            <th>{{ t('day.operator') }}</th>
            <th class="num">{{ t('analysis.totals.teleop') }}</th>
            <th class="num">{{ t('verdict.accept') }} / {{ t('skill.episodes') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in days" :key="d.id">
            <td class="font-mono text-xs whitespace-nowrap">
              {{ fmtDate(d.date, locale) }}
            </td>
            <td class="whitespace-nowrap">{{ d.cell.name }}</td>
            <td>
              <div class="flex flex-wrap gap-1">
                <Pill v-for="b in d.blocks" :key="b.id" :tone="b.kind === 'evaluation' ? 'warn' : 'accent'">{{
                  b.skill.name
                }}</Pill>
                <span v-if="!d.blocks.length" class="text-xs text-surface-500">–</span>
              </div>
            </td>
            <td class="whitespace-nowrap">{{ d.operatorName }}</td>
            <td class="num whitespace-nowrap">{{ fmtMinutes(d.times.teleopMinutes) }}</td>
            <td class="num whitespace-nowrap">{{ d.totals.accepted }} / {{ d.totals.episodes }}</td>
            <td>
              <div class="flex gap-1.5">
                <RouterLink :to="{ name: 'Day', params: { tenantId, dayId: d.id } }">
                  <SecondaryButton size="small" :label="t('app.open')" />
                </RouterLink>
                <a :href="`#/print/${d.shareId}`" target="_blank" rel="noopener">
                  <SecondaryButton size="small" :label="t('day.print')" />
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!days.length" class="gym-empty m-3">
        {{ t('analysis.noData') }}
      </div>
    </div>
  </div>
</template>
