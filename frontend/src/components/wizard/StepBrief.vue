<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { gymApi } from '@/api/gym'
import { useGym } from '@/stores/gym'
import { useDialog } from '@/stores/dialog'
import type { AccessTokenInfo, BlockKind, BlockView, Lang, PolicyRecord, SkillListItem } from '@/types/gym'
import { fmtDate } from '@/utils/time'
import QrCode from '@/components/QrCode.vue'
import IconCamera from '~icons/carbon/camera'
import { NONE } from '@/utils/select'
import Modal from '@/components/Modal.vue'
import IconEdit from '~icons/carbon/edit'

/**
 * Step 1, the scene brief: how many episodes are the goal, then photo and text
 * from the phone (QR code) or typed here, and the import of another skill's
 * inputs. What the block is (recording or evaluation, and the policy under
 * test) was said when it was started; it is shown here in one line and changed
 * in a dialog, not asked a second time. Ends with the AI proposing the plan,
 * or with a start without one.
 */
const props = defineProps<{ block: BlockView; tenantId: string }>()
const emit = defineEmits<{
  update: [block: BlockView]
  error: [message: string]
}>()
const { t, locale } = useI18n()
const gym = useGym()
const dialog = useDialog()

const token = ref<AccessTokenInfo | null>(null)
const captureUrl = computed(() => (token.value ? `${window.location.origin}${token.value.paths.capture}` : ''))
const sceneText = ref(props.block.sceneText)
const target = ref<number | null>(props.block.targetEpisodes)
const busy = ref('')
const isEvaluation = computed(() => props.block.kind === 'evaluation')
/** the kind can still change while the block has neither a plan nor a dataset */
const kindLocked = computed(() => !!props.block.plan || props.block.datasets.length > 0)
const policies = ref<PolicyRecord[]>([])
const policyOptions = computed(() => [
  { label: t('start.noPolicy'), value: NONE },
  ...policies.value.map((p) => ({ label: p.name, value: p.id })),
])
const imageVersion = ref(props.block.updatedAt)
const fileInput = ref<HTMLInputElement | null>(null)
const settingsOpen = ref(false)

/** the task the block is recorded against: today's scene text, else the skill's task */
const taskText = computed(() => sceneText.value.trim() || props.block.skill.taskDescription.trim())

// the phone may have changed text or photo: follow the server while the operator is not typing
const dirty = ref(false)
watch(
  () => props.block,
  (d) => {
    imageVersion.value = d.updatedAt
    if (!dirty.value) {
      sceneText.value = d.sceneText
      target.value = d.targetEpisodes
    }
  },
)

onMounted(async () => {
  try {
    token.value = await gymApi.accessToken(props.tenantId, props.block.id)
    policies.value = await gymApi.policies(props.tenantId, props.block.skillId)
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e))
  }
})

async function setKind(kind: BlockKind) {
  if (kind === props.block.kind || kindLocked.value) return
  try {
    emit('update', await gymApi.updateBrief(props.tenantId, props.block.id, { kind }))
  } catch (e) {
    fail(e)
  }
}
async function setPolicy(policyId: string) {
  try {
    const value = policyId === NONE ? null : policyId
    emit('update', await gymApi.updateBrief(props.tenantId, props.block.id, { policyId: value }))
  } catch (e) {
    fail(e)
  }
}

const fail = (e: unknown) => emit('error', e instanceof Error ? e.message : String(e))

/** Typical numbers as one-click choices; any other number is typed. */
const targetChoices = computed(() => (isEvaluation.value ? [10, 20, 50] : [50, 100, 200]))
function pickTarget(n: number) {
  target.value = n
  dirty.value = true
  saveBrief()
}

/** What keeps the primary action grey, said next to it; else what the way without a plan means. */
const navHint = computed(() =>
  props.block.plan ? t('brief.hasPlan') : !target.value ? t('brief.needsTarget') : !gym.ai.enabled ? t('brief.aiOff') : '',
)

async function saveBrief(): Promise<BlockView | null> {
  try {
    const next = await gymApi.updateBrief(props.tenantId, props.block.id, {
      sceneText: sceneText.value,
      targetEpisodes: target.value,
    })
    dirty.value = false
    emit('update', next)
    return next
  } catch (e) {
    fail(e)
    return null
  }
}

async function uploadImage(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = 'image'
  try {
    emit('update', await gymApi.uploadSceneImage(props.tenantId, props.block.id, file))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
    if (fileInput.value) fileInput.value.value = ''
  }
}
async function removeImage() {
  try {
    emit('update', await gymApi.removeSceneImage(props.tenantId, props.block.id))
  } catch (e) {
    fail(e)
  }
}

async function createPlan() {
  if (!target.value) return
  busy.value = 'plan'
  const saved = await saveBrief()
  if (!saved) {
    busy.value = ''
    return
  }
  try {
    emit('update', await gymApi.generatePlan(props.tenantId, props.block.id, locale.value as Lang))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/**
 * Start without a plan: the block runs on the target number of episodes for
 * the task as it stands, with no scene setups and no variations. The task has
 * to be there, so the recording view has something to show.
 */
async function startWithoutPlan() {
  if (!target.value || !taskText.value) return
  busy.value = 'start'
  const saved = await saveBrief()
  if (!saved) {
    busy.value = ''
    return
  }
  try {
    emit('update', await gymApi.startRecording(props.tenantId, props.block.id, true))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/** Proposing again replaces the plan the block carries, edits included: asked first. */
async function regenerate() {
  const ok = await dialog.confirm({
    title: t('plan.regenerateConfirm'),
    text: t('plan.regenerateText'),
    ok: t('plan.regenerate'),
  })
  if (ok) await createPlan()
}

/** The block already carries a plan (imported or proposed earlier): go to it. */
async function toPlan() {
  busy.value = 'toplan'
  if (dirty.value) await saveBrief()
  try {
    emit('update', await gymApi.setStep(props.tenantId, props.block.id, 'plan'))
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

// import from another skill
const importOpen = ref(false)
const importList = ref<SkillListItem[]>([])
async function openImport() {
  importOpen.value = true
  try {
    importList.value = (await gymApi.skills(props.tenantId, { limit: 200 })).filter(
      (s) => s.id !== props.block.skillId && (isEvaluation.value ? s.evaluationBlocks : s.recordingBlocks) > 0,
    )
  } catch (e) {
    fail(e)
  }
}
async function doImport(s: SkillListItem) {
  try {
    const next = await gymApi.importFromSkill(props.tenantId, props.block.id, s.id)
    dirty.value = false
    importOpen.value = false
    emit('update', next)
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="gym-stepbox">
    <h2 class="font-display text-xl font-semibold tracking-tight">
      {{ t('brief.title') }}
    </h2>
    <p class="mt-1 text-surface-600 dark:text-surface-300">
      {{ isEvaluation ? t('brief.leadEvaluation') : t('brief.lead') }}
    </p>
    <!-- what the block is was said when it was started: shown in one line, changed in the dialog -->
    <div class="mt-2 mb-5 flex flex-wrap items-center gap-2 text-sm">
      <Pill :tone="isEvaluation ? 'warn' : 'accent'">{{ t(`block.kind.${block.kind}`) }}</Pill>
      <span v-if="isEvaluation" class="text-surface-600 dark:text-surface-300">
        {{ t('block.policy') }}: <b class="font-medium">{{ block.policy?.name ?? t('start.noPolicy') }}</b>
      </span>
      <button
        type="button"
        class="text-primary inline-flex cursor-pointer items-center gap-1 text-sm hover:underline"
        @click="settingsOpen = true"
      >
        <IconEdit class="size-3.5" />{{ t('brief.changeKind') }}
      </button>
    </div>

    <section>
      <SectionHeader n="01" :title="isEvaluation ? t('brief.targetRollouts') : t('brief.target')" />
      <div class="flex flex-wrap items-center gap-2">
        <NumberInput
          v-model="target"
          :min="1"
          class="w-36"
          :aria-label="isEvaluation ? t('brief.targetRollouts') : t('brief.target')"
          @input="dirty = true"
          @blur="dirty && saveBrief()"
        />
        <button
          v-for="n in targetChoices"
          :key="n"
          type="button"
          class="cursor-pointer rounded-full border px-3.5 py-2 text-sm tabular-nums transition-colors"
          :class="
            target === n
              ? 'border-primary bg-primary/10 text-primary font-medium'
              : 'border-surface-300 text-surface-600 hover:border-primary dark:border-surface-700 dark:text-surface-300'
          "
          @click="pickTarget(n)"
        >
          {{ n }}
        </button>
        <span class="text-xs text-surface-500 dark:text-surface-400">{{
          isEvaluation ? t('brief.targetRolloutsHint') : t('brief.targetHint')
        }}</span>
      </div>
    </section>

    <section class="mt-7">
      <SectionHeader n="02" :title="t('brief.scene')" :hint="t('brief.sceneHint')" />
      <div class="grid gap-5 md:grid-cols-2">
        <div class="flex flex-col gap-3">
          <span class="gym-field">{{ t('brief.photo') }}</span>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="uploadImage" />
          <img
            v-if="block.hasSceneImage"
            class="max-h-64 w-full rounded-panel border border-surface-300 object-cover dark:border-surface-800"
            :src="gymApi.sceneImageUrl(tenantId, block.id, imageVersion)"
            alt=""
          />
          <button
            v-else
            type="button"
            class="flex cursor-pointer flex-col items-center gap-1 rounded-panel border-2 border-dashed border-surface-300 bg-surface-50 px-4 py-7 text-sm text-surface-500 transition-colors hover:border-primary hover:text-primary dark:border-surface-700 dark:bg-surface-800/30"
            :disabled="busy === 'image'"
            @click="fileInput?.click()"
          >
            <IconCamera class="size-6" />
            {{ busy === 'image' ? t('app.loading') + ' …' : t('brief.noPhoto') }}
          </button>
          <div v-if="block.hasSceneImage" class="flex flex-wrap gap-2">
            <SecondaryButton
              size="small"
              :disabled="busy === 'image'"
              :label="t('brief.replacePhoto')"
              @click="fileInput?.click()"
            />
            <SecondaryButton size="small" class="text-bad!" :label="t('brief.removePhoto')" @click="removeImage" />
          </div>

          <!-- the phone is the quick way: photo and voice, picked up here live -->
          <div class="flex items-center gap-3 rounded-panel border border-surface-300 p-2.5 dark:border-surface-800">
            <a v-if="captureUrl" :href="captureUrl" target="_blank" rel="noopener" class="shrink-0" :title="captureUrl">
              <QrCode :url="captureUrl" :size="104" :caption="false" />
            </a>
            <div v-else class="size-[104px] shrink-0 animate-pulse rounded-md bg-surface-200 dark:bg-surface-800"></div>
            <div class="min-w-0 text-sm">
              <b class="block font-semibold">{{ t('brief.phone') }}</b>
              <span class="text-xs text-surface-500 dark:text-surface-400">{{ t('brief.scanHint') }}</span>
              <span
                class="mt-1.5 flex items-center gap-1.5 text-xs"
                :class="block.sceneCapturedAt ? 'text-ok' : 'text-surface-500'"
                role="status"
              >
                <i
                  class="size-2 rounded-full"
                  :class="block.sceneCapturedAt ? 'bg-ok' : 'animate-pulse bg-surface-400'"
                  aria-hidden="true"
                ></i>
                {{ block.sceneCapturedAt ? t('brief.received') : t('brief.waiting') }}
              </span>
            </div>
          </div>
        </div>

        <FormField :label="t('brief.text')" :hint="t('brief.textHint')" :required="!block.skill.taskDescription.trim()">
          <Textarea
            v-model="sceneText"
            rows="9"
            fluid
            :placeholder="block.skill.taskDescription.trim() || t('brief.textPlaceholder')"
            @input="dirty = true"
            @blur="dirty && saveBrief()"
          />
        </FormField>
      </div>
    </section>

    <div class="gym-stepnav">
      <SecondaryButton :label="t('brief.importFrom')" @click="openImport" />
      <span class="grow"></span>
      <span v-if="navHint" class="text-xs text-surface-500 dark:text-surface-400">{{ navHint }}</span>
      <!-- without a plan the block runs on the target alone; with one the way on is that plan -->
      <SecondaryButton
        v-if="!block.plan"
        :disabled="!target || !taskText || !!busy"
        :loading="busy === 'start'"
        :title="!taskText ? t('brief.noPlanNeedsTask') : t('brief.noPlanHint', { n: target ?? 0 })"
        :label="t('brief.startWithoutPlan')"
        @click="startWithoutPlan"
      />
      <SecondaryButton
        v-else
        :disabled="!target || !!busy"
        :loading="busy === 'plan'"
        :label="busy === 'plan' ? t('brief.creatingPlan') : t('plan.regenerate')"
        @click="regenerate"
      />
      <Button v-if="block.plan" :disabled="!!busy" :loading="busy === 'toplan'" :label="t('brief.toPlan')" @click="toPlan" />
      <Button
        v-else
        :disabled="!target || !!busy"
        :loading="busy === 'plan'"
        :label="busy === 'plan' ? t('brief.creatingPlan') : isEvaluation ? t('brief.createEvalPlan') : t('brief.createPlan')"
        @click="createPlan"
      />
    </div>
  </div>

  <Modal v-model:visible="settingsOpen" :title="t('brief.changeTitle')" :hint="t('brief.changeHint')" size="sm">
    <div class="flex flex-col gap-4">
      <FormField :label="t('block.kindLabel')" :hint="kindLocked ? t('brief.kindLocked') : t('brief.kindHint')">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="k in ['recording', 'evaluation'] as BlockKind[]"
            :key="k"
            type="button"
            class="cursor-pointer rounded-full border px-3.5 py-2 text-sm transition-colors disabled:cursor-default disabled:opacity-60"
            :class="
              block.kind === k
                ? 'border-primary bg-primary/10 text-primary font-medium'
                : 'border-surface-300 text-surface-600 hover:border-primary dark:border-surface-700 dark:text-surface-300'
            "
            :disabled="kindLocked && block.kind !== k"
            @click="setKind(k)"
          >
            {{ t(`block.kind.${k}`) }}
          </button>
        </div>
      </FormField>
      <FormField v-if="isEvaluation" :label="t('block.policy')" :hint="t('start.policyHint')">
        <Select
          :model-value="block.policyId ?? NONE"
          fluid
          :options="policyOptions"
          option-label="label"
          option-value="value"
          @update:model-value="setPolicy($event as string)"
        />
      </FormField>
    </div>
    <template #footer>
      <span class="grow"></span>
      <Button :label="t('app.close')" @click="settingsOpen = false" />
    </template>
  </Modal>

  <Modal v-model:visible="importOpen" :title="t('brief.importTitle')" :hint="t('brief.importHint')" size="lg">
    <div v-if="!importList.length" class="gym-empty">
      {{ t('brief.importEmpty') }}
    </div>
    <div v-else class="flex flex-col gap-1">
      <button
        v-for="s in importList"
        :key="s.id"
        type="button"
        class="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border border-transparent px-2.5 py-2 text-start text-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
        @click="doImport(s)"
      >
        <span class="font-mono text-xs text-surface-500">{{ fmtDate(s.lastDate, locale) }}</span>
        <span class="text-surface-500 dark:text-surface-400">{{ s.days }}d</span>
        <span class="min-w-0 grow truncate font-medium">{{ s.name }} · {{ s.taskDescription }}</span>
        <span class="font-mono text-xs tabular-nums text-surface-500">{{ s.episodes }}</span>
      </button>
    </div>
    <template #footer>
      <span class="grow"></span>
      <SecondaryButton :label="t('app.cancel')" @click="importOpen = false" />
    </template>
  </Modal>
</template>
