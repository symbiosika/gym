<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'

/** A QR code of a URL, drawn on a canvas, with the URL as caption. */
const props = withDefaults(
  defineProps<{
    url: string
    size?: number
    /** the URL under the code; off where the code is small and the link sits next to it */ caption?: boolean
  }>(),
  {
    size: 220,
    caption: true,
  },
)
const canvas = ref<HTMLCanvasElement | null>(null)

async function draw() {
  if (!canvas.value || !props.url) return
  // always on white: a phone camera needs the contrast, in dark mode too
  await QRCode.toCanvas(canvas.value, props.url, {
    width: props.size,
    margin: 1,
    color: { dark: '#111820', light: '#ffffff' },
  })
}
onMounted(draw)
watch(() => props.url, draw)
</script>

<template>
  <figure
    class="m-0 flex flex-col items-center gap-2 rounded-panel border border-surface-300 bg-white dark:border-surface-700"
    :class="caption ? 'p-3.5' : 'p-1.5'"
  >
    <canvas ref="canvas" class="block h-auto max-w-full" :width="size" :height="size"></canvas>
    <figcaption v-if="caption" class="text-center font-mono text-[0.65rem] break-all text-[#4c5966]">
      <a :href="url" target="_blank" rel="noopener" class="hover:underline">{{ url }}</a>
    </figcaption>
  </figure>
</template>
