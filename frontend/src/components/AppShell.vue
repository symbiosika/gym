<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApp } from '@/stores/app'
import { useGym } from '@/stores/gym'
import { useUi, type ThemePref } from '@/stores/ui'
import { useProfile } from '@/stores/profile'
import type { Lang } from '@/i18n'
import AppBanner from './AppBanner.vue'
import InfoPopover from './InfoPopover.vue'
import ConfirmModal from './ConfirmModal.vue'
import ProfileModal from './ProfileModal.vue'
import IconMoon from '~icons/carbon/moon'
import IconSun from '~icons/carbon/sun'
import IconChevronDown from '~icons/carbon/chevron-down'

/** Header with brand, the three main areas, language, theme, avatar menu; then the current view. */
const app = useApp()
const gym = useGym()
const ui = useUi()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const profile = useProfile()
const profileOpen = ref(false)
onMounted(() => {
  profile.loadMyInvitations().catch(() => {})
})

const tenantId = computed(() => String(route.params.tenantId ?? app.selectedTenant ?? ''))
watch(
  tenantId,
  (id) => {
    if (id) gym.load(id).catch((e) => ui.showBanner('err', e instanceof Error ? e.message : String(e)))
  },
  { immediate: true },
)

const tabs = computed(() => [
  {
    name: 'Home',
    label: t('app.nav.home'),
    match: ['Home', 'StartBlock', 'Continue', 'Block', 'Day'],
  },
  {
    name: 'Analysis',
    label: t('app.nav.analysis'),
    match: ['Analysis', 'Skill'],
  },
  { name: 'Settings', label: t('app.nav.settings'), match: ['Settings'] },
])
const isActive = (match: string[]) => match.includes(String(route.name))

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const onDocClick = (e: MouseEvent) => {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) menuOpen.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

function openProfile() {
  profileOpen.value = true
  menuOpen.value = false
}
async function switchTenant(id: string) {
  await app.selectTenant(id)
  menuOpen.value = false
  router.push({ name: 'Home', params: { tenantId: id } })
}
const themes: ThemePref[] = ['system', 'light', 'dark']
const initials = computed(() => {
  const n = app.displayName.trim()
  if (!n) return '?'
  const parts = n.includes('@') ? [n] : n.split(/\s+/)
  return parts.length > 1 ? (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase() : n.slice(0, 1).toUpperCase()
})

const menuItem =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-start text-sm transition-colors hover:bg-surface-100 dark:hover:bg-surface-800 aria-[current=true]:font-semibold aria-[current=true]:text-primary'
</script>

<template>
  <header
    class="sticky top-0 z-40 border-b border-surface-300 bg-surface-0/85 backdrop-blur-md dark:border-surface-800 dark:bg-surface-900/85 print:hidden"
  >
    <div class="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5">
      <RouterLink class="group flex min-w-0 items-baseline gap-2" :to="tenantId ? { name: 'Home', params: { tenantId } } : '/'">
        <h1 class="font-display text-primary text-xl leading-none font-bold tracking-tight">
          {{ t('app.name') }}
        </h1>
        <span class="truncate text-xs text-surface-500 dark:text-surface-400">{{ app.currentTenant?.name ?? t('app.sub') }}</span>
      </RouterLink>

      <nav v-if="tenantId" class="flex items-center gap-0.5" role="tablist">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.name"
          role="tab"
          class="rounded-md px-2.5 py-1.5 text-sm font-medium text-surface-600 transition-colors hover:bg-surface-100 hover:text-surface-900 aria-selected:bg-primary/10 aria-selected:text-primary dark:text-surface-300 dark:hover:bg-surface-800 dark:hover:text-surface-0 dark:aria-selected:bg-primary/15"
          :aria-selected="isActive(tab.match)"
          :to="{ name: tab.name, params: { tenantId } }"
        >
          {{ tab.label }}
        </RouterLink>
      </nav>

      <div class="ms-auto flex items-center gap-2">
        <div
          class="flex overflow-hidden rounded-md border border-surface-300 dark:border-surface-700"
          role="group"
          aria-label="Sprache / Language"
        >
          <button
            v-for="l in ['de', 'en'] as Lang[]"
            :key="l"
            type="button"
            class="cursor-pointer px-2 py-1 text-xs font-semibold text-surface-500 transition-colors hover:bg-surface-100 aria-pressed:bg-primary aria-pressed:text-white dark:text-surface-400 dark:hover:bg-surface-800"
            :aria-pressed="ui.lang === l"
            @click="ui.switchLang(l)"
          >
            {{ l.toUpperCase() }}
          </button>
        </div>

        <SecondaryButton
          variant="text"
          rounded
          :aria-label="t('app.theme.label')"
          v-tooltip.bottom="t(`app.theme.${ui.theme}`)"
          @click="ui.toggleTheme()"
        >
          <template #icon>
            <IconSun v-if="ui.dark" />
            <IconMoon v-else />
          </template>
        </SecondaryButton>

        <div v-if="app.user" ref="menuRef" class="relative">
          <button
            type="button"
            class="flex cursor-pointer items-center gap-1 rounded-full border border-surface-300 py-0.5 ps-0.5 pe-1.5 transition-colors hover:border-primary dark:border-surface-700"
            :aria-expanded="menuOpen"
            :title="app.displayName"
            @click="menuOpen = !menuOpen"
          >
            <span class="bg-primary grid size-7 place-items-center rounded-full text-xs font-bold text-white">{{
              initials
            }}</span>
            <IconChevronDown class="size-3.5 text-surface-500" />
          </button>
          <span
            v-if="profile.myInvitations.length"
            class="bg-warn pointer-events-none absolute -top-0.5 -end-0.5 grid size-4 place-items-center rounded-full text-[10px] font-bold text-white"
            :title="t('profile.invitations')"
            >{{ profile.myInvitations.length }}</span
          >

          <div
            v-if="menuOpen"
            class="gym-panel absolute end-0 top-[calc(100%+0.5rem)] z-50 flex w-60 flex-col gap-0.5 p-1.5 shadow-lg"
          >
            <div class="truncate px-2.5 pt-1 pb-0.5 text-xs font-semibold text-surface-500 dark:text-surface-400">
              {{ app.displayName }}
            </div>
            <button type="button" :class="menuItem" @click="openProfile()">
              {{ t('profile.menu') }}
              <Pill v-if="profile.myInvitations.length" tone="warn" class="ms-auto">{{ profile.myInvitations.length }}</Pill>
            </button>

            <hr class="my-1 border-surface-200 dark:border-surface-800" />
            <div class="px-2.5 text-xs font-semibold text-surface-500 dark:text-surface-400">
              {{ t('app.org') }}
            </div>
            <button
              v-for="tn in app.tenants"
              :key="tn.id"
              type="button"
              :class="menuItem"
              :aria-current="tn.id === app.selectedTenant"
              @click="switchTenant(tn.id)"
            >
              {{ tn.name }}
            </button>

            <hr class="my-1 border-surface-200 dark:border-surface-800" />
            <div class="px-2.5 text-xs font-semibold text-surface-500 dark:text-surface-400">
              {{ t('app.theme.label') }}
            </div>
            <button
              v-for="th in themes"
              :key="th"
              type="button"
              :class="menuItem"
              :aria-current="ui.theme === th"
              @click="ui.setTheme(th)"
            >
              {{ t(`app.theme.${th}`) }}
            </button>

            <hr class="my-1 border-surface-200 dark:border-surface-800" />
            <button type="button" :class="menuItem" @click="app.logout()">
              {{ t('app.logout') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <div v-if="app.loading" class="px-5 py-16 text-center text-surface-500 dark:text-surface-400">{{ t('app.loading') }} …</div>
  <RouterView v-else />

  <AppBanner />
  <InfoPopover />
  <ConfirmModal />
  <ProfileModal v-model:visible="profileOpen" />
</template>
