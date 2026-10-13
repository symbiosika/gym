import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetcher } from '@/utils/fetcher'

interface User {
  id: string
  email: string
  firstname?: string
  surname?: string
  lastTenantId?: string
}
interface Tenant {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
}

/** Signed-in user and their organisations (framework user management). */
export const useApp = defineStore('app', () => {
  const loading = ref(true)
  const initError = ref<string | null>(null)
  const user = ref<User | null>(null)
  const tenants = ref<Tenant[]>([])
  const selectedTenant = ref('')
  let initPromise: Promise<void> | null = null

  const currentTenant = computed(() => tenants.value.find((t) => t.id === selectedTenant.value) ?? null)
  /** owners and admins manage members, invitations and codes */
  const isAdmin = computed(() => currentTenant.value?.role === 'owner' || currentTenant.value?.role === 'admin')
  const displayName = computed(() => {
    const u = user.value
    if (!u) return ''
    const n = [u.firstname, u.surname].filter(Boolean).join(' ')
    return n || u.email
  })

  async function loadTenants() {
    const list = await fetcher.get<{ tenantId: string; name: string; role: Tenant['role'] }[]>('/api/v1/user/tenants')
    tenants.value = list.map((t) => ({ id: t.tenantId, name: t.name, role: t.role ?? 'member' }))
  }

  async function init() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      loading.value = true
      initError.value = null
      try {
        user.value = await fetcher.get<User>('/api/v1/user/me')
        await loadTenants()
        if (!tenants.value.length) {
          // first login: every user gets an organisation, the framework scopes all data to it
          await fetcher.post('/api/v1/tenant', { name: 'Gym' })
          await loadTenants()
        }
        const last = user.value.lastTenantId
        selectedTenant.value = last && tenants.value.some((t) => t.id === last) ? last : (tenants.value[0]?.id ?? '')
      } catch (e) {
        initError.value = e instanceof Error ? e.message : String(e)
      } finally {
        loading.value = false
      }
    })()
    return initPromise
  }

  async function selectTenant(tenantId: string) {
    if (!tenantId || tenantId === selectedTenant.value) return
    await fetcher.put('/api/v1/user/last-tenant', { tenantId })
    selectedTenant.value = tenantId
  }

  async function refreshUser() {
    user.value = await fetcher.get<User>('/api/v1/user/me')
  }

  function logout() {
    window.location.href = '/logout.html'
  }

  return {
    loading,
    initError,
    user,
    tenants,
    selectedTenant,
    currentTenant,
    isAdmin,
    displayName,
    init,
    loadTenants,
    refreshUser,
    selectTenant,
    logout,
  }
})
