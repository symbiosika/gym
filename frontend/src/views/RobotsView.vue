<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApp } from '@/stores/app'
import { useGym } from '@/stores/gym'
import { useUi } from '@/stores/ui'
import type { Robot } from '@/types/gym'
import { COMPONENT_STATUS_TONE, ROBOT_STATUS_TONE, componentCount, healthIssues } from '@/utils/robots'
import RobotThumb from '@/components/robots/RobotThumb.vue'
import RobotModal from '@/components/robots/RobotModal.vue'
import IconAdd from '~icons/carbon/add'
import IconLocation from '~icons/carbon/location'
import IconChevronRight from '~icons/carbon/chevron-right'

/**
 * The robots of the organisation: photo, names, the cell each is in, its
 * status and the components that need a look. A robot opens in the modal;
 * `?robot=<id>` keeps it open across a reload and makes it linkable.
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const app = useApp()
const gym = useGym()
const ui = useUi()
const tenantId = computed(() => String(route.params.tenantId))
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

/** the robot open in the modal; null with the modal open means "new robot" */
const openId = ref<string | null>(null)
const modalOpen = ref(false)

onMounted(() => gym.reloadRobots(tenantId.value).catch(fail))

watch(
  () => route.query.robot,
  (id) => {
    if (typeof id === 'string' && id) {
      openId.value = id
      modalOpen.value = true
    }
  },
  { immediate: true },
)
watch(modalOpen, (open) => {
  if (!open && route.query.robot) router.replace({ query: { ...route.query, robot: undefined } })
})

function open(r: Robot) {
  router.replace({ query: { ...route.query, robot: r.id } })
}
function openNew() {
  openId.value = null
  modalOpen.value = true
}

/** A robot was created or changed in the modal: keep the list in step, cells included. */
function onChanged(r: Robot) {
  if (openId.value !== r.id) router.replace({ query: { ...route.query, robot: r.id } })
  gym.reloadRobots(tenantId.value).catch(fail)
}
function onDeleted() {
  gym.reloadRobots(tenantId.value).catch(fail)
}

const inCells = computed(() => gym.robots.filter((r) => r.cell).length)
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('robots.title')" :sub="t('robots.count', { n: gym.robots.length, inCells })">
      <Button v-if="app.isAdmin" :label="t('robots.new')" @click="openNew">
        <template #icon><IconAdd /></template>
      </Button>
    </PageTitle>
    <p class="mb-5 text-sm text-surface-500 dark:text-surface-400">{{ t('robots.hint') }}</p>

    <div v-if="!gym.robots.length" class="gym-empty">{{ t('robots.empty') }}</div>
    <ul v-else class="flex flex-col gap-2">
      <li v-for="r in gym.robots" :key="r.id">
        <button
          type="button"
          class="gym-panel hover:border-primary/60 focus-visible:border-primary flex w-full cursor-pointer items-center gap-4 p-3 text-start transition-colors outline-none"
          :class="r.status === 'retired' ? 'opacity-70' : ''"
          @click="open(r)"
        >
          <RobotThumb :tenant-id="tenantId" :robot="r" />
          <div class="flex min-w-0 grow flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
            <div class="min-w-0 sm:w-56">
              <div class="truncate font-semibold">{{ r.personalName || r.technicalName }}</div>
              <div v-if="r.personalName" class="truncate font-mono text-xs text-surface-500 dark:text-surface-400">
                {{ r.technicalName }}
              </div>
            </div>
            <div class="flex min-w-0 items-center gap-1.5 text-sm sm:w-56">
              <IconLocation class="shrink-0 text-surface-400" aria-hidden="true" />
              <template v-if="r.cell">
                <span class="truncate font-medium">{{ r.cell.name }}</span>
                <span v-if="r.cell.location" class="truncate text-xs text-surface-500 dark:text-surface-400">{{
                  r.cell.location
                }}</span>
              </template>
              <span v-else class="text-surface-500 dark:text-surface-400">{{ t('robots.notInCell') }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <Pill :tone="ROBOT_STATUS_TONE[r.status]">{{ t(`robots.status.${r.status}`) }}</Pill>
              <template v-if="componentCount(r.health)">
                <Pill v-for="h in healthIssues(r.health)" :key="h.status" :tone="COMPONENT_STATUS_TONE[h.status]">
                  {{ t(`robots.healthCount.${h.status}`, { n: h.n }) }}
                </Pill>
                <span v-if="!healthIssues(r.health).length" class="text-xs text-surface-500 dark:text-surface-400">
                  {{ t('robots.components', { n: componentCount(r.health) }) }} · {{ t('robots.healthAllOk') }}
                </span>
              </template>
              <span v-else class="text-xs text-surface-500 dark:text-surface-400">{{ t('robots.healthNone') }}</span>
            </div>
          </div>
          <IconChevronRight class="shrink-0 text-surface-400" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <RobotModal v-model:visible="modalOpen" :tenant-id="tenantId" :robot-id="openId" @changed="onChanged" @deleted="onDeleted" />
  </div>
</template>
