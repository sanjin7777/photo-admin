import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * KPI 数字滚动：ease-out 逼近目标值；目标变化时打断上一次动画。
 * 用 setInterval 而非 requestAnimationFrame——后台/隐藏标签页会暂停 rAF，
 * 导致数字停在初始 0；定时器在隐藏时仍会触发（仅被节流），动画可正常收尾。
 */
export function useCountUp(target: Ref<number> | (() => number), duration = 600): Ref<number> {
  const display = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const get = typeof target === 'function' ? target : () => target.value;

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function animate(to: number): void {
    stop();
    const from = display.value;
    if (from === to) {
      display.value = to;
      return;
    }
    const start = Date.now();
    timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      display.value = Math.round(from + (to - from) * eased);
      if (p >= 1) stop();
    }, 16);
  }

  watch(get, (v) => animate(v), { immediate: true });
  onBeforeUnmount(stop);
  return display;
}