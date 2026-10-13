import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  text?: string
  ok?: string
  cancel?: string
  danger?: boolean
}

/** Promise-based confirm dialog, rendered once by ConfirmModal in the shell. */
export const useDialog = defineStore('dialog', () => {
  const current = ref<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      current.value = { ...options, resolve }
    })
  }
  function answer(value: boolean) {
    current.value?.resolve(value)
    current.value = null
  }
  return { current, confirm, answer }
})
