import { createRouter, createWebHashHistory } from 'vue-router'
import { hasSession } from '@/utils/fetcher'

/**
 * Routes. The operator's work lives under /tenant/:tenantId (the wizard runs on
 * a block, the day protocol and the skill have their own pages); the mobile
 * views (/m/…) and the printable day protocol (/print/…) are public: they run on
 * devices where nobody is signed in and identify themselves by token or id.
 */
const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'Root', component: () => import('@/views/RootView.vue') },
    { path: '/tenant/:tenantId', name: 'Home', component: () => import('@/views/HomeView.vue') },
    { path: '/tenant/:tenantId/start', name: 'StartBlock', component: () => import('@/views/StartBlockView.vue') },
    { path: '/tenant/:tenantId/continue', name: 'Continue', component: () => import('@/views/ContinueView.vue') },
    { path: '/tenant/:tenantId/block/:blockId', name: 'Block', component: () => import('@/views/BlockWizardView.vue') },
    { path: '/tenant/:tenantId/day/:dayId', name: 'Day', component: () => import('@/views/DayView.vue') },
    { path: '/tenant/:tenantId/skills/:skillId', name: 'Skill', component: () => import('@/views/SkillView.vue') },
    { path: '/tenant/:tenantId/analysis', name: 'Analysis', component: () => import('@/views/AnalysisView.vue') },
    {
      path: '/tenant/:tenantId/eval-reports/:reportId',
      name: 'EvaluationReport',
      component: () => import('@/views/EvaluationReportView.vue'),
    },
    { path: '/tenant/:tenantId/settings', name: 'Settings', component: () => import('@/views/SettingsView.vue') },
    {
      path: '/m/capture/:token',
      name: 'MobileCapture',
      component: () => import('@/views/MobileCaptureView.vue'),
      meta: { public: true },
    },
    { path: '/m/run/:token', name: 'MobileRun', component: () => import('@/views/MobileRunView.vue'), meta: { public: true } },
    { path: '/print/:shareId', name: 'Print', component: () => import('@/views/PrintView.vue'), meta: { public: true } },
    {
      path: '/eval-report/:shareId',
      name: 'EvaluationReportShared',
      component: () => import('@/views/EvaluationReportSharedView.vue'),
      meta: { public: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: (to, from, saved) => saved ?? (to.name !== from.name ? { top: 0 } : undefined),
})

router.beforeEach((to, _from, next) => {
  if (!to.meta.public && !hasSession()) {
    window.location.href = `/login.html?redirectUrl=${encodeURIComponent(window.location.href)}`
    return
  }
  next()
})

export default router
