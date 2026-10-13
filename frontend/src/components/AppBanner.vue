<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUi } from '@/stores/ui'
import IconWarning from '~icons/carbon/warning-filled'
import IconCheckmark from '~icons/carbon/checkmark-filled'
import IconInformation from '~icons/carbon/information-filled'

/** The one message strip of the app, pinned above the action bar. */
const ui = useUi()
const { t } = useI18n()

const look = computed(() => {
  switch (ui.banner?.kind) {
    case 'ok':
      return {
        icon: IconCheckmark,
        ring: 'ring-ok/30',
        bg: 'bg-ok-soft',
        fg: 'text-ok',
      }
    case 'info':
      return {
        icon: IconInformation,
        ring: 'ring-primary/30',
        bg: 'bg-primary-50 dark:bg-primary-500/10',
        fg: 'text-primary',
      }
    default:
      return {
        icon: IconWarning,
        ring: 'ring-bad/30',
        bg: 'bg-bad-soft',
        fg: 'text-bad',
      }
  }
})
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-3 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="translate-y-3 opacity-0"
  >
    <div v-if="ui.banner" class="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-4 print:hidden" role="alert">
      <div
        class="pointer-events-auto mx-auto flex max-w-5xl items-center gap-3 rounded-lg px-4 py-3 shadow-lg ring-1"
        :class="[look.bg, look.ring]"
      >
        <component :is="look.icon" class="size-5 shrink-0" :class="look.fg" aria-hidden="true" />
        <span class="min-w-0 grow break-words text-sm" :class="look.fg">{{ ui.banner.text }}</span>
        <SecondaryButton size="small" :label="t('app.close')" @click="ui.hideBanner()" />
      </div>
    </div>
  </Transition>
</template>
