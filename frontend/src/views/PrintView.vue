<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { publicApi } from '@/api/gym'
import type { PrintView as PrintData } from '@/types/gym'
import { fmtDateLong, fmtMinutes, fmtPercent, fmtSecs, fmtTime } from '@/utils/time'

/** The printable, shareable day protocol: the cell's day with its blocks, what a customer needs to see, nothing more. */
const route = useRoute()
const { t, locale } = useI18n()
const shareId = computed(() => String(route.params.shareId))
const data = ref<PrintData | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    data.value = await publicApi.print(shareId.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
const print = () => window.print()
const acceptRate = computed(() =>
  data.value?.totals.episodes ? (data.value.totals.accepted / data.value.totals.episodes) * 100 : null,
)
const successRate = computed(() =>
  data.value?.evaluation.episodes ? (data.value.evaluation.accepted / data.value.evaluation.episodes) * 100 : null,
)

const h2 = 'font-display mt-6 mb-2 text-base font-semibold tracking-tight'
</script>

<template>
  <div class="mx-auto max-w-[860px] px-5 py-6 print:px-0 print:py-0">
    <div class="mb-4 flex justify-end print:hidden">
      <SecondaryButton size="small" :label="t('print.print')" @click="print" />
    </div>

    <div v-if="error" class="gym-note border-s-bad">
      {{ t('print.notFound') }}
    </div>
    <div v-else-if="!data" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>

    <template v-else>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('print.title') }} · {{ data.cell.name }}</h1>
      <div class="font-mono text-xs text-surface-500 dark:text-surface-400">
        {{ fmtDateLong(data.date, locale) }}
        <template v-if="data.cell.location"> · {{ data.cell.location }}</template>
        · {{ shareId }}
      </div>

      <dl class="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="row in [
            { k: t('print.operator'), v: data.operatorName || '–' },
            { k: t('print.teleop'), v: fmtMinutes(data.times.teleopMinutes) },
            { k: t('print.evaluation'), v: data.evaluation.blocks ? fmtMinutes(data.times.evaluationMinutes) : '–' },
            { k: t('print.recorded'), v: fmtSecs(data.times.recordedSeconds) },
            { k: t('print.downtime'), v: data.times.downtimeMinutes ? fmtMinutes(data.times.downtimeMinutes) : '–' },
            { k: t('print.status'), v: data.closedAt ? t('day.closed') : t('dayView.open') },
          ]"
          :key="row.k"
        >
          <dt class="gym-field">{{ row.k }}</dt>
          <dd class="m-0">{{ row.v }}</dd>
        </div>
      </dl>

      <section v-for="(b, i) in data.blocks" :key="b.id" class="mt-6 border-t border-surface-300 pt-4 dark:border-surface-700">
        <h2 class="font-display flex flex-wrap items-baseline gap-2 text-base font-semibold tracking-tight">
          <span class="font-mono text-xs text-surface-500">{{ String(i + 1).padStart(2, '0') }}</span>
          {{ t(`block.kind.${b.kind}`) }} · {{ b.skill.name }}
          <span v-if="b.policyName" class="text-sm font-normal text-surface-500">{{ t('block.policy') }} {{ b.policyName }}</span>
        </h2>
        <dl class="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="row in [
              { k: t('print.time'), v: `${fmtTime(b.teleopStartedAt)} – ${fmtTime(b.teleopEndedAt)} (${fmtMinutes(b.minutes)})` },
              { k: b.kind === 'evaluation' ? t('print.targetRollouts') : t('print.target'), v: String(b.targetEpisodes ?? '–') },
              { k: t('print.status'), v: t(`day.steps.${b.step}`) },
              { k: t('print.task'), v: b.skill.taskDescription || '–' },
            ]"
            :key="row.k"
          >
            <dt class="gym-field">{{ row.k }}</dt>
            <dd class="m-0">{{ row.v }}</dd>
          </div>
        </dl>

        <h3 :class="h2">{{ t('print.scene') }}</h3>
        <div class="grid items-start gap-4 sm:grid-cols-2">
          <img
            v-if="b.hasSceneImage"
            class="rounded-panel border border-surface-300 dark:border-surface-700"
            :src="publicApi.printImageUrl(shareId, b.id)"
            alt=""
          />
          <p class="m-0">{{ b.sceneText || '–' }}</p>
        </div>

        <template v-if="b.plan">
          <h3 :class="h2">{{ b.kind === 'evaluation' ? t('print.evalPlan') : t('print.plan') }}</h3>
          <p class="mb-2">{{ b.plan.summary }}</p>
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('plan.step') }}</th>
                <th class="num">{{ b.kind === 'evaluation' ? t('skill.rollouts') : t('print.episodes') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, j) in b.plan.steps" :key="j">
                <td>{{ s.title }}</td>
                <td class="num">{{ s.episodes }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <h3 :class="h2">{{ t('print.datasets') }}</h3>
        <div class="overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('print.dataset') }}</th>
                <th>{{ t('print.spec') }}</th>
                <th class="num">{{ b.kind === 'evaluation' ? t('skill.rollouts') : t('print.episodes') }}</th>
                <th class="num">{{ t('verdict.accept') }}</th>
                <th class="num">{{ t('verdict.review') }}</th>
                <th class="num">{{ t('verdict.reject') }}</th>
                <th class="num">{{ t('print.median') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in b.datasets" :key="d.name">
                <td>{{ d.name }}</td>
                <td class="font-mono text-xs">{{ d.specName ?? '–' }}</td>
                <td class="num">{{ d.episodes }}</td>
                <td class="num">{{ d.accepted }}</td>
                <td class="num">{{ d.review }}</td>
                <td class="num">{{ d.rejected }}</td>
                <td class="num">{{ fmtSecs(d.medianSeconds) }}</td>
              </tr>
              <tr v-if="!b.datasets.length">
                <td colspan="7" class="text-surface-500">–</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <h2 :class="h2">{{ t('print.totals') }}</h2>
      <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="row in [
            {
              k: t('print.episodes'),
              v: `${data.totals.accepted} / ${data.totals.episodes} ${t('verdict.accept')} (${fmtPercent(acceptRate)})`,
            },
            { k: t('print.selectedShort'), v: String(data.totals.selected) },
            {
              k: t('print.evaluation'),
              v: data.evaluation.blocks
                ? `${data.evaluation.accepted} / ${data.evaluation.episodes} ${t('block.succeeded')} (${fmtPercent(successRate)})`
                : '–',
            },
          ]"
          :key="row.k"
        >
          <dt class="gym-field">{{ row.k }}</dt>
          <dd class="m-0">{{ row.v }}</dd>
        </div>
      </dl>

      <template v-if="data.downtime.length">
        <h2 :class="h2">{{ t('print.downtime') }}</h2>
        <table class="gym-table">
          <tbody>
            <tr v-for="d in data.downtime" :key="d.id">
              <td class="font-mono text-xs whitespace-nowrap">{{ fmtTime(d.at) }}</td>
              <td>{{ d.reason }}</td>
              <td class="num">{{ fmtMinutes(d.minutes) }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="data.notes">
        <h2 :class="h2">{{ t('print.notes') }}</h2>
        <p class="m-0">{{ data.notes }}</p>
      </template>
    </template>
  </div>
</template>
