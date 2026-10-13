import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetcher } from '@/utils/fetcher'

export type MemberRole = 'owner' | 'admin' | 'member'

export interface Member {
  id: string
  userEmail: string
  role: MemberRole
  joinedAt?: string
}
export interface Invitation {
  id: string
  tenantId: string
  email: string
  role: MemberRole
  status: 'pending' | 'accepted' | 'declined'
  createdAt: string
}
/**
 * Organisation management: members and invitations (framework API).
 * Invitation codes are not managed here; they are a server side feature.
 */
export const useOrg = defineStore('org', () => {
  const members = ref<Member[]>([])
  const invitations = ref<Invitation[]>([])
  const loadedFor = ref('')

  const api = (t: string) => `/api/v1/tenant/${t}`

  async function loadMembers(tenantId: string, force = false) {
    if (!force && loadedFor.value === tenantId && members.value.length) return members.value
    members.value = await fetcher.get<Member[]>(`${api(tenantId)}/members`)
    loadedFor.value = tenantId
    return members.value
  }
  async function loadInvitations(tenantId: string) {
    invitations.value = await fetcher.get<Invitation[]>(`${api(tenantId)}/invitations`)
  }
  async function invite(tenantId: string, email: string, role: MemberRole) {
    await fetcher.post(`${api(tenantId)}/invitations?sendMail=true`, { tenantId, email, role })
    await loadInvitations(tenantId)
  }
  async function revokeInvitation(tenantId: string, id: string) {
    await fetcher.delete(`${api(tenantId)}/invitations/${id}`)
    await loadInvitations(tenantId)
  }
  async function setRole(tenantId: string, userId: string, role: MemberRole) {
    await fetcher.put(`${api(tenantId)}/members/${userId}`, { role })
    await loadMembers(tenantId, true)
  }
  async function removeMember(tenantId: string, userId: string) {
    await fetcher.delete(`${api(tenantId)}/members/${userId}`)
    await loadMembers(tenantId, true)
  }
  async function renameTenant(tenantId: string, name: string) {
    await fetcher.put(`${api(tenantId)}`, { name })
  }
  return { members, invitations, loadMembers, loadInvitations, invite, revokeInvitation, setRole, removeMember, renameTenant }
})
