<script setup lang="ts">
import { gymApi } from '@/api/gym'
import type { Robot } from '@/types/gym'
import IconBot from '~icons/carbon/bot'

/** The robot's photo as a square, or a robot icon when it has none. */
const props = withDefaults(
  defineProps<{ tenantId: string; robot: Pick<Robot, 'id' | 'hasImage' | 'updatedAt'>; size?: 'sm' | 'lg' }>(),
  {
    size: 'sm',
  },
)
const sizes = { sm: 'size-14', lg: 'size-40' } as const
</script>

<template>
  <div
    class="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-surface-300 bg-surface-100 text-surface-400 dark:border-surface-700 dark:bg-surface-800"
    :class="sizes[props.size]"
  >
    <img
      v-if="props.robot.hasImage"
      :src="gymApi.robotImageUrl(props.tenantId, props.robot.id, props.robot.updatedAt)"
      alt=""
      class="size-full object-cover"
      loading="lazy"
    />
    <IconBot v-else :class="props.size === 'lg' ? 'size-12' : 'size-6'" aria-hidden="true" />
  </div>
</template>
