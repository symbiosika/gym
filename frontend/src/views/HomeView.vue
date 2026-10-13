<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import type { DayView, SkillListItem } from '@/types/gym'
import { fmtDate, today } from '@/utils/time'
import { percentDone, planTotal, progressTotal } from '@/utils/plan'
import IconArrowRight from '~icons/carbon/arrow-right'

/**
 * Home of the operator: the three tiles (start a block, continue a skill,
 * analysis) and today's day protocols with their blocks, to jump straight
 * back into a running block.
 */
const route = useRoute()
const { t, locale } = useI18n()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))

const todays = ref<DayView[]>([])
const active = ref<SkillListItem[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    todays.value = await gymApi.days(tenantId.value, { from: today(), to: today() })
    active.value = await gymApi.skills(tenantId.value, { status: 'active', limit: 50 })
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
})

/**
 * The blocks still open today, the one the operator came back for first: the
 * most recently touched leads. Each is one click from where it was left.
 */
const openBlocks = computed(() =>
  todays.value
    .flatMap((d) => d.blocks.map((b) => ({ block: b, cell: d.cell.name })))
    .filter((x) => x.block.step !== 'closed')
    .sort((a, b) => b.block.updatedAt.localeCompare(a.block.updatedAt)),
)
const stepLabel = (b: { kind: string; step: string }) =>
  t(b.kind === 'evaluation' ? `block.evalSteps.${b.step}` : `day.steps.${b.step}`)
const stepNumber = (b: { kind: string; step: string }) => {
  const order =
    b.kind === 'evaluation'
      ? ['brief', 'plan', 'recording', 'upload', 'review', 'closed']
      : ['brief', 'plan', 'recording', 'upload', 'review', 'selection', 'closed']
  return String(order.indexOf(b.step) + 1).padStart(2, '0')
}
const progressOf = (b: DayView['blocks'][number]) => {
  const done = progressTotal(b.progress)
  const target = b.targetEpisodes ?? planTotal(b.plan)
  return { done, target, percent: percentDone(done, target) }
}

const tile =
  'group gym-panel flex flex-col gap-1 p-5 transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-glow-lg'
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('home.title')" :sub="fmtDate(today(), locale)" />

    <!-- the open blocks of today first: coming back to the cell means carrying on -->
    <section v-if="openBlocks.length" class="mt-4">
      <SectionHeader :title="t('home.openBlocks')" :hint="t('home.openBlocksHint')" />
      <div class="grid gap-3 md:grid-cols-2">
        <RouterLink
          v-for="(x, i) in openBlocks"
          :key="x.block.id"
          :to="{ name: 'Block', params: { tenantId, blockId: x.block.id } }"
          class="group gym-panel flex flex-col gap-2 p-5 transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-glow-lg"
          :class="i === 0 ? 'border-primary! md:col-span-2' : ''"
        >
          <div class="flex flex-wrap items-center gap-2">
            <b class="font-display text-xl font-semibold">{{ x.cell }}</b>
            <Pill :tone="x.block.kind === 'evaluation' ? 'warn' : 'accent'">{{ t(`block.kind.${x.block.kind}`) }}</Pill>
            <span class="min-w-0 grow truncate text-surface-600 dark:text-surface-300">{{ x.block.skill.name }}</span>
          </div>
          <div class="flex flex-wrap items-baseline gap-x-3 text-sm text-surface-600 dark:text-surface-300">
            <span
              ><span class="me-1 font-mono text-xs text-surface-500">{{ stepNumber(x.block) }}</span
              ><b class="font-semibold">{{ stepLabel(x.block) }}</b></span
            >
            <span v-if="progressOf(x.block).target" class="tabular-nums"
              >{{ progressOf(x.block).done }} / {{ progressOf(x.block).target }}
              {{ x.block.kind === 'evaluation' ? t('home.rollouts') : t('home.episodes') }}</span
            >
            <span v-if="x.block.times.teleopRunning" class="text-ok flex items-center gap-1.5 text-xs">
              <i class="bg-ok size-2 animate-pulse rounded-full" aria-hidden="true"></i>{{ t('home.clockRunning') }}
            </span>
          </div>
          <div v-if="progressOf(x.block).target" class="h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
            <i class="bg-primary block h-full rounded-full" :style="{ width: `${progressOf(x.block).percent}%` }"></i>
          </div>
          <span
            class="mt-1 inline-flex items-center gap-1.5 self-start rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
            :class="i === 0 ? 'bg-primary text-white' : 'text-primary bg-primary/10'"
          >
            {{ t('home.carryOn') }} <IconArrowRight class="size-4 transition-transform group-hover:translate-x-1" />
          </span>
        </RouterLink>
      </div>
    </section>

    <div class="mt-6 grid gap-3 sm:grid-cols-3">
      <RouterLink
        :class="[tile, openBlocks.length ? '' : 'border-primary! bg-primary! text-white!']"
        :to="{ name: 'StartBlock', params: { tenantId } }"
      >
        <b class="font-display text-lg font-semibold">{{ t('home.startBlock') }}</b>
        <span class="text-sm" :class="openBlocks.length ? 'text-surface-500 dark:text-surface-400' : 'text-white/80'">{{
          t('home.startBlockHint')
        }}</span>
        <IconArrowRight
          class="mt-1 size-4 transition-transform group-hover:translate-x-1"
          :class="openBlocks.length ? 'text-primary' : ''"
        />
      </RouterLink>
      <RouterLink :class="tile" :to="{ name: 'Continue', params: { tenantId } }">
        <b class="font-display text-lg font-semibold">{{ t('home.continueSkill') }}</b>
        <span class="text-sm text-surface-500 dark:text-surface-400">{{
          active.length ? t('home.activeSkills', { n: active.length }) : t('home.continueSkillHint')
        }}</span>
        <IconArrowRight class="text-primary mt-1 size-4 transition-transform group-hover:translate-x-1" />
      </RouterLink>
      <RouterLink :class="tile" :to="{ name: 'Analysis', params: { tenantId } }">
        <b class="font-display text-lg font-semibold">{{ t('home.analysis') }}</b>
        <span class="text-sm text-surface-500 dark:text-surface-400">{{ t('home.analysisHint') }}</span>
        <IconArrowRight class="text-primary mt-1 size-4 transition-transform group-hover:translate-x-1" />
      </RouterLink>
    </div>

    <section class="mt-8">
      <SectionHeader :title="t('home.todayProtocols')" />
      <div v-if="loading" class="py-10 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
      <div v-else-if="!todays.length" class="gym-empty">
        {{ t('home.noToday') }}
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="d in todays" :key="d.id" class="gym-panel flex flex-col gap-2 p-4">
          <RouterLink
            class="flex items-baseline gap-2 hover:text-primary"
            :to="{ name: 'Day', params: { tenantId, dayId: d.id } }"
          >
            <h3 class="font-display text-base font-semibold">{{ d.cell.name }}</h3>
            <span class="text-sm text-surface-500 dark:text-surface-400">{{ d.operatorName }}</span>
            <span class="grow"></span>
            <Pill v-if="d.closedAt" tone="neutral">{{ t('day.closed') }}</Pill>
          </RouterLink>
          <div v-if="!d.blocks.length" class="text-sm text-surface-500 dark:text-surface-400">{{ t('home.noBlocks') }}</div>
          <RouterLink
            v-for="b in d.blocks"
            :key="b.id"
            class="flex flex-wrap items-center gap-2 rounded-md border border-surface-200 px-2.5 py-1.5 text-sm transition-colors hover:border-primary dark:border-surface-800"
            :to="{ name: 'Block', params: { tenantId, blockId: b.id } }"
          >
            <Pill :tone="b.kind === 'evaluation' ? 'warn' : 'accent'">{{ t(`block.kind.${b.kind}`) }}</Pill>
            <span class="min-w-0 grow truncate font-medium">{{ b.skill.name }}</span>
            <Pill :tone="b.step === 'closed' ? 'neutral' : 'accent'">{{ stepLabel(b) }}</Pill>
            <span class="text-xs tabular-nums text-surface-500 dark:text-surface-400"
              >{{ b.totals.accepted }} / {{ b.totals.episodes }}</span
            >
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>
