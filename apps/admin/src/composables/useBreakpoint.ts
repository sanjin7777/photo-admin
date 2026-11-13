import { computed, onMounted, onUnmounted, ref } from 'vue';
import { BREAKPOINTS } from '@photo/shared';

export function useBreakpoint() {
  const width = ref(typeof window === 'undefined' ? 1280 : window.innerWidth);
  const update = () => { width.value = window.innerWidth; };
  onMounted(() => { update(); window.addEventListener('resize', update); });
  onUnmounted(() => window.removeEventListener('resize', update));
  return {
    width,
    isMobile: computed(() => width.value < BREAKPOINTS.lg),
    isDesktop: computed(() => width.value >= BREAKPOINTS.lg),
    isWide: computed(() => width.value >= BREAKPOINTS.xl),
  };
}
