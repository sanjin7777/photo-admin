import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Capability, MemberLevel, UserDto } from '@photo/shared';
import { api, tokens } from '../api';

export const useSessionStore = defineStore('session', () => {
  const user = ref<UserDto | null>(null);
  const capabilities = ref<Set<Capability>>(new Set());
  const loaded = ref(false);
  const level = computed<MemberLevel>(() => user.value?.level ?? 'NONE');
  /** 仅 VIP/SVIP 有积分账户；普通用户不展示任何积分相关 UI */
  const isMember = computed(() => level.value === 'VIP' || level.value === 'SVIP');
  /** 导入账号首次登录：只允许停留在修改密码页 */
  const mustChangePassword = computed(() => user.value?.mustChangePassword === true);

  /** 守卫每次进入受保护路由前调用；能力清单只用于渲染，不构成安全边界 */
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
      // 失败不置 loaded：下次导航重试，避免把一次网络抖动缓存成「未登录」直到刷新页面
    }
  }

  function can(cap: Capability): boolean {
    return capabilities.value.has(cap);
  }

  /** 只重置内存状态、保留登录凭证：登录成功后调用，让守卫重新 hydrate */
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

  // 兼容旧调用点：语义为「只重置状态」，绝不清 token（曾导致登录后立刻 2001）
  const reset = resetState;

  return {
    user, capabilities, loaded, level, isMember, mustChangePassword,
    hydrate, can, reset, resetState, logout,
  };
});
