import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

// The SPA is served by the backend under /static/app/ (see backend/src/index.ts).
// In development Vite proxies the API and the auth pages to the backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const DEV_SERVER = env.VITE_DEV_API_URL || 'http://localhost:3000'
  const proxy = (path: string) => ({ [path]: { target: DEV_SERVER, changeOrigin: true, ws: true } })

  return {
    base: '/static/app/',
    build: { outDir: 'dist/static/app', emptyOutDir: true },
    plugins: [
      vue(),
      tailwindcss(),
      // Icons are components: `import IconUpload from '~icons/carbon/upload'`.
      // Never an icon font and never a PrimeVue icon class.
      Icons({ compiler: 'vue3' }),
      AutoImport({
        dts: 'src/auto-imports.d.ts',
        imports: ['vue', 'vue-router', 'vue-i18n'],
        dirs: ['./src/stores', './src/utils'],
      }),
      // Volt components and our own are used without an import.
      Components({ dts: 'src/components.d.ts', dirs: ['./src/volt', './src/components'] }),
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: 5173,
      proxy: {
        ...proxy('/api/v1'),
        ...proxy('/login.html'),
        ...proxy('/magic-login-verify.html'),
        ...proxy('/password-login.html'),
        ...proxy('/verify-email.html'),
        ...proxy('/reset-password.html'),
        ...proxy('/logout.html'),
        ...proxy('/oauth-callback.html'),
        ...proxy('/favicon.png'),
        ...proxy('/styles.css'),
        ...proxy('/app-info.js'),
      },
    },
  }
})
