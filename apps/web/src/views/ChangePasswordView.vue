<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { changePasswordSchema } from '@photo/shared';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const router = useRouter();
const session = useSessionStore();
const ui = useUiStore();

/** 导入账号首次登录会被路由守卫强制带到这里 */
const forced = computed(() => session.mustChangePassword);

async function submit(): Promise<void> {
  if (submitting.value) return;
  const parsed = changePasswordSchema.safeParse({
    oldPassword: oldPassword.value,
    newPassword: newPassword.value,
  });
  if (!parsed.success) {
    ui.notify(parsed.error.issues[0]?.message ?? '参数不合法', 'fail');
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    ui.notify('两次输入的新密码不一致', 'fail');
    return;
  }
  submitting.value = true;
  try {
    await api.auth.changePassword(parsed.data);
    // 服务端已换发新 Cookie；重置内存态后重新装载，避免继续携带旧能力视图
    session.resetState();
    await session.hydrate();
    ui.notify('密码已修改', 'success');
    await router.replace('/');
  } catch {
    // 业务错误已由 http.onError 统一提示
  } finally {
    submitting.value = false;
  }
}

async function logout(): Promise<void> {
  try {
    await api.auth.logout();
  } catch {
    ui.notify('退出失败，请检查网络后重试', 'fail');
    return;
  }
  session.logout();
  await router.replace('/login');
}
</script>

<template>
  <section class="safe-bottom mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 pb-10">
    <img src="/logo.jpg" alt="猫爪社摄影会" class="h-14 w-14 rounded-2xl object-cover ring-1 ring-brand/15" />
    <p class="mt-3 text-xs tracking-[0.35em] text-brand">猫爪社摄影会</p>
    <h1 class="mt-2 text-2xl font-semibold tracking-tight text-slate-900">修改密码</h1>
    <p v-if="forced" class="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
      你使用的是运营发放的初始密码，需要先修改密码才能继续使用。
    </p>
    <p v-else class="mt-2 text-sm text-slate-500">为账号安全，建议定期更换密码</p>

    <div class="mt-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <p class="text-xs text-slate-500">
        当前账号
        <span class="font-medium text-slate-800">{{ session.user?.nickname || session.user?.wechatId || '—' }}</span>
        <span v-if="session.user?.nickname" class="ml-1 text-slate-500">（{{ session.user.wechatId }}）</span>
      </p>
      <label class="block">
        <span class="mb-1 block text-xs text-slate-500">当前密码</span>
        <input v-model="oldPassword" type="password" class="field" placeholder="请输入当前密码" autocomplete="current-password" />
      </label>
      <label class="block">
        <span class="mb-1 block text-xs text-slate-500">新密码</span>
        <input v-model="newPassword" type="password" class="field" placeholder="至少 8 位，含字母与数字" autocomplete="new-password" />
      </label>
      <label class="block">
        <span class="mb-1 block text-xs text-slate-500">确认新密码</span>
        <input v-model="confirmPassword" type="password" class="field" placeholder="再次输入新密码" autocomplete="new-password" @keyup.enter="submit" />
      </label>

      <button class="btn-primary w-full" :disabled="submitting" @click="submit">
        {{ submitting ? '提交中…' : '确认修改' }}
      </button>
      <p class="text-xs leading-relaxed text-slate-500">
        修改成功后，其它设备上的登录会立即失效；当前设备保持登录。
      </p>
    </div>

    <button class="btn-ghost mt-5 w-full" @click="logout">退出登录</button>
  </section>
</template>
