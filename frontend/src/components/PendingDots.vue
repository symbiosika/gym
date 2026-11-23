<script setup lang="ts">
/**
 * Three dots that light up in turn: something is being worked on elsewhere
 * (the critics measure a dataset, the prompt check is computed). In the warn
 * colour, as a run that is not finished yet; the label says what is running,
 * for screen readers and beside the dots where there is room.
 */
defineProps<{ label?: string }>()
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-1.5 text-warn" role="status">
    <span class="inline-flex items-center gap-0.5" aria-hidden="true">
      <i
        v-for="k in 3"
        :key="k"
        class="pending-dot size-1.5 rounded-full bg-warn"
        :style="{ animationDelay: `${(k - 1) * 0.2}s` }"
      ></i>
    </span>
    <span v-if="label" class="text-xs whitespace-nowrap">{{ label }}</span>
  </span>
</template>

<style scoped>
.pending-dot {
  animation: pending 1.2s ease-in-out infinite;
}
@keyframes pending {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pending-dot {
    animation: none;
    opacity: 0.7;
  }
}
</style>
