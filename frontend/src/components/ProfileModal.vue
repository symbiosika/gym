<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApp } from '@/stores/app'
import { useProfile, type ApiToken, type MyInvitation, type Passkey } from '@/stores/profile'
import { useUi } from '@/stores/ui'
import { useDialog } from '@/stores/dialog'
import Modal from './Modal.vue'
import IconAdd from '~icons/carbon/add'
import IconArrowRight from '~icons/carbon/arrow-right'
import IconClose from '~icons/carbon/close'

const visible = defineModel<boolean>('visible', { required: true })
const { t } = useI18n()
const app = useApp()
const profile = useProfile()
const ui = useUi()
const dialog = useDialog()
const lang = computed(() => ui.lang)

const firstname = ref('')
const surname = ref('')
const newEmail = ref('')
const passkeyName = ref('')
const tokenName = ref('')
const tokenScopes = ref<string[]>([])
const tokenDays = ref<'30' | '90' | '365' | 'never'>('90')
const freshToken = ref('')
const busy = ref(false)
/** the account fields are saved from the footer, not from a button next to the field */
const nameDirty = computed(
  () => firstname.value.trim() !== (app.user?.firstname ?? '') || surname.value.trim() !== (app.user?.surname ?? ''),
)
const err = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

/** every scope the server offers, grouped by its area so the list stays readable */
const scopeGroups = computed(() => {
  const groups = new Map<string, string[]>()
  for (const s of [...profile.scopes].sort()) {
    const area = s.includes(':') ? s.slice(0, s.indexOf(':')) : s
    groups.set(area, [...(groups.get(area) ?? []), s])
  }
  return [...groups.entries()].map(([area, scopes]) => ({
    label: area,
    items: scopes.map((s) => ({ label: s, value: s })),
  }))
})
const expiryOptions = computed(() => [
  { label: t('profile.tokenDays', { n: 30 }), value: '30' },
  { label: t('profile.tokenDays', { n: 90 }), value: '90' },
  { label: t('profile.tokenDays', { n: 365 }), value: '365' },
  { label: t('profile.tokenNever'), value: 'never' },
])

watch(visible, async (v) => {
  if (!v) return
  firstname.value = app.user?.firstname ?? ''
  surname.value = app.user?.surname ?? ''
  freshToken.value = ''
  try {
    await Promise.all([profile.loadEmailChange(), profile.loadPasskeys(), profile.loadTokens(), profile.loadMyInvitations()])
    if (!tokenScopes.value.length) tokenScopes.value = profile.scopes.filter((s) => /^(user:read|tenants:read)$/.test(s))
  } catch (e) {
    err(e)
  }
})

async function saveName() {
  try {
    await profile.updateName({
      firstname: firstname.value.trim(),
      surname: surname.value.trim(),
    })
    await app.refreshUser()
    ui.showBanner('ok', t('profile.nameSaved'), 3000)
  } catch (e) {
    err(e)
  }
}
async function requestEmail() {
  if (!newEmail.value.includes('@')) return
  try {
    await profile.requestEmailChange(newEmail.value.trim())
    ui.showBanner('ok', t('profile.changeRequested', { email: newEmail.value.trim() }), 6000)
    newEmail.value = ''
  } catch (e) {
    err(e)
  }
}
async function addPasskey() {
  busy.value = true
  try {
    await profile.registerPasskey(passkeyName.value)
    passkeyName.value = ''
    ui.showBanner('ok', t('profile.passkeyAdded'), 3000)
  } catch (e) {
    err(e)
  } finally {
    busy.value = false
  }
}
async function removePasskey(p: Passkey) {
  if (
    !(await dialog.confirm({
      title: t('app.delete'),
      text: p.nickname ?? p.id,
      ok: t('app.delete'),
      danger: true,
    }))
  )
    return
  try {
    await profile.removePasskey(p.id)
  } catch (e) {
    err(e)
  }
}
async function createToken() {
  if (!tokenName.value.trim() || !tokenScopes.value.length) return
  busy.value = true
  try {
    freshToken.value = await profile.createToken({
      name: tokenName.value.trim(),
      scopes: tokenScopes.value,
      tenantId: app.selectedTenant,
      ...(tokenDays.value === 'never' ? {} : { expiresIn: Number(tokenDays.value) * 24 * 60 }),
    })
    tokenName.value = ''
  } catch (e) {
    err(e)
  } finally {
    busy.value = false
  }
}
async function revokeToken(tk: ApiToken) {
  if (
    !(await dialog.confirm({
      title: t('profile.revoke'),
      text: `${tk.name}: ${t('profile.revokeText')}`,
      ok: t('profile.revoke'),
      danger: true,
    }))
  )
    return
  try {
    await profile.revokeToken(tk.id)
  } catch (e) {
    err(e)
  }
}
async function accept(inv: MyInvitation) {
  try {
    await profile.acceptInvitation(inv)
    await Promise.all([profile.loadMyInvitations(), app.loadTenants()])
    ui.showBanner('ok', t('profile.joined', { name: inv.tenantName ?? '' }), 5000)
  } catch (e) {
    err(e)
  }
}
async function decline(inv: MyInvitation) {
  try {
    await profile.declineInvitation(inv)
    await profile.loadMyInvitations()
  } catch (e) {
    err(e)
  }
}
const fmt = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(lang.value === 'en' ? 'en-GB' : 'de-DE', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : t('profile.never')
const copyToken = async () => {
  try {
    await navigator.clipboard.writeText(freshToken.value)
    ui.showBanner('ok', t('profile.tokenCopied'), 2500)
  } catch {
    /* blocked */
  }
}
</script>

<template>
  <Modal
    v-model:visible="visible"
    :title="app.displayName"
    :n="t('profile.title')"
    :hint="app.displayName === app.user?.email ? '' : app.user?.email"
    size="lg"
  >
    <!-- 01 account -->
    <section>
      <SectionHeader n="01" :title="t('profile.account')" />
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField :label="t('profile.firstname')">
          <InputText v-model="firstname" type="text" fluid autocomplete="given-name" />
        </FormField>
        <FormField :label="t('profile.surname')">
          <InputText v-model="surname" type="text" fluid autocomplete="family-name" />
        </FormField>
      </div>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <FormField :label="t('profile.email')" :hint="t('profile.emailHint')">
          <InputText :value="app.user?.email" readonly fluid />
        </FormField>
        <FormField :label="t('profile.newEmail')" :hint="profile.emailChange.pending ? undefined : t('profile.requestChange')">
          <div v-if="profile.emailChange.pending" class="flex flex-wrap items-center gap-2">
            <Pill tone="warn">{{
              t('profile.pending', {
                email: profile.emailChange.newEmail,
                until: fmt(profile.emailChange.expiresAt),
              })
            }}</Pill>
            <SecondaryButton size="small" :label="t('profile.cancelChange')" @click="profile.cancelEmailChange()" />
          </div>
          <div v-else class="flex items-center gap-1.5">
            <InputText v-model="newEmail" type="email" class="grow" autocomplete="off" @keydown.enter="requestEmail" />
            <Button
              size="small"
              :disabled="!newEmail.includes('@')"
              :title="t('profile.requestChange')"
              :aria-label="t('profile.requestChange')"
              @click="requestEmail"
            >
              <template #icon><IconArrowRight /></template>
            </Button>
          </div>
        </FormField>
      </div>
    </section>

    <!-- 02 invitations to me -->
    <section v-if="profile.myInvitations.length" class="mt-6">
      <SectionHeader n="02" :title="t('profile.invitations')" />
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <tbody>
            <tr v-for="inv in profile.myInvitations" :key="inv.id">
              <td>{{ inv.tenantName ?? inv.tenantId }}</td>
              <td>{{ t(`org.roles.${inv.role}`) }}</td>
              <td>
                <div class="flex justify-end gap-1.5">
                  <Button size="small" :label="t('profile.accept')" @click="accept(inv)" />
                  <SecondaryButton size="small" :label="t('profile.decline')" @click="decline(inv)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 03 passkeys -->
    <section class="mt-6">
      <SectionHeader n="03" :title="t('profile.passkeys')" :hint="t('profile.passkeysHint')" />
      <p v-if="!profile.passkeysEnabled" class="gym-empty">{{ t('profile.passkeysOff') }} {{ t('profile.passkeyHint') }}</p>
      <p v-else-if="!profile.passkeysSupported" class="gym-empty">
        {{ t('profile.passkeysUnsupported') }}
      </p>
      <template v-else>
        <div v-if="profile.passkeys.length" class="gym-panel overflow-x-auto">
          <table class="gym-table">
            <tbody>
              <tr v-for="p in profile.passkeys" :key="p.id">
                <td>{{ p.nickname || p.id.slice(0, 12) }}</td>
                <td class="font-mono text-xs whitespace-nowrap">{{ t('org.created') }} {{ fmt(p.createdAt) }}</td>
                <td class="font-mono text-xs whitespace-nowrap">{{ t('profile.lastUsed') }} {{ fmt(p.lastUsedAt) }}</td>
                <td>
                  <div class="flex justify-end">
                    <SecondaryButton variant="text" rounded :title="t('app.delete')" @click="removePasskey(p)">
                      <template #icon><IconClose /></template>
                    </SecondaryButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="gym-empty">{{ t('profile.passkeysNone') }}</div>
        <div class="mt-2.5 flex items-center gap-1.5">
          <InputText
            v-model="passkeyName"
            type="text"
            class="grow"
            :placeholder="t('profile.passkeyName')"
            @keydown.enter.prevent="addPasskey"
          />
          <SecondaryButton
            :disabled="busy"
            :title="t('profile.addPasskey')"
            :aria-label="t('profile.addPasskey')"
            @click="addPasskey"
          >
            <template #icon><IconAdd /></template>
          </SecondaryButton>
        </div>
      </template>
    </section>

    <!-- 04 API tokens -->
    <section class="mt-6">
      <SectionHeader n="04" :title="t('profile.tokens')" :hint="t('profile.tokensHint')" />
      <div v-if="freshToken" class="gym-note mb-3.5">
        <b class="text-surface-900 dark:text-surface-0">{{ t('profile.tokenCreated') }}</b>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <code class="font-mono text-xs break-all">{{ freshToken }}</code>
          <button type="button" class="text-primary cursor-pointer text-sm hover:underline" @click="copyToken">
            {{ t('profile.tokenCopy') }}
          </button>
        </div>
      </div>

      <div v-if="profile.tokens.length" class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('profile.tokenName') }}</th>
              <th>{{ t('profile.tokenScopes') }}</th>
              <th>{{ t('profile.expires') }}</th>
              <th>{{ t('profile.lastUsed') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tk in profile.tokens" :key="tk.id">
              <td>{{ tk.name }}</td>
              <td class="min-w-40 font-mono text-[0.7rem]">
                {{ tk.scopes.join(', ') }}
              </td>
              <td class="font-mono text-xs whitespace-nowrap">
                {{ tk.expiresAt ? fmt(tk.expiresAt) : t('profile.tokenNever') }}
              </td>
              <td class="font-mono text-xs whitespace-nowrap">
                {{ fmt(tk.lastUsed) }}
              </td>
              <td>
                <button type="button" class="text-bad cursor-pointer text-sm hover:underline" @click="revokeToken(tk)">
                  {{ t('profile.revoke') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="gym-empty">{{ t('profile.tokensNone') }}</div>

      <div class="mt-3 grid gap-4 sm:grid-cols-2">
        <FormField :label="t('profile.tokenName')">
          <InputText v-model="tokenName" type="text" fluid placeholder="z. B. import-zelle-13" />
        </FormField>
        <FormField :label="t('profile.tokenExpires')">
          <Select v-model="tokenDays" fluid :options="expiryOptions" option-label="label" option-value="value" />
        </FormField>
        <FormField
          class="sm:col-span-2"
          :label="`${t('profile.tokenScopes')} · ${t('profile.tokenScopesN', { n: tokenScopes.length })}`"
          :hint="t('profile.tokenScopesHint')"
        >
          <MultiSelect
            v-model="tokenScopes"
            fluid
            filter
            display="chip"
            :max-selected-labels="6"
            :options="scopeGroups"
            option-group-label="label"
            option-group-children="items"
            option-label="label"
            option-value="value"
            :placeholder="t('profile.tokenScopes')"
          />
        </FormField>
      </div>
      <div class="mt-3 flex">
        <span class="grow"></span>
        <SecondaryButton
          :disabled="!tokenName.trim() || !tokenScopes.length || busy"
          :label="t('profile.newToken')"
          @click="createToken"
        >
          <template #icon><IconAdd /></template>
        </SecondaryButton>
      </div>
    </section>

    <template #footer>
      <SecondaryButton :label="t('app.close')" @click="visible = false" />
      <span class="grow"></span>
      <span v-if="nameDirty" class="text-warn font-mono text-xs">▲ {{ t('app.status.dirty') }}</span>
      <Button :disabled="!nameDirty" :label="t('profile.saveAccount')" @click="saveName" />
    </template>
  </Modal>
</template>
