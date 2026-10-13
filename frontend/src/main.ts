import './assets/base.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Column from 'primevue/column'
import Tooltip from 'primevue/tooltip'

import App from './App.vue'
import router from './router'
import { i18n } from './i18n'

const app = createApp(App)

app.directive('tooltip', Tooltip)
// DataTable's column is the one PrimeVue part Volt does not wrap.
app.component('Column', Column)

app.use(PrimeVue, {
  unstyled: true,
  pt: {
    directives: {
      tooltip: {
        root: {
          class: `hidden w-fit pointer-events-none absolute max-w-64 group drop-shadow-lg
                  data-[p-position=top]:py-1 data-[p-position=bottom]:py-1
                  data-[p-position=left]:px-1 data-[p-position=right]:px-1`,
        },
        arrow: {
          class: `absolute w-0 h-0 border-transparent border-solid border-[.25rem]
                  group-data-[p-position=top]:border-y-surface-700 group-data-[p-position=top]:-ml-1 group-data-[p-position=top]:border-b-0
                  group-data-[p-position=bottom]:border-y-surface-700 group-data-[p-position=bottom]:-ml-1 group-data-[p-position=bottom]:border-t-0
                  group-data-[p-position=left]:border-l-surface-700 group-data-[p-position=left]:-mt-1 group-data-[p-position=left]:border-r-0
                  group-data-[p-position=right]:border-r-surface-700 group-data-[p-position=right]:-mt-1 group-data-[p-position=right]:border-l-0`,
        },
        text: {
          class: 'break-words whitespace-pre-line bg-surface-700 text-surface-0 px-3 py-2 rounded-md text-sm',
        },
      },
    },
  },
})

app.use(createPinia()).use(i18n).use(router).use(ConfirmationService).mount('#app')
