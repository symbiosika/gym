<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { driver, type Driver, type PopoverDOM } from 'driver.js'
import 'driver.js/dist/driver.css'
import { gymApi } from '@/api/gym'
import { useApp } from '@/stores/app'
import { useTour } from '@/stores/tour'
import { useUi } from '@/stores/ui'
import { chapterAvailable, routeOf, TOUR_CHAPTERS, tourSteps, type TourChapterId, type TourStep } from '@/tour/chapters'
import SpecManager from '@/components/SpecManager.vue'
import IconPlay from '~icons/carbon/play-filled-alt'

/**
 * The guided tour, mounted once in the shell: the chapter dialog and the
 * runner. The runner walks the steps of the chosen chapters (tour/chapters.ts)
 * over the tour skill: it opens each step's page, waits for the element the
 * step points at and highlights it with driver.js. A step whose element does
 * not turn up (the skill has no such data, a panel that only shows sometimes)
 * is skipped. The tour only looks: the highlighted element cannot be clicked,
 * the overlay covers the rest, the screens it opens are read-only while it
 * runs, and the spec manager it shows is the read-only one below.
 */
const tour = useTour()
const app = useApp()
const ui = useUi()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const tenantId = computed(() => String(route.params.tenantId ?? app.selectedTenant ?? ''))
const material = computed(() => tour.material)

/* ------------------------------------------------------------- the dialog */
async function loadMaterial() {
  if (!tenantId.value) return
  try {
    tour.material = await gymApi.tour(tenantId.value)
  } catch (e) {
    ui.showBanner('err', e instanceof Error ? e.message : String(e))
  }
}
watch(
  () => tour.dialogOpen,
  (open) => {
    if (open) void loadMaterial()
  },
)
const chapters = computed(() =>
  TOUR_CHAPTERS.map((id) => ({ id, available: !!material.value && chapterAvailable(id, material.value) })),
)
const anyAvailable = computed(() => chapters.value.some((c) => c.available))

/* ------------------------------------------------------------- the runner */
let d: Driver | null = null
let steps: { chapter: TourChapterId; step: TourStep }[] = []
let index = 0
/** every show() gets a number; one that was overtaken by the next stops where it is */
let generation = 0
/** the element the current step points at; null for a chapter's opening step */
let target: Element | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
/** The element of a step once it is on the page and visible, or null after `ms`. */
async function waitFor(name: string, ms: number): Promise<Element | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const el = [...document.querySelectorAll(`[data-tour="${name}"]`)].find((e) => e.getClientRects().length > 0)
    if (el) return el
    await sleep(100)
  }
  return null
}

/** The nearest ancestor that scrolls (the content of a dialog), or null for the page itself. */
function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}
/** How far down the sticky bars at the top of the page reach (the header, the "looking at" note of the wizard). */
function stickyOffset(): number {
  const bars = [...document.querySelectorAll<HTMLElement>('header, .sticky')].filter(
    (e) => getComputedStyle(e).position === 'sticky' && e.getClientRects().length > 0,
  )
  return Math.max(0, ...bars.map((e) => (parseFloat(getComputedStyle(e).top) || 0) + e.offsetHeight))
}
/**
 * Bring the top of the element into view when it is not wholly visible: a
 * long region shows from its start, cut at the bottom, under the sticky bars
 * of the page or at the top of the dialog it is in. driver.js only centres.
 */
async function alignTop(el: Element) {
  const box = el.getBoundingClientRect()
  const parent = scrollParent(el)
  const view = parent ? parent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  const margin = parent ? 12 : stickyOffset() + 16
  if (box.top >= view.top + margin && box.bottom <= view.bottom) return
  ;(el as HTMLElement).style.scrollMarginTop = `${margin}px`
  el.scrollIntoView({ block: 'start', inline: 'nearest' })
  await nextFrame()
  d?.refresh()
}

/*
 * The green frame around what a step points at: drawn above the overlay, so
 * a scrolling panel cannot cut it, and kept on the element every frame; when
 * the element moves (a dialog scrolls inside, a panel opens) the overlay's
 * cut-out is moved with it.
 */
let frame: HTMLDivElement | null = null
let frameLoop = 0
let lastBox = ''
function followTarget() {
  frameLoop = requestAnimationFrame(followTarget)
  if (!frame) return
  if (!target || !target.isConnected) {
    frame.style.display = 'none'
    return
  }
  const r = target.getBoundingClientRect()
  const key = `${r.top}|${r.left}|${r.width}|${r.height}`
  frame.style.display = 'block'
  frame.style.top = `${r.top - 6}px`
  frame.style.left = `${r.left - 6}px`
  frame.style.width = `${r.width + 12}px`
  frame.style.height = `${r.height + 12}px`
  if (key !== lastBox && lastBox) d?.refresh()
  lastBox = key
}
function startFrame() {
  frame = document.createElement('div')
  frame.className = 'gym-tour-frame'
  document.body.appendChild(frame)
  frameLoop = requestAnimationFrame(followTarget)
}
function stopFrame() {
  cancelAnimationFrame(frameLoop)
  frame?.remove()
  frame = null
  target = null
  lastBox = ''
}

/*
 * The popover may be dragged by its title. Where it was put, it stays for the
 * rest of the tour, kept inside the window; a double click on the title puts
 * it back next to what it explains.
 */
function placePopover(wrapper: HTMLElement) {
  const at = tour.popoverAt
  if (!at) {
    wrapper.classList.remove('gym-tour-moved')
    return
  }
  const x = Math.min(Math.max(8, at.x), window.innerWidth - wrapper.offsetWidth - 8)
  const y = Math.min(Math.max(8, at.y), window.innerHeight - wrapper.offsetHeight - 8)
  wrapper.style.setProperty('--gym-tour-x', `${x}px`)
  wrapper.style.setProperty('--gym-tour-y', `${y}px`)
  wrapper.classList.add('gym-tour-moved')
}
function makeDraggable(wrapper: HTMLElement, handle: HTMLElement) {
  handle.classList.add('gym-tour-handle')
  handle.title = t('tour.drag')
  handle.addEventListener('pointerdown', (e) => {
    const box = wrapper.getBoundingClientRect()
    const dx = e.clientX - box.left
    const dy = e.clientY - box.top
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      tour.popoverAt = { x: ev.clientX - dx, y: ev.clientY - dy }
      placePopover(wrapper)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
  handle.addEventListener('dblclick', () => {
    tour.popoverAt = null
    placePopover(wrapper)
    d?.refresh()
  })
}
const onResize = () => {
  const wrapper = document.querySelector<HTMLElement>('.driver-popover.gym-tour')
  if (wrapper) placePopover(wrapper)
}

/** What every popover gets once driver.js has drawn it: the link to another chapter, the drag handle, its place. */
function decorate(popover: PopoverDOM) {
  const link = steps[index]?.step.link
  if (link) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'gym-tour-link'
    button.textContent = t('tour.toChapter', { chapter: t(`tour.chapters.${link}.title`) })
    button.addEventListener('click', () => {
      finish()
      tour.start([link])
    })
    popover.description.appendChild(button)
  }
  makeDraggable(popover.wrapper, popover.title)
  placePopover(popover.wrapper)
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

async function show(i: number, direction: 1 | -1): Promise<void> {
  const mine = ++generation
  if (i < 0) return show(0, 1)
  if (i >= steps.length) return finish()
  const { chapter, step } = steps[i]!
  const m = tour.material!
  tour.ui = step.ui ?? {}
  const route = routeOf(step.page, m, tenantId.value)
  if (!route) return show(i + direction, direction)
  if (router.resolve(route).fullPath !== router.currentRoute.value.fullPath) await router.push(route)
  const el = step.element ? await waitFor(step.element, 4000) : null
  if (mine !== generation || !tour.active) return
  if (step.element && !el) return show(i + direction, direction)
  index = i
  target = el
  lastBox = ''

  const inChapter = steps.filter((s) => s.chapter === chapter)
  const position = inChapter.findIndex((s) => s.step === step) + 1
  const last = i === steps.length - 1
  d?.highlight({
    // the opening step of a chapter has nothing to point at: its popover stands in the middle
    ...(el ? { element: el } : {}),
    popover: {
      title: escapeHtml(t(`tour.steps.${chapter}.${step.id}.title`)),
      description:
        `<span class="gym-tour-progress">${escapeHtml(t(`tour.chapters.${chapter}.title`))} · ${position} / ${inChapter.length}</span>` +
        escapeHtml(t(`tour.steps.${chapter}.${step.id}.text`)),
      showButtons: ['next', 'previous', 'close'],
      disableButtons: i === 0 ? ['previous'] : [],
      nextBtnText: last ? t('tour.done') : t('tour.next'),
      prevBtnText: t('tour.prev'),
      onNextClick: () => void show(i + 1, 1),
      onPrevClick: () => void show(i - 1, -1),
      onCloseClick: () => finish(),
    },
  })
  if (el) await alignTop(el)
}

function onKey(e: KeyboardEvent) {
  if (!tour.active) return
  if (e.key === 'ArrowRight') void show(index + 1, 1)
  else if (e.key === 'ArrowLeft' && index > 0) void show(index - 1, -1)
}

async function run(chapterIds: TourChapterId[]) {
  tour.requested = null
  await loadMaterial()
  const m = tour.material
  if (!m?.skill) return
  steps = tourSteps(chapterIds, m)
  if (!steps.length) {
    ui.showBanner('info', t('tour.nothing'), 4000)
    return
  }
  tour.active = true
  d = driver({
    animate: true,
    allowClose: true,
    allowKeyboardControl: false,
    disableActiveInteraction: true,
    overlayOpacity: 0.55,
    stagePadding: 6,
    stageRadius: 8,
    popoverClass: 'gym-tour',
    onPopoverRender: decorate,
    onDestroyed: () => finish(),
  })
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  startFrame()
  await show(0, 1)
}

/** End the tour: close what it opened, stay on the page it was on. */
function finish() {
  if (!tour.active && !d) return
  generation++
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  stopFrame()
  const current = d
  d = null
  tour.reset()
  if (current?.isActive()) current.destroy()
}

watch(
  () => tour.requested,
  (chapterIds) => {
    if (chapterIds?.length) void run(chapterIds)
  },
)
onBeforeUnmount(finish)
</script>

<template>
  <Modal v-model:visible="tour.dialogOpen" size="md" :title="t('tour.title')" :hint="t('tour.lead')">
    <div v-if="!material" class="py-6 text-center font-mono text-xs text-surface-500">{{ t('app.loading') }} …</div>
    <div v-else-if="!material.skill" class="gym-note border-s-warn">
      <p>{{ t('tour.noSkill') }}</p>
      <p class="mt-1.5">
        <RouterLink
          v-if="app.isAdmin"
          class="text-primary font-medium hover:underline"
          :to="{ name: 'Settings', params: { tenantId } }"
          @click="tour.dialogOpen = false"
          >{{ t('tour.toSettings') }}</RouterLink
        >
        <span v-else>{{ t('tour.askAdmin') }}</span>
      </p>
    </div>
    <template v-else>
      <p class="mb-3 text-sm text-surface-600 dark:text-surface-300">
        {{ t('tour.skill', { name: material.skill.name }) }}
      </p>
      <ol class="flex flex-col gap-2">
        <li
          v-for="(c, i) in chapters"
          :key="c.id"
          class="flex items-center gap-3 rounded-panel border border-surface-300 p-3 dark:border-surface-700"
          :class="c.available ? '' : 'opacity-60'"
        >
          <span class="font-mono text-xs font-semibold text-surface-500">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="min-w-0 grow">
            <b class="block font-medium">{{ t(`tour.chapters.${c.id}.title`) }}</b>
            <span class="block text-xs text-surface-500 dark:text-surface-400">{{
              c.available ? t(`tour.chapters.${c.id}.lead`) : t('tour.unavailable')
            }}</span>
          </span>
          <SecondaryButton size="small" :disabled="!c.available" :label="t('tour.start')" @click="tour.start([c.id])">
            <template #icon><IconPlay class="size-3.5" /></template>
          </SecondaryButton>
        </li>
      </ol>
    </template>
    <template #footer>
      <SecondaryButton :label="t('app.close')" @click="tour.dialogOpen = false" />
      <span class="grow"></span>
      <Button
        v-if="material?.skill"
        :disabled="!anyAvailable"
        :label="t('tour.whole')"
        @click="tour.start(chapters.filter((c) => c.available).map((c) => c.id))"
      />
    </template>
  </Modal>

  <!-- the spec manager as the tour shows it: read-only, opened and closed by the steps of the specs chapter -->
  <SpecManager
    v-if="tour.active && material?.skill"
    :visible="!!tour.ui.specManager"
    :tenant-id="tenantId"
    :current="material.skill.criticSpecName"
    :view="tour.ui.specManager ?? 'form'"
    readonly
    @update:visible="() => undefined"
  />
</template>
