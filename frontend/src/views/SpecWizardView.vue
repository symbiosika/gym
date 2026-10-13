<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { FetcherError } from '@/utils/fetcher'
import { useUi } from '@/stores/ui'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import {
  SPEC_DRAFT_STEPS,
  type CriticsHardCriticInfo,
  type SampleReport,
  type SkillListItem,
  type SpecDraftStep,
  type SpecDraftView,
} from '@/types/gym'
import { defaultIndicators, fromSpec, toSpec, type SpecForm as SpecFormModel } from '@/utils/spec'
import {
  criticEvidence,
  cycleCounts,
  durationRange,
  indicatorEvidence,
  sampleTasks,
  softError,
  softState,
} from '@/utils/specSample'
import { fmtDateTime } from '@/utils/time'
import SpecForm from '@/components/spec/SpecForm.vue'
import StepSample from '@/components/specwizard/StepSample.vue'
import StepAnalysis from '@/components/specwizard/StepAnalysis.vue'
import StepRobot from '@/components/specwizard/StepRobot.vue'
import StepSave from '@/components/specwizard/StepSave.vue'
import ScoringPreview from '@/components/specwizard/ScoringPreview.vue'
import SampleSheet from '@/components/specwizard/SampleSheet.vue'
import IconCheck from '~icons/carbon/checkmark'
import IconArrowLeft from '~icons/carbon/arrow-left'
import IconArrowRight from '~icons/carbon/arrow-right'
import IconTrash from '~icons/carbon/trash-can'
import IconAdd from '~icons/carbon/add'
import IconMagic from '~icons/carbon/magic-wand'

/**
 * The spec wizard. A critics spec is not written from a blank page but worked
 * out from a sample: a dataset is uploaded for the time of the wizard, the
 * critics run in auto mode over X of its episodes, and the person walks
 * through the spec they generated step by step, each step with what the sample
 * measured next to its fields. Every input is saved on the draft at once, so
 * the wizard resumes where it was left (lib/gym/spec-drafts.ts).
 *
 * Without a draft id the view is the way in: the open drafts and a new one.
 */
const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const ui = useUi()
const gym = useGym()
const dialog = useDialog()
const tenantId = computed(() => String(route.params.tenantId))
const draftId = computed(() => (route.params.draftId ? String(route.params.draftId) : ''))

const draft = ref<SpecDraftView | null>(null)
const analysis = ref<SampleReport | null>(null)
const test = ref<SampleReport | null>(null)
const form = ref<SpecFormModel | null>(null)
const name = ref('')
const critics = ref<CriticsHardCriticInfo[]>([])
const skills = ref<SkillListItem[]>([])
const openDrafts = ref<SpecDraftView[]>([])
const loading = ref(true)
const saving = ref<'idle' | 'saving' | 'saved'>('idle')
const busy = ref(false)

const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

// ------------------------------------------------------------------ loading
/** the job ids the reports on screen belong to, so a new run is fetched and an old one is not again */
let analysisOf: string | null = null
let testOf: string | null = null

async function apply(next: SpecDraftView) {
  draft.value = next
  if (next.analysisStatus === 'done' && next.analysisJobId && next.analysisJobId !== analysisOf) {
    analysis.value = await gymApi.specDraftReport(tenantId.value, next.id, 'analysis')
    analysisOf = next.analysisJobId
  } else if (next.analysisStatus !== 'done') {
    analysis.value = null
    analysisOf = null
  }
  if (next.testStatus === 'done' && next.testJobId && next.testJobId !== testOf) {
    test.value = await gymApi.specDraftReport(tenantId.value, next.id, 'test')
    testOf = next.testJobId
  } else if (next.testStatus !== 'done') {
    test.value = null
    testOf = null
  }
  // the form follows the draft until the person starts editing; after that the form leads
  if (next.spec && !form.value) {
    form.value = fromSpec(next.spec)
    lastSaved = JSON.stringify(toSpec(form.value, next.name))
  }
  if (!name.value) name.value = next.name
  schedulePolling()
}

async function load() {
  loading.value = true
  try {
    const [hard, skillList] = await Promise.all([
      gymApi.hardCritics(tenantId.value).catch(() => []),
      gymApi.skills(tenantId.value, { status: 'active', limit: 500 }).catch(() => []),
    ])
    critics.value = hard
    skills.value = skillList
    if (draftId.value) await apply(await gymApi.specDraft(tenantId.value, draftId.value))
    else await startPage()
  } catch (e) {
    fail(e)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
const running = computed(
  () => !!draft.value && ['queued', 'running'].some((s) => s === draft.value!.analysisStatus || s === draft.value!.testStatus),
)
function schedulePolling() {
  clearInterval(timer)
  if (running.value) {
    timer = setInterval(async () => {
      try {
        await apply(await gymApi.specDraft(tenantId.value, draftId.value))
      } catch (e) {
        clearInterval(timer)
        fail(e)
      }
    }, 3000)
  }
}

// --------------------------------------------------------------- start page
async function startPage() {
  openDrafts.value = await gymApi.specDrafts(tenantId.value)
  // coming from a skill: its open draft, else a new one for it
  const skillId = typeof route.query.skillId === 'string' ? route.query.skillId : ''
  if (skillId) {
    const existing = openDrafts.value.find((d) => d.skillId === skillId)
    if (existing) return router.replace({ name: 'SpecWizard', params: { tenantId: tenantId.value, draftId: existing.id } })
    await createDraft(skillId)
  }
}

async function createDraft(skillId?: string) {
  busy.value = true
  try {
    const created = await gymApi.createSpecDraft(tenantId.value, { skillId: skillId ?? null })
    await router.replace({ name: 'SpecWizard', params: { tenantId: tenantId.value, draftId: created.id } })
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function discard(target: SpecDraftView) {
  if (!(await dialog.confirm({ title: t('specWizard.discardConfirm'), text: t('specWizard.discardText'), danger: true }))) return
  try {
    await gymApi.deleteSpecDraft(tenantId.value, target.id)
    if (draftId.value === target.id) await router.replace({ name: 'SpecWizard', params: { tenantId: tenantId.value } })
    else openDrafts.value = openDrafts.value.filter((d) => d.id !== target.id)
  } catch (e) {
    fail(e)
  }
}

// ------------------------------------------------------------------ autosave
let lastSaved = ''
let saveTimer: ReturnType<typeof setTimeout> | undefined
async function saveNow(extra: Parameters<typeof gymApi.updateSpecDraft>[2] = {}) {
  clearTimeout(saveTimer)
  if (!draft.value) return
  const body = { ...extra }
  if (form.value) {
    const spec = toSpec(form.value, name.value || draft.value.name)
    const text = JSON.stringify(spec)
    if (text !== lastSaved) {
      body.spec = spec
      lastSaved = text
    }
  }
  if (name.value && name.value !== draft.value.name) body.name = name.value
  if (!Object.keys(body).length) return
  saving.value = 'saving'
  try {
    const next = await gymApi.updateSpecDraft(tenantId.value, draft.value.id, body)
    await apply(next)
    if (body.name) name.value = next.name
    saving.value = 'saved'
  } catch (e) {
    saving.value = 'idle'
    fail(e)
  }
}
watch(
  [form, name],
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNow(), 700)
  },
  { deep: true },
)

// --------------------------------------------------------------------- steps
const step = computed<SpecDraftStep>(() => draft.value?.step ?? 'sample')
const reachable = computed<SpecDraftStep[]>(() => {
  const d = draft.value
  if (!d) return []
  if (d.spec) return SPEC_DRAFT_STEPS
  return d.storageParts.length ? ['sample', 'analysis'] : ['sample']
})
const index = computed(() => SPEC_DRAFT_STEPS.indexOf(step.value))
const prev = computed(() => SPEC_DRAFT_STEPS[index.value - 1])
const next = computed(() => SPEC_DRAFT_STEPS[index.value + 1])
const canNext = computed(() => !!next.value && reachable.value.includes(next.value))

async function go(target: SpecDraftStep) {
  if (!reachable.value.includes(target) || target === step.value) return
  await saveNow({ step: target })
  if (target === 'success') suggestIndicators()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/** The success step starts with indicators worded from the objects of the task, never empty. */
function suggestIndicators() {
  if (form.value && form.value.soft.enabled && !form.value.soft.indicators.length) {
    form.value.soft.indicators = defaultIndicators(form.value.task.objects)
  }
}

async function rerun() {
  try {
    await apply(await gymApi.analyzeSpecDraft(tenantId.value, draftId.value))
  } catch (e) {
    fail(e)
  }
}

async function runTest() {
  if (!form.value || !draft.value) return
  await saveNow()
  try {
    await apply(await gymApi.testSpecDraft(tenantId.value, draft.value.id, toSpec(form.value, name.value || draft.value.name)))
  } catch (e) {
    fail(e)
  }
}

async function finish(body: { name: string; assignToSkill: boolean }, overwrite = false) {
  if (!draft.value) return
  await saveNow()
  busy.value = true
  try {
    const done = await gymApi.finishSpecDraft(tenantId.value, draft.value.id, { ...body, overwrite })
    clearInterval(timer)
    ui.showBanner(
      'ok',
      done.assigned
        ? t('specWizard.save.doneAssigned', { name: done.name, skill: draft.value.skillName ?? '' })
        : t('specWizard.save.done', { name: done.name }),
      6000,
    )
    await gym.reloadCritics(tenantId.value).catch(() => undefined)
    if (done.skillId) await router.push({ name: 'Skill', params: { tenantId: tenantId.value, skillId: done.skillId } })
    else await router.push({ name: 'Settings', params: { tenantId: tenantId.value } })
  } catch (e) {
    if (e instanceof FetcherError && e.status === 409 && !overwrite && /exists/i.test(e.message)) {
      busy.value = false
      if (
        await dialog.confirm({
          title: t('specWizard.save.existsTitle', { name: body.name }),
          text: t('specWizard.save.existsText'),
          ok: t('specWizard.save.overwrite'),
          danger: true,
        })
      ) {
        return finish(body, true)
      }
      return
    }
    fail(e)
  } finally {
    busy.value = false
  }
}

// ------------------------------------------------------------- the evidence
const tasks = computed(() => (analysis.value ? sampleTasks(analysis.value) : []))
const cycles = computed(() => (analysis.value ? cycleCounts(analysis.value) : { perEpisode: [], typical: null }))
const evidence = computed(() => (analysis.value ? criticEvidence(analysis.value) : undefined))
const softEvidence = computed(() =>
  analysis.value && softState(analysis.value) === 'judged' ? indicatorEvidence(analysis.value) : undefined,
)
const durations = computed(() => (analysis.value ? durationRange(analysis.value) : null))
const soft = computed(() => (analysis.value ? softState(analysis.value) : 'off'))
const firstEpisode = computed(() => analysis.value?.episodes[0]?.episode ?? null)
const sheetOf = (episode: number | null) =>
  episode == null || !draft.value ? null : gymApi.specDraftSheetUrl(tenantId.value, draft.value.id, episode)

/**
 * Limits for the duration check from the sample: half the shortest, half again
 * the longest. Not offered when the check measures per repetition (per_cycle):
 * the sample's durations are whole episodes.
 */
const durationSuggestion = computed(() => {
  const d = durations.value
  const check = form.value?.hardCritics.find((h) => h.id === 'duration')
  if (!d || !check || check.params.per_cycle === true) return null
  return { min_s: Math.max(0.5, Math.floor(d.min * 0.5 * 10) / 10), max_s: Math.ceil(d.max * 1.5) }
})
function applyDurationLimits() {
  const c = form.value?.hardCritics.find((h) => h.id === 'duration')
  if (!c || !durationSuggestion.value) return
  c.params = { ...c.params, min_s: durationSuggestion.value.min_s, max_s: durationSuggestion.value.max_s }
  c.enabled = true
}

const stepTitle = (s: SpecDraftStep) => t(`specWizard.steps.${s}`)

onMounted(load)
watch(draftId, () => {
  draft.value = null
  analysis.value = null
  test.value = null
  form.value = null
  name.value = ''
  analysisOf = testOf = null
  void load()
})
onBeforeUnmount(() => {
  clearInterval(timer)
  if (saveTimer) void saveNow()
})
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('specWizard.title')" :sub="draft?.skillName ?? draft?.name ?? undefined">
      <span v-if="draft && saving !== 'idle'" class="text-xs text-surface-500 dark:text-surface-400">{{
        saving === 'saving' ? t('app.saving') : t('app.saved')
      }}</span>
      <SecondaryButton v-if="draft" size="small" :label="t('specWizard.discard')" @click="discard(draft)">
        <template #icon><IconTrash class="size-4" /></template>
      </SecondaryButton>
    </PageTitle>
    <p class="mb-5 max-w-3xl text-surface-600 dark:text-surface-300">{{ t('specWizard.lead') }}</p>

    <div v-if="loading" class="gym-empty">{{ t('app.loading') }}</div>

    <!-- the way in: open drafts and a new one -->
    <template v-else-if="!draftId">
      <div class="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          class="flex cursor-pointer flex-col items-start gap-2 rounded-panel border-2 border-dashed border-surface-300 p-5 text-start transition-colors hover:border-primary dark:border-surface-700"
          :disabled="busy"
          @click="createDraft()"
        >
          <IconAdd class="text-primary size-6" />
          <b class="font-display text-base font-semibold">{{ t('specWizard.new') }}</b>
          <span class="text-sm text-surface-500 dark:text-surface-400">{{ t('specWizard.newHint') }}</span>
        </button>
        <div>
          <span class="gym-field">{{ t('specWizard.open') }}</span>
          <div v-if="!openDrafts.length" class="gym-empty">{{ t('specWizard.noOpen') }}</div>
          <div v-else class="flex flex-col gap-2">
            <div
              v-for="d in openDrafts"
              :key="d.id"
              class="flex items-center gap-3 rounded-panel border border-surface-300 p-3 dark:border-surface-700"
            >
              <RouterLink
                :to="{ name: 'SpecWizard', params: { tenantId, draftId: d.id } }"
                class="min-w-0 grow hover:text-primary"
              >
                <span class="block truncate font-medium">{{ d.name || d.skillName || t('specWizard.unnamed') }}</span>
                <span class="block text-xs text-surface-500 dark:text-surface-400">
                  {{ stepTitle(d.step) }} · {{ d.fileName || t('specWizard.noSampleYet') }} ·
                  {{ fmtDateTime(d.updatedAt, locale) }}
                </span>
              </RouterLink>
              <button
                type="button"
                class="cursor-pointer p-1 text-surface-500 hover:text-bad"
                :aria-label="t('app.delete')"
                @click="discard(d)"
              >
                <IconTrash class="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="draft">
      <!-- the step guide -->
      <ol class="mb-5 flex snap-x gap-1.5 overflow-x-auto pb-1" :aria-label="t('specWizard.title')">
        <li v-for="(s, i) in SPEC_DRAFT_STEPS" :key="s" class="snap-start">
          <button
            type="button"
            class="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors disabled:cursor-default"
            :class="
              s === step
                ? 'border-primary bg-primary text-white shadow-glow'
                : reachable.includes(s)
                  ? 'border-surface-300 bg-surface-0 text-surface-600 hover:border-primary hover:text-primary dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300'
                  : 'border-dashed border-surface-300 bg-transparent text-surface-400 dark:border-surface-700 dark:text-surface-500'
            "
            :disabled="!reachable.includes(s) || s === step"
            :aria-current="s === step ? 'step' : undefined"
            @click="go(s)"
          >
            <IconCheck v-if="i < index" class="text-ok size-3.5" aria-hidden="true" />
            <span v-else class="font-mono text-xs font-semibold" :class="s === step ? 'text-white/70' : 'opacity-70'">{{
              String(i + 1).padStart(2, '0')
            }}</span>
            <span class="font-medium">{{ stepTitle(s) }}</span>
          </button>
        </li>
      </ol>

      <StepSample
        v-if="step === 'sample'"
        :draft="draft"
        :tenant-id="tenantId"
        :skills="skills"
        @update="apply"
        @error="ui.showBanner('err', $event)"
      />

      <StepAnalysis v-else-if="step === 'analysis'" :draft="draft" :report="analysis" :tenant-id="tenantId" @rerun="rerun" />

      <div v-else-if="form" class="gym-stepbox">
        <h2 class="font-display text-xl font-semibold tracking-tight">{{ stepTitle(step) }}</h2>
        <p class="mt-1 mb-5 text-surface-600 dark:text-surface-300">{{ t(`specWizard.lead_${step}`) }}</p>

        <!-- task: the words of the task, next to what the data says -->
        <div v-if="step === 'task'" class="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <SpecForm v-model="form" :critics="critics" :sections="['task']" />
          <aside class="flex flex-col gap-4">
            <div v-if="tasks.length">
              <span class="gym-field">{{ t('specWizard.task.fromData') }}</span>
              <div class="flex flex-col gap-1.5">
                <button
                  v-for="row in tasks"
                  :key="row.task"
                  type="button"
                  class="cursor-pointer rounded-lg border border-surface-300 px-3 py-2 text-start text-sm hover:border-primary dark:border-surface-700"
                  :title="t('specWizard.task.useText')"
                  @click="form.task.instruction = row.task"
                >
                  „{{ row.task }}“
                  <span class="block text-xs text-surface-500 dark:text-surface-400">{{
                    t('specWizard.task.episodes', { n: row.episodes })
                  }}</span>
                </button>
              </div>
              <p v-if="tasks.length > 1" class="mt-1 text-xs text-surface-500 dark:text-surface-400">
                {{ t('specWizard.task.several') }}
              </p>
            </div>
            <div v-if="cycles.perEpisode.length">
              <span class="gym-field">{{ t('specWizard.task.cycles') }}</span>
              <div class="gym-panel p-3 text-sm">
                <div class="flex flex-wrap gap-1">
                  <Pill
                    v-for="c in cycles.perEpisode"
                    :key="c.episode"
                    :tone="c.cycles === form.task.expectedCycles ? 'ok' : 'neutral'"
                    >{{ t('specWizard.episodeShort', { n: c.episode }) }}: {{ c.cycles }}</Pill
                  >
                </div>
                <SecondaryButton
                  v-if="cycles.typical && cycles.typical !== form.task.expectedCycles"
                  class="mt-2"
                  size="small"
                  :label="t('specWizard.task.useCycles', { n: cycles.typical })"
                  @click="form.task.expectedCycles = cycles.typical"
                />
                <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">{{ t('specWizard.task.cyclesHint') }}</p>
              </div>
            </div>
            <SampleSheet
              v-if="firstEpisode != null"
              :src="sheetOf(firstEpisode)!"
              :episode="firstEpisode"
              :caption="t('specWizard.task.sheet')"
            />
          </aside>
        </div>

        <StepRobot
          v-else-if="step === 'robot'"
          v-model="form"
          :report="analysis"
          :sheet-src="sheetOf(firstEpisode)"
          :episode="firstEpisode"
        />

        <!-- checks: every technical check with what it found in the sample -->
        <template v-else-if="step === 'checks'">
          <div v-if="durationSuggestion" class="gym-note mb-4 flex flex-wrap items-center gap-3">
            <span class="grow">{{
              t('specWizard.checks.duration', {
                min: durations!.min.toFixed(1),
                median: durations!.median.toFixed(1),
                max: durations!.max.toFixed(1),
                lo: durationSuggestion.min_s,
                hi: durationSuggestion.max_s,
              })
            }}</span>
            <SecondaryButton size="small" :label="t('specWizard.checks.useDuration')" @click="applyDurationLimits">
              <template #icon><IconMagic class="size-4" /></template>
            </SecondaryButton>
          </div>
          <SpecForm
            v-model="form"
            :critics="critics"
            :sections="['hard']"
            :sample="evidence"
            :sample-episodes="analysis?.n_episodes"
          />
        </template>

        <!-- success: what the vision-language model judges -->
        <template v-else-if="step === 'success'">
          <div v-if="soft !== 'judged'" class="gym-note border-s-warn mb-4">
            {{ soft === 'failed' ? t('specWizard.success.vlmFailed') : t('specWizard.success.vlmOff') }}
            <span v-if="analysis && softError(analysis)" class="block font-mono text-xs opacity-80">{{
              softError(analysis)
            }}</span>
          </div>
          <SpecForm v-model="form" :critics="critics" :sections="['soft']" :soft-sample="softEvidence" />
        </template>

        <!-- scoring: thresholds with the sample moving along -->
        <div v-else-if="step === 'scoring'" class="grid gap-6 xl:grid-cols-[2fr_3fr]">
          <SpecForm v-model="form" :critics="critics" :sections="['scoring']" />
          <ScoringPreview v-if="analysis" v-model="form" :report="analysis" @goto="go" />
        </div>

        <StepSave
          v-else-if="step === 'save'"
          v-model:name="name"
          :draft="draft"
          :form="form"
          :analysis="analysis"
          :test="test"
          :busy="busy"
          @test="runTest"
          @finish="finish"
        />
      </div>

      <!-- back and forth -->
      <div class="mt-5 flex items-center gap-3">
        <SecondaryButton v-if="prev" :label="stepTitle(prev)" @click="go(prev)">
          <template #icon><IconArrowLeft class="size-4" /></template>
        </SecondaryButton>
        <span class="grow" />
        <span v-if="next && !canNext" class="text-sm text-surface-500 dark:text-surface-400">{{
          step === 'sample' ? t('specWizard.needSample') : t('specWizard.needAnalysis')
        }}</span>
        <Button v-if="next" :label="stepTitle(next)" icon-pos="right" :disabled="!canNext" @click="go(next)">
          <template #icon><IconArrowRight class="size-4" /></template>
        </Button>
      </div>
    </template>
  </div>
</template>
