import { defineStore } from 'pinia'
import { ref } from 'vue'
import { startRegistration, browserSupportsWebAuthn, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { fetcher, FetcherError } from '@/utils/fetcher'
import type { MemberRole } from './org'

export interface PendingEmailChange {
  pending: boolean
  newEmail?: string
  expiresAt?: string
}
export interface Passkey {
  id: string
  nickname?: string | null
  createdAt: string
  lastUsedAt?: string | null
}
export interface ApiToken {
  id: string
  name: string
  scopes: string[]
  lastUsed?: string | null
  expiresAt?: string | null
  createdAt: string
  tenantId: string
}
export interface MyInvitation {
  id: string
  tenantId: string
  tenantName?: string
  email: string
  role: MemberRole
  status: string
}

/** The signed-in user's own account: name, e-mail change, passkeys, API tokens, pending invitations. */
export const useProfile = defineStore('profile', () => {
  const emailChange = ref<PendingEmailChange>({ pending: false })
  const passkeys = ref<Passkey[]>([])
  const passkeysEnabled = ref(false)
  const passkeysSupported = browserSupportsWebAuthn()
  const tokens = ref<ApiToken[]>([])
  const scopes = ref<string[]>([])
  const myInvitations = ref<MyInvitation[]>([])

  const updateName = (data: { firstname?: string; surname?: string }) => fetcher.put('/api/v1/user/me', data)

  async function loadEmailChange() {
    emailChange.value = await fetcher.get<PendingEmailChange>('/api/v1/user/me/email-change')
  }
  async function requestEmailChange(newEmail: string) {
    await fetcher.post('/api/v1/user/me/email-change', { newEmail })
    await loadEmailChange()
  }
  async function cancelEmailChange() {
    await fetcher.delete('/api/v1/user/me/email-change')
    await loadEmailChange()
  }

  async function loadPasskeys() {
    try {
      const res = await fetcher.get<{ passkeys: Passkey[] }>('/api/v1/user/passkeys')
      passkeys.value = res.passkeys
      passkeysEnabled.value = true
    } catch (e) {
      // 404: passkeys are not configured on this server (no WEBAUTHN rp id)
      passkeysEnabled.value = false
      passkeys.value = []
      if (!(e instanceof FetcherError && e.status === 404)) throw e
    }
  }
  async function registerPasskey(nickname: string) {
    const { options, challengeToken } = await fetcher.post<{
      options: PublicKeyCredentialCreationOptionsJSON
      challengeToken: string
    }>('/api/v1/user/passkey/registration/options', {})
    const credential = await startRegistration({ optionsJSON: options })
    await fetcher.post('/api/v1/user/passkey/registration/verify', {
      challengeToken,
      credential,
      nickname: nickname.trim() || undefined,
    })
    await loadPasskeys()
  }
  async function removePasskey(id: string) {
    await fetcher.delete(`/api/v1/user/passkeys/${encodeURIComponent(id)}`)
    await loadPasskeys()
  }

  async function loadTokens() {
    tokens.value = await fetcher.get<ApiToken[]>('/api/v1/user/api-tokens')
    if (!scopes.value.length)
      scopes.value = (await fetcher.get<{ all: string[] }>('/api/v1/user/api-tokens/available-scopes')).all
  }
  async function createToken(input: { name: string; scopes: string[]; tenantId: string; expiresIn?: number }) {
    const res = await fetcher.post<{ token: string }>('/api/v1/user/api-tokens', input)
    await loadTokens()
    return res.token
  }
  async function revokeToken(id: string) {
    await fetcher.delete(`/api/v1/user/api-tokens/${encodeURIComponent(id)}`)
    await loadTokens()
  }

  async function loadMyInvitations() {
    myInvitations.value = (await fetcher.get<MyInvitation[]>('/api/v1/user/tenants/invitations')).filter(
      (i) => i.status === 'pending',
    )
  }
  const acceptInvitation = (inv: MyInvitation) => fetcher.post(`/api/v1/tenant/${inv.tenantId}/invitations/${inv.id}/accept`, {})
  const declineInvitation = (inv: MyInvitation) =>
    fetcher.post(`/api/v1/tenant/${inv.tenantId}/invitations/${inv.id}/decline`, {})

  return {
    emailChange,
    passkeys,
    passkeysEnabled,
    passkeysSupported,
    tokens,
    scopes,
    myInvitations,
    updateName,
    loadEmailChange,
    requestEmailChange,
    cancelEmailChange,
    loadPasskeys,
    registerPasskey,
    removePasskey,
    loadTokens,
    createToken,
    revokeToken,
    loadMyInvitations,
    acceptInvitation,
    declineInvitation,
  }
})
