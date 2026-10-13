<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useApp } from '@/stores/app'
import { useDialog } from '@/stores/dialog'
import { useGym } from '@/stores/gym'
import { useOrg, type MemberRole } from '@/stores/org'
import { useUi } from '@/stores/ui'
import type { Cell, Collection, CriticsSpecInfo } from '@/types/gym'
import SectionHeader from '@/components/SectionHeader.vue'
import SpecManager from '@/components/SpecManager.vue'
import IconAdd from '~icons/carbon/add'
import IconClose from '~icons/carbon/close'
import IconSettings from '~icons/carbon/settings-adjust'

/** Cells, collections, the organisation's members and the AI status. */
const route = useRoute()
const { t } = useI18n()
const app = useApp()
const gym = useGym()
const org = useOrg()
const ui = useUi()
const dialog = useDialog()
const tenantId = computed(() => String(route.params.tenantId))
const fail = (e: unknown) => ui.showBanner('err', e instanceof Error ? e.message : String(e))

/** the specs with the skills that use them; the store's list has no usage */
const specs = ref<CriticsSpecInfo[]>([])
const specsOpen = ref(false)
async function loadSpecs() {
  specs.value = await gymApi.specs(tenantId.value).catch(() => [])
}

const newCell = ref({ name: '', location: '', robot: '' })
const newCollection = ref({ name: '', customer: '' })
const inviteEmail = ref('')
const inviteRole = ref<MemberRole>('member')

const roleOptions = computed(() =>
  (['owner', 'admin', 'member'] as const).map((r) => ({
    label: t(`settings.roles.${r}`),
    value: r,
  })),
)
const inviteRoleOptions = computed(() => roleOptions.value.filter((r) => r.value !== 'owner'))
const collectionStatusOptions = computed(() => [
  { label: t('settings.collection.active'), value: 'active' },
  { label: t('settings.collection.archived'), value: 'archived' },
])

onMounted(async () => {
  if (app.isAdmin) {
    await org.loadMembers(tenantId.value, true).catch(fail)
    await org.loadInvitations(tenantId.value).catch(fail)
  }
  await loadSpecs()
})

async function addCell() {
  if (!newCell.value.name.trim()) return
  try {
    await gymApi.createCell(tenantId.value, newCell.value)
    newCell.value = { name: '', location: '', robot: '' }
    await gym.load(tenantId.value, true)
  } catch (e) {
    fail(e)
  }
}
async function saveCell(c: Cell) {
  try {
    await gymApi.updateCell(tenantId.value, c.id, {
      name: c.name,
      location: c.location,
      robot: c.robot,
      active: c.active,
    })
    ui.showBanner('ok', t('app.saved'), 1500)
  } catch (e) {
    fail(e)
  }
}
async function removeCell(c: Cell) {
  if (
    !(await dialog.confirm({
      title: t('settings.deleteCell', { name: c.name }),
      text: t('settings.deleteCellHint'),
      danger: true,
    }))
  )
    return
  try {
    await gymApi.deleteCell(tenantId.value, c.id)
    await gym.load(tenantId.value, true)
  } catch (e) {
    fail(e)
  }
}
async function addCollection() {
  if (!newCollection.value.name.trim()) return
  try {
    await gymApi.createCollection(tenantId.value, newCollection.value)
    newCollection.value = { name: '', customer: '' }
    await gym.load(tenantId.value, true)
  } catch (e) {
    fail(e)
  }
}
async function saveCollection(c: Collection) {
  try {
    await gymApi.updateCollection(tenantId.value, c.id, {
      name: c.name,
      customer: c.customer,
      description: c.description,
      status: c.status,
    })
    ui.showBanner('ok', t('app.saved'), 1500)
  } catch (e) {
    fail(e)
  }
}
async function removeCollection(c: Collection) {
  if (
    !(await dialog.confirm({
      title: t('settings.deleteCollection', { name: c.name }),
      text: t('settings.deleteCollectionHint'),
      danger: true,
    }))
  )
    return
  try {
    await gymApi.deleteCollection(tenantId.value, c.id)
    await gym.load(tenantId.value, true)
  } catch (e) {
    fail(e)
  }
}
async function invite() {
  if (!inviteEmail.value.trim()) return
  try {
    await org.invite(tenantId.value, inviteEmail.value.trim(), inviteRole.value)
    inviteEmail.value = ''
    ui.showBanner('ok', t('settings.invited'), 2500)
  } catch (e) {
    fail(e)
  }
}

const rowGrid = 'grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_2.25rem] items-center gap-2'
const rowBox = 'rounded-panel border border-surface-300 bg-surface-0 px-2.5 py-2 dark:border-surface-800 dark:bg-surface-900'
</script>

<template>
  <div class="gym-wrap">
    <PageTitle :title="t('settings.title')" />

    <section class="mt-6">
      <SectionHeader n="01" :title="t('settings.cells')" :hint="t('settings.cellsHint')" />
      <div v-if="!gym.cells.length" class="gym-empty">
        {{ t('settings.noCells') }}
      </div>
      <div v-else class="flex flex-col gap-1.5">
        <div :class="[rowGrid, 'px-2.5']">
          <span></span>
          <span class="gym-field mb-0">{{ t('settings.cell.name') }}</span>
          <span class="gym-field mb-0">{{ t('settings.cell.location') }}</span>
          <span class="gym-field mb-0">{{ t('settings.cell.robot') }}</span>
          <span></span>
        </div>
        <div v-for="(c, i) in gym.cells" :key="c.id" :class="[rowGrid, rowBox]">
          <span class="font-mono text-xs text-surface-400">{{ i + 1 }}</span>
          <InputText v-model="c.name" fluid :disabled="!app.isAdmin" @change="saveCell(c)" />
          <InputText v-model="c.location" fluid :disabled="!app.isAdmin" @change="saveCell(c)" />
          <div class="flex items-center gap-2">
            <InputText v-model="c.robot" class="grow" :disabled="!app.isAdmin" @change="saveCell(c)" />
            <Checkbox
              v-model="c.active"
              binary
              :disabled="!app.isAdmin"
              :title="t('settings.cell.active')"
              @change="saveCell(c)"
            />
          </div>
          <SecondaryButton v-if="app.isAdmin" variant="text" rounded :title="t('app.delete')" @click="removeCell(c)">
            <template #icon><IconClose /></template>
          </SecondaryButton>
        </div>
      </div>
      <div v-if="app.isAdmin" :class="[rowGrid, rowBox, 'mt-2 border-dashed']">
        <span class="font-mono text-xs text-surface-400">+</span>
        <InputText v-model="newCell.name" fluid :placeholder="t('settings.cell.namePlaceholder')" @keyup.enter="addCell" />
        <InputText v-model="newCell.location" fluid :placeholder="t('settings.cell.location')" @keyup.enter="addCell" />
        <InputText v-model="newCell.robot" fluid :placeholder="t('settings.cell.robot')" @keyup.enter="addCell" />
        <Button :disabled="!newCell.name.trim()" :aria-label="t('settings.cell.namePlaceholder')" @click="addCell">
          <template #icon><IconAdd /></template>
        </Button>
      </div>
    </section>

    <section class="mt-8">
      <SectionHeader n="02" :title="t('settings.collections')" :hint="t('settings.collectionsHint')" />
      <div v-if="!gym.collections.length" class="gym-empty">
        {{ t('settings.noCollections') }}
      </div>
      <div v-else class="flex flex-col gap-1.5">
        <div v-for="(c, i) in gym.collections" :key="c.id" :class="[rowGrid, rowBox]">
          <span class="font-mono text-xs text-surface-400">{{ i + 1 }}</span>
          <InputText v-model="c.name" fluid @change="saveCollection(c)" />
          <InputText v-model="c.customer" fluid :placeholder="t('settings.collection.customer')" @change="saveCollection(c)" />
          <div class="flex items-center gap-2">
            <Select
              v-model="c.status"
              class="grow"
              :options="collectionStatusOptions"
              option-label="label"
              option-value="value"
              @change="saveCollection(c)"
            />
            <span class="text-xs whitespace-nowrap text-surface-500 dark:text-surface-400"
              >{{ c.skillCount }} {{ t('analysis.skills') }}</span
            >
          </div>
          <SecondaryButton v-if="app.isAdmin" variant="text" rounded :title="t('app.delete')" @click="removeCollection(c)">
            <template #icon><IconClose /></template>
          </SecondaryButton>
        </div>
      </div>
      <div :class="[rowGrid, rowBox, 'mt-2 border-dashed']">
        <span class="font-mono text-xs text-surface-400">+</span>
        <InputText
          v-model="newCollection.name"
          fluid
          :placeholder="t('settings.collection.namePlaceholder')"
          @keyup.enter="addCollection"
        />
        <InputText
          v-model="newCollection.customer"
          fluid
          :placeholder="t('settings.collection.customer')"
          @keyup.enter="addCollection"
        />
        <span></span>
        <Button
          :disabled="!newCollection.name.trim()"
          :aria-label="t('settings.collection.namePlaceholder')"
          @click="addCollection"
        >
          <template #icon><IconAdd /></template>
        </Button>
      </div>
    </section>

    <section v-if="app.isAdmin" class="mt-8">
      <SectionHeader n="03" :title="t('settings.org')" :hint="app.currentTenant?.name" />
      <div class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('settings.email') }}</th>
              <th>{{ t('settings.role') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in org.members" :key="m.id">
              <td>{{ m.userEmail }}</td>
              <td>
                <Select
                  :model-value="m.role"
                  :disabled="m.role === 'owner'"
                  :options="roleOptions"
                  option-label="label"
                  option-value="value"
                  @update:model-value="org.setRole(tenantId, m.id, $event as MemberRole).catch(fail)"
                />
              </td>
              <td>
                <SecondaryButton
                  v-if="m.role !== 'owner'"
                  variant="text"
                  rounded
                  :title="t('app.delete')"
                  @click="org.removeMember(tenantId, m.id).catch(fail)"
                >
                  <template #icon><IconClose /></template>
                </SecondaryButton>
              </td>
            </tr>
            <tr v-for="inv in org.invitations.filter((i) => i.status === 'pending')" :key="inv.id">
              <td>
                {{ inv.email }}
                <Pill tone="warn">{{ t('settings.pending') }}</Pill>
              </td>
              <td>{{ t(`settings.roles.${inv.role}`) }}</td>
              <td>
                <SecondaryButton
                  variant="text"
                  rounded
                  :title="t('app.delete')"
                  @click="org.revokeInvitation(tenantId, inv.id).catch(fail)"
                >
                  <template #icon><IconClose /></template>
                </SecondaryButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <InputText
          v-model="inviteEmail"
          type="email"
          class="min-w-56 grow"
          :placeholder="t('settings.invitePlaceholder')"
          @keyup.enter="invite"
        />
        <Select v-model="inviteRole" class="w-36" :options="inviteRoleOptions" option-label="label" option-value="value" />
        <Button :disabled="!inviteEmail.trim()" :label="t('settings.invite')" @click="invite" />
      </div>
      <p class="mt-2 text-xs text-surface-500 dark:text-surface-400">
        {{ t('settings.rolesHint') }}
      </p>
    </section>

    <section class="mt-8">
      <SectionHeader n="04" :title="t('settings.critics')" :hint="gym.critics.url ?? ''" />
      <div class="gym-note" :class="gym.critics.reachable ? '' : 'border-s-warn'">
        <b class="text-surface-900 dark:text-surface-0">{{
          gym.critics.reachable
            ? t('settings.criticsOn', {
                version: gym.critics.health?.version ?? '',
              })
            : t('settings.criticsUnreachable')
        }}</b>
        <div v-if="gym.critics.error" class="mt-0.5 font-mono text-xs">
          {{ gym.critics.error }}
        </div>
        <div class="mt-1">{{ t('settings.criticsHint') }}</div>
        <div v-if="gym.critics.health" class="mt-1 text-xs">
          VLM:
          {{
            gym.critics.health.gemini_key
              ? 'Gemini'
              : gym.critics.health.openrouter_key
                ? 'OpenRouter'
                : t('settings.criticsNoVlm')
          }}
        </div>
      </div>
    </section>

    <section class="mt-8">
      <SectionHeader n="05" :title="t('settings.specs')" :hint="t('settings.specsHint')">
        <SecondaryButton size="small" :label="t('settings.manageSpecs')" @click="specsOpen = true">
          <template #icon><IconSettings class="size-4" /></template>
        </SecondaryButton>
      </SectionHeader>
      <div v-if="specs.length" class="gym-panel overflow-x-auto">
        <table class="gym-table">
          <thead>
            <tr>
              <th>{{ t('settings.specName') }}</th>
              <th>{{ t('settings.specTask') }}</th>
              <th>{{ t('settings.specRobot') }}</th>
              <th>{{ t('settings.specUsedBy') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sp in specs" :key="sp.name" class="cursor-pointer hover:bg-primary/5" @click="specsOpen = true">
              <td class="font-mono text-xs">{{ sp.name }}</td>
              <td>{{ sp.task ?? '–' }}</td>
              <td>{{ sp.robot ?? '–' }}</td>
              <td>{{ sp.usedBy?.length ? sp.usedBy.join(', ') : '–' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="gym-empty">{{ t('settings.noSpecs') }}</div>
      <SpecManager v-model:visible="specsOpen" :tenant-id="tenantId" @picked="loadSpecs" />
    </section>

    <section class="mt-8">
      <SectionHeader n="06" :title="t('settings.ai')" />
      <div class="gym-note" :class="gym.ai.enabled ? '' : 'border-s-warn'">
        <b class="text-surface-900 dark:text-surface-0">{{
          gym.ai.enabled ? t('settings.aiOn', { provider: gym.ai.provider }) : t('settings.aiOff')
        }}</b>
        <div class="mt-1">{{ t('settings.aiHint') }}</div>
        <div class="mt-1">
          {{ gym.ai.imageEnabled ? t('settings.aiImagesOn', { model: gym.ai.imageModel }) : t('settings.aiImagesOff') }}
        </div>
      </div>
    </section>
  </div>
</template>
