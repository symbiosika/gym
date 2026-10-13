<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { publicApi } from '@/api/gym'
import type { MobileState } from '@/types/gym'

/**
 * The phone at the cell: first the photo, then the description by voice or
 * typing, then "done". Simple on purpose: one thing at a time, big buttons.
 * Voice input uses the browser's speech recognition; the text is what counts.
 */
const route = useRoute()
const { t, locale } = useI18n()
const token = computed(() => String(route.params.token))

const state = ref<MobileState | null>(null)
const error = ref('')
const text = ref('')
const photoSkipped = ref(false)
const busy = ref('')
const done = ref(false)
const imageVersion = ref(String(Date.now()))
const cameraInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  try {
    state.value = await publicApi.mobile(token.value)
    text.value = state.value.sceneText
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

const photoDone = computed(() => !!state.value?.hasSceneImage || photoSkipped.value)

async function onPhoto(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = 'photo'
  try {
    state.value = await publicApi.uploadSceneImage(token.value, file)
    imageVersion.value = String(Date.now())
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
    if (cameraInput.value) cameraInput.value.value = ''
  }
}

// speech recognition (Web Speech API), where the browser has it
type Recognition = {
  start: () => void
  stop: () => void
  onresult:
    | ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void)
    | null
  onend: (() => void) | null
  onerror: (() => void) | null
  lang: string
  continuous: boolean
  interimResults: boolean
}
const SpeechCtor =
  (
    window as unknown as {
      SpeechRecognition?: new () => Recognition
      webkitSpeechRecognition?: new () => Recognition
    }
  ).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition
const speechSupported = !!SpeechCtor
const listening = ref(false)
let recognition: Recognition | null = null
let baseText = ''

function toggleSpeech() {
  if (listening.value) {
    recognition?.stop()
    return
  }
  if (!SpeechCtor) return
  recognition = new SpeechCtor()
  recognition.lang = locale.value === 'en' ? 'en-US' : 'de-DE'
  recognition.continuous = true
  recognition.interimResults = true
  baseText = text.value.trim()
  recognition.onresult = (e) => {
    let spoken = ''
    for (let i = 0; i < e.results.length; i++) spoken += e.results[i]![0]!.transcript
    text.value = [baseText, spoken.trim()].filter(Boolean).join(' ')
  }
  recognition.onend = () => (listening.value = false)
  recognition.onerror = () => (listening.value = false)
  recognition.start()
  listening.value = true
}
onBeforeUnmount(() => recognition?.stop())

async function finish() {
  busy.value = 'done'
  try {
    recognition?.stop()
    if (text.value.trim() !== (state.value?.sceneText ?? '')) state.value = await publicApi.sceneText(token.value, text.value)
    state.value = await publicApi.sceneDone(token.value)
    done.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

const stepBox = 'gym-panel flex flex-col items-stretch gap-3 p-4'
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 px-4 py-5">
    <div v-if="error" class="gym-note border-s-bad">
      {{ t('mobile.invalid') }}
      <div class="mt-1 font-mono text-xs">{{ error }}</div>
    </div>
    <div v-else-if="!state" class="py-16 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>

    <template v-else-if="done">
      <h1 class="font-display text-2xl font-bold">
        {{ t('mobile.capture.thanks') }}
      </h1>
      <p class="text-surface-600 dark:text-surface-300">
        {{ t('mobile.capture.thanksHint') }}
      </p>
    </template>

    <template v-else>
      <div>
        <h1 class="font-display text-2xl leading-tight font-bold">
          {{ state.cellName }}
        </h1>
        <span class="font-mono text-xs text-surface-500 dark:text-surface-400">{{ state.date }} · {{ state.skillName }}</span>
        <p class="mt-1 text-surface-600 dark:text-surface-300">
          {{ t('mobile.capture.lead') }}
        </p>
      </div>

      <div :class="stepBox">
        <h2 class="font-display flex items-center gap-2 text-base font-semibold">
          <span class="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 font-mono text-xs">01</span>
          {{ t('mobile.capture.step1') }}
        </h2>
        <img
          v-if="state.hasSceneImage"
          class="w-full rounded-panel border border-surface-300 dark:border-surface-700"
          :src="publicApi.mobileImageUrl(token, imageVersion)"
          alt=""
        />
        <input ref="cameraInput" type="file" accept="image/*" capture="environment" hidden @change="onPhoto" />
        <Button
          v-if="!state.hasSceneImage"
          size="large"
          fluid
          :disabled="busy === 'photo'"
          :loading="busy === 'photo'"
          :label="busy === 'photo' ? t('app.loading') : t('mobile.capture.takePhoto')"
          @click="cameraInput?.click()"
        />
        <SecondaryButton
          v-else
          size="large"
          fluid
          :disabled="busy === 'photo'"
          :label="t('mobile.capture.retake')"
          @click="cameraInput?.click()"
        />
        <button
          v-if="!photoDone"
          type="button"
          class="text-primary cursor-pointer text-sm hover:underline"
          @click="photoSkipped = true"
        >
          {{ t('mobile.capture.skipPhoto') }}
        </button>
      </div>

      <div :class="stepBox" :aria-disabled="!photoDone" class="aria-disabled:pointer-events-none aria-disabled:opacity-50">
        <h2 class="font-display flex items-center gap-2 text-base font-semibold">
          <span class="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 font-mono text-xs">02</span>
          {{ t('mobile.capture.step2') }}
        </h2>
        <Button
          v-if="speechSupported && !listening"
          size="large"
          fluid
          :label="t('mobile.capture.speak')"
          @click="toggleSpeech"
        />
        <SecondaryButton v-else-if="speechSupported" size="large" fluid :label="t('mobile.capture.stop')" @click="toggleSpeech" />
        <span v-if="listening" class="text-ok flex items-center gap-1.5 text-sm">
          <i class="bg-ok size-2 animate-pulse rounded-full" aria-hidden="true"></i>{{ t('mobile.capture.listening') }}
        </span>
        <span v-else-if="!speechSupported" class="text-xs text-surface-500 dark:text-surface-400">{{
          t('mobile.capture.speechUnsupported')
        }}</span>
        <Textarea v-model="text" rows="5" fluid :placeholder="t('mobile.capture.textPlaceholder')" />
      </div>

      <div :class="stepBox" :aria-disabled="!photoDone" class="aria-disabled:pointer-events-none aria-disabled:opacity-50">
        <Button
          size="large"
          fluid
          :disabled="busy === 'done'"
          :loading="busy === 'done'"
          :label="t('mobile.capture.done')"
          @click="finish"
        />
        <span class="text-center text-xs text-surface-500 dark:text-surface-400">{{ t('mobile.capture.doneHint') }}</span>
      </div>
    </template>
  </div>
</template>
