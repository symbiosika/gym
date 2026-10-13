<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { hideInfo, popover } from './infoPopover'

const { t } = useI18n()
const onDoc = (e: Event) => {
  const target = e.target as HTMLElement
  if (target.closest?.('#gym-pop') || target.closest?.('[data-info-button]')) return
  hideInfo()
}
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hideInfo()
onMounted(() => {
  document.addEventListener('click', onDoc)
  document.addEventListener('keydown', onKey)
  window.addEventListener('scroll', hideInfo, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDoc)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', hideInfo, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="popover.open"
      id="gym-pop"
      role="dialog"
      class="gym-panel fixed z-60 w-[min(21rem,calc(100vw-1rem))] p-3.5 text-sm shadow-lg"
      :style="{ left: popover.left + 'px', top: popover.top + 'px' }"
    >
      <b class="font-display block text-[0.95rem] font-semibold">{{ popover.title }}</b>
      <p class="mt-1 text-surface-600 dark:text-surface-300">
        {{ popover.text }}
      </p>
      <p
        v-if="popover.example"
        class="mt-2 border-t border-surface-200 pt-2 text-surface-500 dark:border-surface-800 dark:text-surface-400"
      >
        <span class="me-1.5 text-xs font-semibold tracking-wide uppercase">{{ t('app.example') }}</span
        >{{ popover.example }}
      </p>
    </div>
  </Teleport>
</template>
