import { defineStore } from 'pinia'
import { ref } from 'vue'
import { currentLang, i18n, setLang, type Lang } from '@/i18n'
import { readableError } from '@/utils/errors'

export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_KEY = 'gym-theme'

/** Bottom banner, language and theme. */
export const useUi = defineStore('ui', () => {
  const banner = ref<{ kind: 'err' | 'info' | 'ok'; text: string } | null>(null)
  const lang = ref<Lang>(currentLang())
  const theme = ref<ThemePref>(readTheme())
  const dark = ref(resolveDark(theme.value))

  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  function showBanner(kind: 'err' | 'info' | 'ok', text: string, autoHideMs?: number) {
    // an error of the API is said in the UI language; one it does not know stays as it came
    banner.value = { kind, text: kind === 'err' ? readableError(text, i18n.global.t) : text }
    clearTimeout(bannerTimer)
    if (autoHideMs) bannerTimer = setTimeout(() => (banner.value = null), autoHideMs)
    if (kind === 'err') console.error('[GYM]', text)
  }
  function hideBanner() {
    banner.value = null
  }
  function switchLang(l: Lang) {
    lang.value = l
    setLang(l)
  }
  function setTheme(pref: ThemePref) {
    theme.value = pref
    applyTheme(pref)
    try {
      localStorage.setItem(THEME_KEY, pref)
    } catch {
      /* private mode */
    }
  }
  /** The switch in the top bar: light and dark only, never back to "system". */
  function toggleTheme() {
    setTheme(dark.value ? 'light' : 'dark')
  }

  function applyTheme(pref: ThemePref) {
    dark.value = resolveDark(pref)
    document.documentElement.classList.toggle('dark', dark.value)
  }

  applyTheme(theme.value)
  document.documentElement.lang = lang.value
  // "system" follows the OS while it is chosen.
  systemDark()?.addEventListener('change', () => {
    if (theme.value === 'system') applyTheme('system')
  })

  return {
    banner,
    lang,
    theme,
    dark,
    showBanner,
    hideBanner,
    switchLang,
    setTheme,
    toggleTheme,
  }
})

function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : 'system'
  } catch {
    return 'system'
  }
}

const systemDark = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null)

const resolveDark = (pref: ThemePref): boolean => (pref === 'system' ? !!systemDark()?.matches : pref === 'dark')
