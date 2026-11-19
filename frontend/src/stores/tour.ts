import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TourChapterId, TourUi } from '@/tour/chapters'
import type { TourMaterial } from '@/types/gym'

/**
 * The state of the guided tour. Only UI state: the chapter dialog, the
 * chapters asked for, whether a tour runs, and what the current step shows on
 * top of its page (the spec manager). The runner is `TourHost`, which reads
 * and writes this; the screens only read `active` to stay read-only while a
 * tour looks at them. Nothing here calls an API that writes.
 */
export const useTour = defineStore('tour', () => {
  const dialogOpen = ref(false)
  /** a tour runs: screens it looks at are read-only */
  const active = ref(false)
  /** the chapters the dialog asked for; the host starts them and clears this */
  const requested = ref<TourChapterId[] | null>(null)
  const material = ref<TourMaterial | null>(null)
  const ui = ref<TourUi>({})

  const openDialog = () => (dialogOpen.value = true)
  function start(chapters: TourChapterId[]) {
    dialogOpen.value = false
    requested.value = chapters
  }
  function reset() {
    active.value = false
    requested.value = null
    ui.value = {}
  }
  return { dialogOpen, active, requested, material, ui, openDialog, start, reset }
})
