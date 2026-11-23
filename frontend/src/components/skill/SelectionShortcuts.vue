<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { fmtDate } from '@/utils/time'
import type { CueTest, SelectionShortcuts, ShortcutFinding } from '@/types/gym'
import ShortcutRadar, { type RadarAxis } from '@/components/skill/ShortcutRadar.vue'

/**
 * Shortcuts over the selection: what a policy could learn instead of reading
 * the prompt. The data critics compute every figure (`/analyses/shortcuts`)
 * from what they measured per episode; each test holds whole scenes out and
 * says how often a signal still tells the prompt or the arm, against chance.
 * GYM only shows it. A tile is marked only where the critics say its test
 * raised a finding (`cue`), and every finding names the tests it rests on
 * (`findings`): one finding can rest on two tests, and two findings can be
 * about the start pose, one over the recordings, one over the evaluation.
 * Findings about the recordings sit beside the plot, findings about the
 * evaluation's rollouts in a panel of their own that names those datasets.
 *
 * Over the whole selection or one dataset of it; the rollouts of the skill's
 * evaluations are compared by their start poses, never selected.
 */
const props = defineProps<{
  tenantId: string
  skillId: string
  /** dataset id → name, the datasets of the selection */
  names: Record<string, string>
  /** bumped by the caller when the selection changed */
  version?: number
}>()
const { t, te, locale } = useI18n()

const scope = ref<string>('')
const data = ref<SelectionShortcuts | null>(null)
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await gymApi.selectionShortcuts(props.tenantId, props.skillId, scope.value || null)
  } catch (e) {
    data.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
watch(() => [props.skillId, props.version, scope.value], load, { immediate: true })

const scopes = computed(() => [
  { value: '', label: t('skill.episodesTab.shortcuts.wholeSelection') },
  ...Object.entries(props.names).map(([value, label]) => ({ value, label })),
])
const a = computed(() => data.value?.analysis ?? null)
/** the scope and the tests of a finding; an older critics service named neither, then its name tells the scope */
const findingOf = (flag: string): ShortcutFinding =>
  a.value?.findings?.[flag] ?? { scope: flag.startsWith('EVAL_') ? 'evaluation' : 'recordings', tests: [] }
const flags = computed(() => Object.entries(a.value?.flags ?? {}).map(([flag, text]) => ({ flag, text, ...findingOf(flag) })))
const recordingFlags = computed(() => flags.value.filter((f) => f.scope === 'recordings'))
const evaluationFlags = computed(() => flags.value.filter((f) => f.scope === 'evaluation'))
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`)

interface Tile {
  key: string
  /** where the test lies in the critics' answer, as their findings name it */
  path: string
  test: CueTest | null
  flag: string
}
const tiles = computed<Tile[]>(() => {
  const x = a.value
  if (!x) return []
  return [
    { key: 'backgroundPrompt', path: 'background.prompt', test: x.background.prompt, flag: 'BACKGROUND_CUE' },
    { key: 'backgroundArm', path: 'background.arm', test: x.background.arm, flag: 'BACKGROUND_CUE' },
    { key: 'startArm', path: 'start_cue.arm', test: x.start_cue.arm, flag: 'START_CUE' },
    { key: 'startPrompt', path: 'start_cue.prompt', test: x.start_cue.prompt, flag: 'START_CUE' },
    { key: 'positionPrompt', path: 'layout.position_cue', test: x.layout?.position_cue ?? null, flag: 'POSITION_CUE' },
  ]
})
/** the test itself raised the finding: the critics say so per test; an older answer only per finding */
const flagged = (tile: Tile) => !!tile.test && (tile.test.cue ?? tile.flag in (a.value?.flags ?? {}))
const TILE_OF: Record<string, string> = {
  'background.prompt': 'backgroundPrompt',
  'background.arm': 'backgroundArm',
  'start_cue.arm': 'startArm',
  'start_cue.prompt': 'startPrompt',
  'layout.position_cue': 'positionPrompt',
  counterfactual: 'counterfactual',
}
/** what a finding rests on, in the words of the tiles */
const testLabel = (path: string) =>
  TILE_OF[path]
    ? t(`skill.episodesTab.shortcuts.tile.${TILE_OF[path]}`)
    : path === 'evaluation'
      ? t('skill.episodesTab.shortcuts.evaluationTest')
      : path
const restsOn = (tests: string[]) => tests.map(testLabel).join(' · ')
/** the same tests as a spider plot: hit rate against chance per axis */
const radarAxes = computed<RadarAxis[]>(() =>
  tiles.value.map((tile) => ({
    key: tile.key,
    label: t(`skill.episodesTab.shortcuts.tile.${tile.key}`),
    test: tile.test,
    flagged: flagged(tile),
    flag: flagLabel(tile.flag),
  })),
)
const sub = (test: CueTest | null) =>
  test
    ? t('skill.episodesTab.shortcuts.chance', { chance: pct(test.chance), n: test.n, scenes: test.scenes })
    : t('skill.episodesTab.shortcuts.notTestable')
const flagLabel = (flag: string) =>
  te(`skill.episodesTab.shortcuts.flag.${flag}`) ? t(`skill.episodesTab.shortcuts.flag.${flag}`) : flag
const perPrompt = computed(() => Object.entries(a.value?.layout?.per_prompt ?? {}))
const sceneSizes = computed(() =>
  Object.entries(a.value?.scenes.episodes_per_scene ?? {})
    .map(([size, n]) => `${n} × ${size}`)
    .join(' · '),
)
</script>

<template>
  <section>
    <SectionHeader
      :title="t('skill.episodesTab.shortcuts.title')"
      :hint="
        data
          ? t('skill.episodesTab.shortcuts.base', { datasets: data.datasets, episodes: data.episodes }) +
            (data.evaluationEpisodes ? ' · ' + t('skill.episodesTab.shortcuts.rollouts', { n: data.evaluationEpisodes }) : '')
          : ''
      "
      info="selectionShortcuts"
    >
      <Select
        v-if="scopes.length > 2"
        v-model="scope"
        :options="scopes"
        option-label="label"
        option-value="value"
        size="small"
        :aria-label="t('skill.episodesTab.shortcuts.scope')"
      />
    </SectionHeader>

    <div v-if="loading && !data" class="gym-empty">{{ t('app.loading') }} …</div>
    <Message v-else-if="error" severity="warn">{{ t('skill.episodesTab.shortcuts.failed') }} {{ error }}</Message>
    <div v-else-if="!a" class="gym-empty">
      {{
        data?.withoutFeatures
          ? t('skill.episodesTab.shortcuts.noFeatures', { n: data.withoutFeatures })
          : t('skill.episodesTab.metrics.noneSelected')
      }}
    </div>
    <template v-else>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          v-for="tile in tiles"
          :key="tile.key"
          :label="t(`skill.episodesTab.shortcuts.tile.${tile.key}`)"
          :value="tile.test ? pct(tile.test.accuracy) : '–'"
          :sub="sub(tile.test)"
          :tone="flagged(tile) ? 'warn' : 'neutral'"
        />
        <KpiTile
          :label="t('skill.episodesTab.shortcuts.tile.counterfactual')"
          :value="a.counterfactual ? pct(a.counterfactual.episodes_with_partner) : '–'"
          :sub="
            a.counterfactual
              ? t('skill.episodesTab.shortcuts.scenesMulti', {
                  share: pct(a.counterfactual.scenes_multi_prompt),
                  scenes: a.counterfactual.scenes,
                })
              : t('skill.episodesTab.shortcuts.onePrompt')
          "
          :tone="'FEW_COUNTERFACTUALS' in a.flags ? 'warn' : 'neutral'"
        />
      </div>
      <div class="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,30rem)_1fr]">
        <ShortcutRadar :axes="radarAxes" />
        <div>
          <p class="text-xs text-surface-500 dark:text-surface-400" data-testid="shortcut-how-to-read">
            {{ t('skill.episodesTab.shortcuts.howToRead') }}
          </p>
          <h4 v-if="recordingFlags.length" class="mt-3 mb-1.5 text-sm font-medium">
            {{ t('skill.episodesTab.shortcuts.findingsRecordings') }}
          </h4>
          <ul v-if="recordingFlags.length" class="flex flex-col gap-1.5" data-testid="shortcut-flags">
            <li v-for="f in recordingFlags" :key="f.flag" class="gym-note border-s-warn text-sm">
              <div class="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Pill tone="warn">{{ flagLabel(f.flag) }}</Pill>
                <span v-if="f.tests.length" class="text-xs text-surface-500 dark:text-surface-400">
                  {{ t('skill.episodesTab.shortcuts.restsOn', { tests: restsOn(f.tests) }) }}
                </span>
              </div>
              {{ f.text }}
            </li>
          </ul>
        </div>
      </div>

      <!-- the evaluation: its rollouts' start poses against the recordings', and the findings about them -->
      <div v-if="a.evaluation" class="gym-panel mt-4 p-3.5 text-sm" data-testid="shortcut-evaluation">
        <h4 class="mb-1 font-medium">{{ t('skill.episodesTab.shortcuts.evaluationTitle') }}</h4>
        <ul
          v-if="data?.evaluationDatasets.length"
          class="mb-2 flex flex-col gap-0.5 text-xs"
          data-testid="shortcut-evaluation-datasets"
        >
          <li v-for="d in data.evaluationDatasets" :key="d.id" class="text-surface-600 dark:text-surface-300">
            <b class="font-medium">{{ d.name }}</b>
            · {{ fmtDate(d.date, locale) }}
            <template v-if="d.policyName"> · {{ t('skill.episodesTab.shortcuts.policy', { name: d.policyName }) }}</template>
            · {{ t('skill.episodesTab.shortcuts.rolloutsOf', { n: d.episodes }) }}
          </li>
        </ul>
        <p class="text-surface-600 dark:text-surface-300">
          {{
            t('skill.episodesTab.shortcuts.evaluation', {
              n: a.evaluation.n,
              share: pct(a.evaluation.in_range),
              ratio: a.evaluation.distance_ratio_median,
            })
          }}
          <template v-if="a.evaluation.predicted_arm">
            ·
            {{
              t('skill.episodesTab.shortcuts.evaluationArm', {
                arms: Object.entries(a.evaluation.predicted_arm)
                  .map(([arm, n]) => `${arm} ${n}`)
                  .join(', '),
              })
            }}
          </template>
        </p>
        <ul v-if="evaluationFlags.length" class="mt-2 flex flex-col gap-1.5" data-testid="shortcut-evaluation-flags">
          <li v-for="f in evaluationFlags" :key="f.flag" class="gym-note border-s-warn text-sm">
            <div class="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Pill tone="warn">{{ flagLabel(f.flag) }}</Pill>
              <span v-if="f.tests.length" class="text-xs text-surface-500 dark:text-surface-400">
                {{ t('skill.episodesTab.shortcuts.restsOn', { tests: restsOn(f.tests) }) }}
              </span>
            </div>
            {{ f.text }}
          </li>
        </ul>
        <p v-else class="mt-1 text-xs text-surface-500 dark:text-surface-400">
          {{ t('skill.episodesTab.shortcuts.evaluationNoFinding') }}
        </p>
      </div>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div class="gym-panel p-3.5 text-sm">
          <h4 class="mb-2 font-medium">{{ t('skill.episodesTab.shortcuts.scenes') }}</h4>
          <p class="text-surface-600 dark:text-surface-300">
            {{ t('skill.episodesTab.shortcuts.scenesFound', { n: a.scenes.n }) }}
            <span class="font-mono text-xs">{{ sceneSizes }}</span>
          </p>
          <p v-if="a.counterfactual?.answered_by_arm != null" class="mt-1 text-surface-600 dark:text-surface-300">
            {{ t('skill.episodesTab.shortcuts.answeredByArm', { share: pct(a.counterfactual.answered_by_arm) }) }}
          </p>
          <p v-if="data && data.withoutFeatures" class="mt-1 text-xs text-surface-500 dark:text-surface-400">
            {{ t('skill.episodesTab.shortcuts.without', { n: data.withoutFeatures }) }}
          </p>
        </div>
        <div v-if="a.layout" class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <thead>
              <tr>
                <th>{{ t('skill.episodesTab.shortcuts.prompt') }}</th>
                <th class="num">n</th>
                <th class="num">{{ t('skill.episodesTab.shortcuts.cells', { cm: a.layout.cell_cm }) }}</th>
                <th class="num">{{ t('skill.episodesTab.shortcuts.spread') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="[prompt, row] in perPrompt" :key="prompt">
                <td class="max-w-72 truncate" :title="prompt">{{ prompt }}</td>
                <td class="num">{{ row.n }}</td>
                <td class="num">{{ row.cells }}</td>
                <td class="num font-mono text-xs">{{ row.std_cm.join(' / ') }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="text-xs text-surface-500 dark:text-surface-400">
                  {{
                    t('skill.episodesTab.shortcuts.sharedCells', {
                      share: pct(a.layout.cells_multi_prompt),
                      cells: a.layout.cells,
                      episodes: pct(a.layout.episodes_in_shared_cells),
                    })
                  }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>
