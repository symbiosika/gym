<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { NONE } from '@/utils/select'
import type { CriticsSummary } from '@/types/gym'

/**
 * What a person makes of one critics run, after the fact.
 *
 * First the critics themselves: one row per critic that judged the run with
 * its weight, whether it can reject on its own, what it raised and how often
 * it scored low, and a switch. A critic switched off does not count for this
 * dataset at all: no score, no gate, no findings. That is the answer to "this
 * criterion does not apply to my setup"; muting a single flag alone would
 * leave the critic's score in the total.
 *
 * Then the single findings (flags) with their effect per spec and the
 * person's weighting: as in the spec, review only (a warning), hint only
 * (muted). Every change goes to the critics, which replay the verdicts; GYM
 * mirrors the result and the block's figures follow. The human review of the
 * rollouts is untouched by it.
 */
const props = defineProps<{ analysis: CriticsSummary; tenantId: string; datasetId: string; title?: string }>()
const emit = defineEmits<{ changed: []; error: [message: string] }>()
const { t } = useI18n()
const busy = ref(false)
const showFlags = ref(false)
/** a summary stored before these fields existed reads as empty, never as a crash */
const overrides = computed(() => props.analysis.overrides ?? { ignoreFlags: [], reviewFlags: [], disabledCritics: [] })
const criticList = computed(() => props.analysis.critics ?? [])
const rawFlags = computed(() => props.analysis.rawFlagCounts ?? [])
const switchable = computed(() => props.analysis.switchable ?? [])

// ---------------------------------------------------------------- critics
const disabled = computed(() => new Set(overrides.value.disabledCritics))
const critics = computed(() =>
  [...criticList.value]
    .filter((c) => c.weight > 0 || c.gate || c.flags.length || disabled.value.has(c.id))
    .sort((a, b) => b.gatedEpisodes - a.gatedEpisodes || b.lowEpisodes - a.lowEpisodes || a.id.localeCompare(b.id)),
)

async function push(next: { reviewFlags?: string[]; ignoreFlags?: string[]; disabledCritics?: string[] }) {
  busy.value = true
  try {
    await gymApi.setDatasetFindings(props.tenantId, props.datasetId, {
      reviewFlags: next.reviewFlags ?? overrides.value.reviewFlags,
      ignoreFlags: next.ignoreFlags ?? overrides.value.ignoreFlags,
      disabledCritics: next.disabledCritics ?? overrides.value.disabledCritics,
    })
    emit('changed')
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
function setCritic(id: string, on: boolean) {
  const set = new Set(disabled.value)
  if (on) set.delete(id)
  else set.add(id)
  return push({ disabledCritics: [...set] })
}

// ---------------------------------------------------------------- single findings
type Setting = typeof NONE | 'review' | 'ignore'
const options = computed(() => [
  { label: t('findings.asSpec'), value: NONE },
  { label: t('findings.review'), value: 'review' },
  { label: t('findings.ignore'), value: 'ignore' },
])
const settingOf = (flag: string): Setting =>
  overrides.value.ignoreFlags.includes(flag) ? 'ignore' : overrides.value.reviewFlags.includes(flag) ? 'review' : NONE

/** what the flag does when the spec is read as written (the critics' `switchable.effect`) */
type Effect = 'gate' | 'reject' | 'review' | 'info'
const effectKey = (flag: string): Effect => {
  const effect = switchable.value.find((s) => s.flag === flag)?.effect ?? ''
  if (effect.includes('gate')) return 'gate'
  if (effect.startsWith('rejects')) return 'reject'
  if (effect.includes('review')) return 'review'
  return 'info'
}
const givesBack = (flag: string) => switchable.value.find((s) => s.flag === flag)?.would_accept.length ?? 0
const rows = computed(() =>
  rawFlags.value.map((f) => ({
    ...f,
    effect: effectKey(f.flag),
    gives: givesBack(f.flag),
    setting: settingOf(f.flag),
  })),
)
const effectTone = { gate: 'bad', reject: 'bad', review: 'warn', info: 'neutral' } as const
const overriddenFlags = computed(() => overrides.value.ignoreFlags.length + overrides.value.reviewFlags.length)

function setFlag(flag: string, setting: Setting) {
  const review = new Set(overrides.value.reviewFlags)
  const ignore = new Set(overrides.value.ignoreFlags)
  review.delete(flag)
  ignore.delete(flag)
  if (setting === 'review') review.add(flag)
  if (setting === 'ignore') ignore.add(flag)
  return push({ reviewFlags: [...review], ignoreFlags: [...ignore] })
}
</script>

<template>
  <div class="gym-panel p-4">
    <div class="flex flex-wrap items-center gap-2">
      <b class="text-surface-900 dark:text-surface-0">
        {{ t('findings.criticsTitle') }}<template v-if="title"> · {{ title }}</template>
      </b>
      <Pill v-if="disabled.size" tone="accent">{{ t('findings.disabledCount', { n: disabled.size }) }}</Pill>
      <span v-if="busy" class="ms-auto font-mono text-xs text-surface-500 dark:text-surface-400">{{ t('findings.saving') }}</span>
    </div>
    <p class="mt-1 mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('findings.criticsLead') }}</p>
    <div class="overflow-x-auto">
      <table class="gym-table">
        <thead>
          <tr>
            <th class="w-8"></th>
            <th>{{ t('findings.critic') }}</th>
            <th class="num">{{ t('findings.weight') }}</th>
            <th>{{ t('findings.gate') }}</th>
            <th>{{ t('findings.raised') }}</th>
            <th class="num">{{ t('findings.low') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in critics" :key="c.id" :class="disabled.has(c.id) ? 'opacity-60' : ''">
            <td>
              <Checkbox
                binary
                :model-value="!disabled.has(c.id)"
                :disabled="busy"
                :title="disabled.has(c.id) ? t('findings.disabled') : t('findings.active')"
                @update:model-value="setCritic(c.id, $event as boolean)"
              />
            </td>
            <td class="font-mono text-xs font-semibold whitespace-nowrap">
              {{ c.id }}
              <span v-if="c.id === 'vlm'" class="ms-1 font-sans font-normal text-surface-500 dark:text-surface-400">{{
                t('findings.vlm')
              }}</span>
            </td>
            <td class="num">{{ c.weight }}</td>
            <td>
              <Pill :tone="c.gate ? 'bad' : 'neutral'">{{ c.gate ? t('findings.gateYes') : t('findings.gateNo') }}</Pill>
              <span v-if="c.gatedEpisodes" class="ms-1 text-xs text-bad">{{ t('findings.gated', { n: c.gatedEpisodes }) }}</span>
            </td>
            <td class="text-xs">
              <template v-if="c.flags.length">
                <span v-for="f in c.flags" :key="f.flag" class="me-2 font-mono whitespace-nowrap"
                  >{{ f.count }} × {{ f.flag }}</span
                >
              </template>
              <span v-else class="text-surface-400">–</span>
            </td>
            <td class="num text-xs" :title="t('findings.lowHint', { n: c.lowEpisodes })">{{ c.lowEpisodes || '–' }}</td>
            <td>
              <Pill :tone="disabled.has(c.id) ? 'neutral' : 'ok'">{{
                disabled.has(c.id) ? t('findings.disabled') : t('findings.active')
              }}</Pill>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <button
      type="button"
      class="text-primary mt-3 flex cursor-pointer items-center gap-1 text-sm hover:underline"
      @click="showFlags = !showFlags"
    >
      {{ showFlags ? t('findings.hide') : t('findings.flagsTitle') }}
      <Pill v-if="overriddenFlags" tone="accent">{{ t('findings.overridden', { n: overriddenFlags }) }}</Pill>
    </button>
    <div v-if="showFlags" class="mt-2">
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">{{ t('findings.lead') }}</p>
      <div class="overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('findings.flag') }}</th>
              <th class="num">{{ t('findings.count') }}</th>
              <th>{{ t('findings.effect') }}</th>
              <th class="num">{{ t('findings.gives') }}</th>
              <th>{{ t('findings.setting') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.flag" :class="r.setting === NONE ? '' : 'bg-primary-50/60 dark:bg-primary-500/10'">
              <td class="font-mono text-xs font-semibold whitespace-nowrap">{{ r.flag }}</td>
              <td class="num">{{ r.count }}</td>
              <td>
                <Pill :tone="effectTone[r.effect]">{{ t(`findings.effects.${r.effect}`) }}</Pill>
              </td>
              <td class="num text-xs text-surface-500 dark:text-surface-400" :title="t('findings.givesHint', { n: r.gives })">
                {{ r.gives ? r.gives : t('findings.nothing') }}
              </td>
              <td class="min-w-48">
                <Select
                  size="small"
                  fluid
                  :model-value="r.setting"
                  :options="options"
                  option-label="label"
                  option-value="value"
                  :disabled="busy"
                  @update:model-value="setFlag(r.flag, $event as Setting)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
