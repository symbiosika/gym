<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import { NONE } from '@/utils/select'
import { filterSkills } from '@/utils/skills'
import type { SkillListItem, SkillStatus } from '@/types/gym'
import { fmtDate, fmtPercent } from '@/utils/time'

/** Every skill of the organisation in one list, one click from the top navigation: the way to a skill without a detour over the analysis. */
const route = useRoute()
const { t, locale } = useI18n()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))

const skills = ref<SkillListItem[]>([])
const loading = ref(true)
const text = ref('')
const status = ref<string>('active')

const statusOptions = computed(() => [
  { value: NONE, label: t('skills.allStatuses') },
  { value: 'active', label: t('skill.status.active') },
  { value: 'archived', label: t('skill.status.archived') },
])
const shown = computed(() => filterSkills(skills.value, text.value, status.value === NONE ? null : (status.value as SkillStatus)))

onMounted(async () => {
  try {
    skills.value = await gymApi.skills(tenantId.value, { limit: 500 })
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div>
    <PageTitle :title="t('skills.title')" :sub="t('skills.sub')" />

    <div class="mt-4 flex flex-wrap items-end gap-3">
      <FormField class="w-64" :label="t('skills.search')">
        <InputText v-model="text" fluid :placeholder="t('skills.searchPlaceholder')" />
      </FormField>
      <FormField class="w-44" :label="t('skills.status')">
        <Select v-model="status" fluid :options="statusOptions" option-label="label" option-value="value" />
      </FormField>
    </div>

    <div class="gym-panel mt-3 overflow-x-auto">
      <table class="gym-table">
        <thead>
          <tr>
            <th>{{ t('skill.name') }}</th>
            <th>{{ t('skill.collection') }}</th>
            <th>{{ t('continue.lastDay') }}</th>
            <th class="num">{{ t('skill.days') }}</th>
            <th class="num">{{ t('skill.datasets') }}</th>
            <th class="num">{{ t('verdict.accept') }} / {{ t('skill.episodes') }}</th>
            <th class="num">{{ t('skill.tabs.policies') }}</th>
            <th class="num">{{ t('skill.lastEvaluation') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in shown"
            :key="s.id"
            class="hover:bg-surface-100 dark:hover:bg-surface-800/60 cursor-pointer"
            @click="$router.push({ name: 'Skill', params: { tenantId, skillId: s.id } })"
          >
            <td>
              <RouterLink
                class="font-medium hover:underline"
                :to="{ name: 'Skill', params: { tenantId, skillId: s.id } }"
                @click.stop
              >
                {{ s.name }}
              </RouterLink>
            </td>
            <td>{{ s.collectionName ?? '–' }}</td>
            <td class="font-mono text-xs whitespace-nowrap">{{ s.lastDate ? fmtDate(s.lastDate, locale) : '–' }}</td>
            <td class="num">{{ s.days }}</td>
            <td class="num">{{ s.datasets }}</td>
            <td class="num whitespace-nowrap">{{ s.acceptedEpisodes }} / {{ s.episodes }}</td>
            <td class="num">{{ s.policies }}</td>
            <td class="num whitespace-nowrap">{{ s.lastEvaluation ? fmtPercent(s.lastEvaluation.successRatePercent) : '–' }}</td>
            <td>
              <Pill :tone="s.status === 'active' ? 'ok' : 'neutral'">{{ t(`skill.status.${s.status}`) }}</Pill>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!loading && !shown.length" class="gym-empty m-3">
        {{ skills.length ? t('skills.noMatch') : t('skills.none') }}
      </div>
    </div>
  </div>
</template>
