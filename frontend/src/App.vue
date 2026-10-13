<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApp } from '@/stores/app'
import AppShell from '@/components/AppShell.vue'

/**
 * Root: public routes (phone views, print) render bare, everything else
 * inside the shell after the signed-in user and their organisation loaded.
 */
const app = useApp()
const route = useRoute()
const { t } = useI18n()

const isPublic = computed(() => !!route.meta.public)

onMounted(() => {
  if (!isPublic.value) app.init()
})
watch(isPublic, (pub) => {
  if (!pub) app.init()
})

watch(
  () => [app.currentTenant?.name, isPublic.value] as const,
  ([name, pub]) => {
    document.title = !pub && name ? `${name} · ${t('app.name')}` : t('app.name')
  },
  { immediate: true },
)
</script>

<template>
  <RouterView v-if="isPublic" />
  <main v-else-if="!app.loading && app.initError" class="grid min-h-dvh place-items-center p-5">
    <section class="gym-panel w-full max-w-md p-5">
      <h1 class="font-display mb-2 text-lg font-semibold">
        {{ t('app.loadError') }}
      </h1>
      <p class="mb-4 text-sm text-surface-500 dark:text-surface-400">
        {{ app.initError }}
      </p>
      <a
        class="bg-primary hover:bg-primary-emphasis inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors"
        href="/login.html"
        >{{ t('app.signIn') }}</a
      >
    </section>
  </main>
  <AppShell v-else />
</template>
