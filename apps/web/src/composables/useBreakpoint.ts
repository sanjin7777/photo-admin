import { computed, onMounted, onUnmounted, ref } from 'vue';
import { BREAKPOINTS } from '@photo/shared';

/** 断点判定与 Tailwind 配置共用 shared 常量；布局组件据此切换呈现，业务逻辑不重复写。 */
export function useBreakpoint() {
  const width = ref(typeof window === 'undefined' ? 375 : window.innerWidth);
  const update = () => { width.value = window.innerWidth; };
  onMounted(() => { update(); window.addEventListener('resize', update); });
  onUnmounted(() => window.removeEventListener('resize', update));

  return {
    width,
    isMobile: computed(() => width.value < BREAKPOINTS.md),
    isTablet: computed(() => width.value >= BREAKPOINTS.md && width.value < BREAKPOINTS.lg),
    isDesktop: computed(() => width.value >= BREAKPOINTS.lg),
  };
}
