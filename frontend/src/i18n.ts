import { createI18n } from 'vue-i18n'
import de from './locales/de.json'
import en from './locales/en.json'

export const LANG_KEY = 'gym-lang'
export type Lang = 'de' | 'en'

const stored = (() => {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return v === 'en' || v === 'de' ? v : null
  } catch {
    return null
  }
})()

const browser = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'

export const i18n = createI18n({
  legacy: false,
  locale: stored ?? browser,
  fallbackLocale: 'de',
  messages: { de, en },
  // the DE texts use "·" and "{n}" placeholders only; no HTML
  warnHtmlMessage: false,
})

export function setLang(lang: Lang) {
  i18n.global.locale.value = lang
  document.documentElement.lang = lang
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* private mode */
  }
}

export const currentLang = (): Lang => (i18n.global.locale.value === 'en' ? 'en' : 'de')
