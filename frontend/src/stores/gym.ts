import { defineStore } from 'pinia'
import { ref } from 'vue'
import { gymApi } from '@/api/gym'
import type { AiInfo, Cell, Collection, CriticsStatus } from '@/types/gym'

/** Shared pick lists of the organisation, the AI status and the critics service; views load their own data. */
export const useGym = defineStore('gym', () => {
  const cells = ref<Cell[]>([])
  const collections = ref<Collection[]>([])
  const ai = ref<AiInfo>({
    provider: 'none',
    enabled: false,
    imageEnabled: false,
    imageModel: null,
  })
  const critics = ref<CriticsStatus>({
    reachable: false,
    url: null,
    health: null,
    specs: [],
  })
  const loadedFor = ref('')

  async function load(tenantId: string, force = false) {
    if (!force && loadedFor.value === tenantId) return
    // sequential on purpose: the local development database serves one query at a time
    cells.value = await gymApi.cells(tenantId)
    collections.value = await gymApi.collections(tenantId)
    ai.value = await gymApi.ai(tenantId).catch(
      () =>
        ({
          provider: 'none',
          enabled: false,
          imageEnabled: false,
          imageModel: null,
        }) as AiInfo,
    )
    critics.value = await gymApi.critics(tenantId).catch(
      () =>
        ({
          reachable: false,
          url: null,
          health: null,
          specs: [],
        }) as CriticsStatus,
    )
    loadedFor.value = tenantId
  }

  /** The critics' state and spec list again, after a spec was uploaded. */
  async function reloadCritics(tenantId: string) {
    critics.value = await gymApi.critics(tenantId)
  }

  const cellName = (id: string) => cells.value.find((c) => c.id === id)?.name ?? ''

  return { cells, collections, ai, critics, load, reloadCritics, cellName }
})
