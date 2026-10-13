<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { publicApi } from '@/api/gym'
import type { PublicEvaluationReport } from '@/types/gym'
import { fmtDateTime } from '@/utils/time'
import EvaluationReportBody from '@/components/EvaluationReportBody.vue'

/** The shared, printable evaluation report: what a customer sees under the link, nothing to click but print. */
const route = useRoute()
const { t, locale } = useI18n()
const shareId = computed(() => String(route.params.shareId))
const report = ref<PublicEvaluationReport | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    report.value = await publicApi.evaluationReport(shareId.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
const print = () => window.print()
</script>

<template>
  <div class="mx-auto max-w-[1120px] px-5 py-6 print:px-0 print:py-0">
    <div class="mb-4 flex justify-end print:hidden">
      <SecondaryButton size="small" :label="t('report.print')" @click="print" />
    </div>

    <div v-if="error" class="gym-note border-s-bad">{{ t('report.notFound') }}</div>
    <div v-else-if="!report" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>

    <template v-else>
      <div class="mb-6">
        <div class="gym-field">{{ t('report.title') }}</div>
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ report.name }}</h1>
        <div class="mt-1 font-mono text-xs text-surface-500 dark:text-surface-400">
          {{ report.skill.name }}<template v-if="report.skill.collectionName"> · {{ report.skill.collectionName }}</template> ·
          {{ t('report.updated') }} {{ fmtDateTime(report.updatedAt, locale) }} · {{ shareId }}
        </div>
        <p v-if="report.skill.taskDescription" class="mt-2 text-surface-600 dark:text-surface-300">
          {{ report.skill.taskDescription }}
        </p>
      </div>
      <EvaluationReportBody :figures="report.figures" :sections="report.sections" />
    </template>
  </div>
</template>
