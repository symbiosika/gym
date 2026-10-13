<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useUi } from '@/stores/ui'
import type { BlockKind, PolicyRecord, SkillListItem } from '@/types/gym'
import SectionHeader from '@/components/SectionHeader.vue'
import SpecPicker from '@/components/SpecPicker.vue'
import { NONE } from '@/utils/select'

/**
 * Start a block: pick the cell, say what is done (recording or evaluation),
 * pick the skill (or create one on the spot) and, for an evaluation, the
 * policy under test. Today's day protocol of the cell is created when it is
 * missing; the wizard opens on the new block.
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const gym = useGym()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))

const cellId = ref('')
const kind = ref<BlockKind>((route.query.kind === 'evaluation' ? 'evaluation' : 'recording') as BlockKind)
const skills = ref<SkillListItem[]>([])
const skillId = ref(typeof route.query.skillId === 'string' ? route.query.skillId : '')
const newSkill = ref(false)
const name = ref('')
const taskDescription = ref('')
const collectionId = ref(NONE)
const criticSpecName = ref<string | null>(null)
const policies = ref<PolicyRecord[]>([])
const policyId = ref(NONE)
const busy = ref(false)
const loading = ref(true)
const cells = computed(() => gym.cells.filter((c) => c.active))

const skillOptions = computed(() => skills.value.map((s) => ({ label: s.name, value: s.id })))
const collectionOptions = computed(() => [
  { label: t('start.noCollection'), value: NONE },
  ...gym.collections.map((c) => ({ label: c.name, value: c.id })),
])
const policyOptions = computed(() => [
  { label: t('start.noPolicy'), value: NONE },
  ...policies.value.map((p) => ({ label: p.name, value: p.id })),
])
const selectedSkill = computed(() => skills.value.find((s) => s.id === skillId.value) ?? null)

/** The cell is remembered per browser: the operator usually stands at the same one. */
const LAST_CELL = 'gym.lastCellId'
function rememberCell(id: string) {
  cellId.value = id
  try {
    localStorage.setItem(LAST_CELL, id)
  } catch {
    /* a private window keeps nothing */
  }
}
function preselectCell() {
  if (cellId.value || !cells.value.length) return
  let last = ''
  try {
    last = localStorage.getItem(LAST_CELL) ?? ''
  } catch {
    /* nothing remembered */
  }
  if (cells.value.some((c) => c.id === last)) cellId.value = last
  else if (cells.value.length === 1) cellId.value = cells.value[0]!.id
}
watch(cells, preselectCell, { immediate: true })

/** With many skills a filter narrows the cards; a handful is shown as is. */
const skillFilter = ref('')
const visibleSkills = computed(() => {
  const q = skillFilter.value.trim().toLowerCase()
  return q
    ? skills.value.filter((s) => s.name.toLowerCase().includes(q) || s.taskDescription.toLowerCase().includes(q))
    : skills.value
})

onMounted(async () => {
  try {
    skills.value = await gymApi.skills(tenantId.value, { status: 'active', limit: 500 })
    if (!skills.value.length) newSkill.value = true
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
})

// the policies of the picked skill, for an evaluation
watch(
  [skillId, kind],
  async ([id, k]) => {
    policyId.value = NONE
    policies.value = []
    if (!id || k !== 'evaluation') return
    try {
      // no policy is preselected: "ohne Angabe" is the honest default, the
      // operator says which trained version runs
      policies.value = await gymApi.policies(tenantId.value, id)
    } catch (e) {
      ui.showBanner('err', e instanceof Error ? e.message : String(e))
    }
  },
  { immediate: true },
)

const canSubmit = computed(() => !!cellId.value && (newSkill.value ? name.value.trim().length > 0 : !!skillId.value))
/** what is still missing, said next to the start button instead of a silent grey button */
const missingHint = computed(() =>
  !cellId.value
    ? t('start.missing.cell')
    : newSkill.value && !name.value.trim()
      ? t('start.missing.name')
      : !newSkill.value && !skillId.value
        ? t('start.missing.skill')
        : '',
)
const selectedCell = computed(() => cells.value.find((c) => c.id === cellId.value) ?? null)
const summary = computed(() =>
  [
    selectedCell.value?.name,
    t(`block.kind.${kind.value}`),
    newSkill.value ? name.value.trim() || null : selectedSkill.value?.name,
  ]
    .filter(Boolean)
    .join(' · '),
)

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  try {
    let id = skillId.value
    if (newSkill.value) {
      const created = await gymApi.createSkill(tenantId.value, {
        name: name.value.trim(),
        taskDescription: taskDescription.value.trim(),
        collectionId: collectionId.value === NONE ? null : collectionId.value,
        criticSpecName: criticSpecName.value,
      })
      id = created.id
    }
    const { block } = await gymApi.startBlock(tenantId.value, {
      cellId: cellId.value,
      skillId: id,
      kind: kind.value,
      policyId: kind.value === 'evaluation' && policyId.value !== NONE ? policyId.value : null,
    })
    router.push({ name: 'Block', params: { tenantId: tenantId.value, blockId: block.id } })
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

const chip = (on: boolean) =>
  on
    ? 'border-primary bg-primary/10 text-primary font-medium'
    : 'border-surface-300 text-surface-600 hover:border-primary dark:border-surface-700 dark:text-surface-300'
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('start.title')">
      <RouterLink :to="{ name: 'Home', params: { tenantId } }">
        <SecondaryButton size="small" :label="t('app.back')" />
      </RouterLink>
    </PageTitle>

    <section class="mt-6">
      <SectionHeader n="01" :title="t('start.cell')" />
      <div v-if="!cells.length" class="gym-note border-s-warn">
        {{ t('start.noCells') }}
        <RouterLink class="text-primary hover:underline" :to="{ name: 'Settings', params: { tenantId } }">{{
          t('app.nav.settings')
        }}</RouterLink>
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <button
          v-for="c in cells"
          :key="c.id"
          type="button"
          class="flex cursor-pointer items-baseline gap-2 rounded-full border px-3.5 py-2 text-sm transition-colors"
          :class="chip(cellId === c.id)"
          @click="rememberCell(c.id)"
        >
          {{ c.name }}
          <span v-if="c.location" class="text-xs opacity-70">{{ c.location }}</span>
        </button>
      </div>
    </section>

    <section class="mt-8">
      <SectionHeader n="02" :title="t('start.kind')" :hint="t('start.kindHint')" />
      <div class="flex flex-wrap gap-2">
        <button
          v-for="k in ['recording', 'evaluation'] as BlockKind[]"
          :key="k"
          type="button"
          class="flex cursor-pointer flex-col items-start gap-0.5 rounded-panel border px-4 py-3 text-start transition-colors"
          :class="chip(kind === k)"
          @click="kind = k"
        >
          <b class="text-sm">{{ t(`block.kind.${k}`) }}</b>
          <span class="text-xs opacity-80">{{ t(`block.kindHint.${k}`) }}</span>
        </button>
      </div>
    </section>

    <section class="mt-8">
      <SectionHeader n="03" :title="t('start.skill')" :hint="t('start.skillHint')" />
      <div v-if="loading" class="py-6 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
      <template v-else>
        <div class="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-full border px-3.5 py-2 text-sm transition-colors"
            :class="chip(!newSkill)"
            :disabled="!skills.length"
            @click="newSkill = false"
          >
            {{ t('start.existingSkill') }}
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-full border px-3.5 py-2 text-sm transition-colors"
            :class="chip(newSkill)"
            @click="newSkill = true"
          >
            {{ t('start.newSkill') }}
          </button>
        </div>

        <div v-if="!newSkill" class="flex flex-col gap-3">
          <InputText
            v-if="skills.length > 6"
            v-model="skillFilter"
            class="sm:max-w-sm"
            :placeholder="t('start.filterSkills')"
            :aria-label="t('start.filterSkills')"
          />
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" :aria-label="t('start.skill')">
            <button
              v-for="s in visibleSkills"
              :key="s.id"
              type="button"
              role="radio"
              :aria-checked="skillId === s.id"
              class="flex cursor-pointer flex-col items-start gap-1 rounded-panel border px-4 py-3 text-start transition-colors"
              :class="chip(skillId === s.id)"
              @click="skillId = s.id"
            >
              <b class="text-sm">{{ s.name }}</b>
              <span v-if="s.taskDescription" class="line-clamp-2 text-xs opacity-80">{{ s.taskDescription }}</span>
              <span class="font-mono text-[0.7rem] opacity-70">{{
                t('start.skillFigures', { days: s.days, episodes: s.acceptedEpisodes, policies: s.policies })
              }}</span>
            </button>
          </div>
          <div v-if="!visibleSkills.length" class="gym-empty">{{ t('start.noSkillMatch') }}</div>
          <FormField
            v-if="kind === 'evaluation' && skillId"
            class="sm:max-w-md"
            :label="t('start.policy')"
            :hint="t('start.policyHint')"
          >
            <Select v-model="policyId" fluid :options="policyOptions" option-label="label" option-value="value" />
          </FormField>
        </div>

        <div v-else class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-3">
            <FormField :label="t('start.name')" required>
              <InputText v-model="name" fluid :placeholder="t('start.namePlaceholder')" />
            </FormField>
            <FormField :label="t('start.collection')">
              <Select v-model="collectionId" fluid :options="collectionOptions" option-label="label" option-value="value" />
            </FormField>
          </div>
          <div class="flex flex-col gap-3">
            <FormField :label="t('start.task')">
              <Textarea v-model="taskDescription" rows="3" fluid :placeholder="t('start.taskPlaceholder')" />
            </FormField>
            <FormField :label="t('start.spec')" :hint="t('start.specHint')">
              <SpecPicker v-model="criticSpecName" :tenant-id="tenantId" />
            </FormField>
          </div>
        </div>
      </template>
    </section>

    <!-- the decision so far in one line, and the one action; stays in view while the lists scroll -->
    <div
      class="sticky bottom-0 z-10 mt-8 -mx-5 flex flex-wrap items-center gap-3 border-t border-surface-300 bg-surface-100/95 px-5 py-3 backdrop-blur dark:border-surface-800 dark:bg-surface-950/95"
    >
      <span class="min-w-0 grow truncate text-sm">
        <b v-if="summary" class="font-semibold">{{ summary }}</b>
        <span v-if="missingHint" class="ms-2 text-surface-500 dark:text-surface-400">{{ missingHint }}</span>
      </span>
      <Button :disabled="!canSubmit || busy" :loading="busy" :label="t(`start.submit.${kind}`)" @click="submit" />
    </div>
  </div>
</template>
