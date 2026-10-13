import { reactive } from 'vue'

/** One popover for the whole app; InfoButton opens it, InfoPopover renders it. */
export const popover = reactive<{
  open: boolean
  title: string
  text: string
  example: string
  left: number
  top: number
  anchor: HTMLElement | null
}>({ open: false, title: '', text: '', example: '', left: 0, top: 0, anchor: null })

export function showInfo(anchor: HTMLElement, info: [string, string, string]) {
  if (popover.open && popover.anchor === anchor) return hideInfo()
  popover.title = info[0]
  popover.text = info[1]
  popover.example = info[2]
  popover.anchor = anchor
  popover.open = true
  // position after render
  requestAnimationFrame(() => {
    const el = document.getElementById('gym-pop')
    const r = anchor.getBoundingClientRect()
    const w = el?.offsetWidth ?? 330
    const h = el?.offsetHeight ?? 160
    let top = r.bottom + 8
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8)
    popover.left = Math.min(Math.max(8, r.left - 6), window.innerWidth - w - 8)
    popover.top = top
  })
}

export function hideInfo() {
  popover.open = false
  popover.anchor = null
}
