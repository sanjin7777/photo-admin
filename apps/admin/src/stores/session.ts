import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { BackendRole, Capability, UserDto } from '@photo/shared';
import { api, tokens } from '../api';

export const useSessionStore = defineStore('session', () => {
  const user = ref<UserDto | null>(null);
  const capabilities = ref<Set<Capability>>(new Set());
  const loaded = ref(false);
  const roles = computed<BackendRole[]>(() => user.value?.backendRoles ?? []);
  const isBackend = computed(() => roles.value.length > 0);

  async function hydrate(): Promise<void> {
    if (loaded.value) return;
    try {
      const [u, c] = await Promise.all([api.auth.me(), api.auth.capabilities()]);
      user.value = u;
      capabilities.value = new Set(c.capabilities);
      loaded.value = true;
    } catch {
      user.value = null;
      capabilities.value = new Set();
      // 失败不置 loaded：下次导航重试，避免一次网络抖动被缓存成「未登录」
    }
  }

  function can(cap: Capability): boolean { return capabilities.value.has(cap); }

  /** 只重置内存状态、保留登录凭证 */
  function resetState(): void {
    user.value = null;
    capabilities.value = new Set();
    loaded.value = false;
  }

  /** 退出登录才清凭证 */
  function logout(): void {
    tokens.clear();
    resetState();
  }

  const reset = resetState;

  return { user, capabilities, loaded, roles, isBackend, hydrate, can, reset, resetState, logout };
});
