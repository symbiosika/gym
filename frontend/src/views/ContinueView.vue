<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useUi } from '@/stores/ui'
import type { SkillListItem } from '@/types/gym'
import { fmtDate, fmtPercent } from '@/utils/time'

/** Pick a skill to work on today; the list is sorted by the last day, newest first. */
const route = useRoute()
const { t, locale } = useI18n()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))
const skills = ref<SkillListItem[]>([])
const showArchived = ref(false)
const loading = ref(true)

const shown = computed(() => skills.value.filter((s) => showArchived.value || s.status === 'active'))

onMounted(async () => {
  try {
    skills.value = await gymApi.skills(tenantId.value, { limit: 200 })
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('continue.title')" :sub="t('continue.hint')">
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox v-model="showArchived" binary /> {{ t('continue.showArchived') }}
      </label>
      <RouterLink :to="{ name: 'Home', params: { tenantId } }">
        <SecondaryButton size="small" :label="t('app.back')" />
      </RouterLink>
    </PageTitle>

    <div v-if="loading" class="py-10 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <div v-else-if="!shown.length" class="gym-empty mt-4">
      {{ t('continue.empty') }}
    </div>
    <div v-else class="gym-panel mt-4 overflow-x-auto">
      <table class="gym-table">
        <thead>
          <tr>
            <th>{{ t('continue.lastDay') }}</th>
            <th>{{ t('skill.name') }}</th>
            <th>{{ t('skill.collection') }}</th>
            <th class="num">{{ t('continue.days') }}</th>
            <th class="num">{{ t('continue.episodes') }}</th>
            <th class="num">{{ t('skill.lastEvaluation') }}</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in shown" :key="s.id">
            <td class="font-mono text-xs whitespace-nowrap">{{ s.lastDate ? fmtDate(s.lastDate, locale) : '–' }}</td>
            <td>
              <RouterLink
                class="text-primary font-medium hover:underline"
                :to="{ name: 'Skill', params: { tenantId, skillId: s.id } }"
                >{{ s.name }}</RouterLink
              >
              <div class="text-xs text-surface-500 dark:text-surface-400">{{ s.taskDescription }}</div>
            </td>
            <td class="whitespace-nowrap">{{ s.collectionName ?? '–' }}</td>
            <td class="num">{{ s.days }}</td>
            <td class="num whitespace-nowrap">{{ s.acceptedEpisodes }} / {{ s.episodes }}</td>
            <td class="num whitespace-nowrap">
              <template v-if="s.lastEvaluation">{{ fmtPercent(s.lastEvaluation.successRatePercent) }}</template>
              <template v-else>–</template>
            </td>
            <td>
              <Pill :tone="s.status === 'active' ? 'ok' : 'neutral'">{{ t(`skill.status.${s.status}`) }}</Pill>
            </td>
            <td>
              <div class="flex gap-1.5">
                <RouterLink :to="{ name: 'StartBlock', params: { tenantId }, query: { skillId: s.id, kind: 'recording' } }">
                  <Button size="small" :label="t('continue.record')" />
                </RouterLink>
                <RouterLink :to="{ name: 'StartBlock', params: { tenantId }, query: { skillId: s.id, kind: 'evaluation' } }">
                  <SecondaryButton size="small" :label="t('continue.evaluate')" />
                </RouterLink>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
