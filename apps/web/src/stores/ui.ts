import { defineStore } from 'pinia';
import { ref } from 'vue';
import { showToast } from 'vant';

/**
 * 提示走 Vant 命令式 Toast：它挂载到 body，任何路由（含独立路由 /login）都能显示，
 * 不再依赖 WebLayout 内的自绘提示条（曾导致登录页错误完全不可见）。
 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false);
  const toast = ref('');
  function notify(message: string, type: 'text' | 'success' | 'fail' = 'text'): void {
    toast.value = message;
    showToast({ message, type, duration: 2600 });
  }
  return { drawerOpen, toast, notify };
});
