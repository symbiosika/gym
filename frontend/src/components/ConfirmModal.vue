<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialog } from '@/stores/dialog'

const dialog = useDialog()
const { t } = useI18n()
const visible = computed({
  get: () => dialog.current !== null,
  set: (v) => !v && dialog.answer(false),
})
</script>

<template>
  <Modal v-if="dialog.current" v-model:visible="visible" :title="dialog.current.title" size="sm">
    <p v-if="dialog.current.text" class="text-surface-600 dark:text-surface-300">
      {{ dialog.current.text }}
    </p>
    <template #footer>
      <SecondaryButton :label="dialog.current.cancel ?? t('app.cancel')" @click="dialog.answer(false)" />
      <span class="grow"></span>
      <Button
        :label="dialog.current.ok ?? t('app.yes')"
        :class="dialog.current.danger ? 'border-bad! bg-bad! text-white! hover:brightness-110' : ''"
        @click="dialog.answer(true)"
      />
    </template>
  </Modal>
</template>
