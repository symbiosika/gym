<script setup lang="ts">
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '@/stores/app'

/** Sends the signed-in user to the home page of their current organisation. */
const app = useApp()
const router = useRouter()
watch(
  () => app.selectedTenant,
  (id) => {
    if (id) router.replace({ name: 'Home', params: { tenantId: id } })
  },
  { immediate: true },
)
</script>

<template>
  <div class="py-16 text-center font-mono text-xs text-surface-500">…</div>
</template>
