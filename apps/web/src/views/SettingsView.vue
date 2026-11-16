<script setup lang="ts">
/**
 * 设置：账号安全与退出。
 *
 * 原来「修改密码 / 退出登录 / 注销账号」三块直接摞在个人中心底部，
 * 个人中心因此变得又长又杂。这里单独成页，危险操作也更容易做视觉隔离。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

const session = useSessionStore();
const ui = useUiStore();
const router = useRouter();

async function logout(): Promise<void> {
  try {
    await api.auth.logout();
  } catch {
    // 服务端登出失败时 Cookie 仍然有效，直接清本地态会让「返回」恢复会话
    ui.notify('退出失败，请检查网络后重试', 'fail');
    return;
  }
  session.logout();
  await router.push('/login');
}

/* ---------------- 注销账号 ---------------- */
const deleteOpen = ref(false);
const deletePassword = ref('');
const deleting = ref(false);
const deleteError = ref('');

function openDelete(): void {
  deletePassword.value = '';
  deleteError.value = '';
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  if (!deletePassword.value) {
    deleteError.value = '请输入登录密码以确认注销';
    return;
  }
  deleting.value = true;
  deleteError.value = '';
  try {
    await api.auth.deleteAccount({ password: deletePassword.value });
    // 服务端已清 Cookie，这里只清内存态并回首页
    session.resetState();
    deleteOpen.value = false;
    ui.notify('账号已注销', 'success');
    await router.push('/');
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : '注销失败，请稍后重试';
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-2xl space-y-4 pb-6">
    <RouterLink to="/profile" class="inline-block text-xs text-slate-500 hover:text-slate-900">← 返回个人中心</RouterLink>

    <!-- 账号安全 -->
    <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
      <RouterLink to="/password" class="flex items-center justify-between p-4 transition hover:bg-slate-50">
        <div>
          <p class="text-sm font-semibold text-slate-900">修改密码</p>
          <p class="mt-0.5 text-xs text-slate-500">定期更换，修改后其它设备的登录会立即失效</p>
        </div>
        <span class="text-slate-400">›</span>
      </RouterLink>
      <button class="flex w-full items-center justify-between border-t border-slate-100 p-4 text-left transition hover:bg-slate-50"
        @click="logout">
        <div>
          <p class="text-sm font-semibold text-slate-900">退出登录</p>
          <p class="mt-0.5 text-xs text-slate-500">下次需重新用微信号登录</p>
        </div>
        <span class="text-slate-400">›</span>
      </button>
    </div>

    <!-- 危险操作：刻意用红色边框 + 红色文字按钮，与上面的中性操作拉开距离 -->
    <div class="rounded-2xl border-2 border-rose-200 bg-rose-50/60 p-4">
      <p class="flex items-center gap-1.5 text-sm font-semibold text-rose-700">
        <span class="flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-[11px] font-bold text-white">!</span>
        注销账号
      </p>
      <p class="mt-2 text-xs leading-relaxed text-rose-700/80">
        注销后你的微信号、昵称、密码、邮箱与头像将被清除，账号立即失效且<b>无法恢复</b>。
        为履行对账与争议举证义务，历史登记与积分流水会保留但不再关联你的身份。
      </p>
      <button type="button"
        class="mt-3 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 active:scale-[0.99]"
        @click="openDelete">
        申请注销账号
      </button>
    </div>

    <!-- 注销确认：必须重新输入密码 -->
    <div v-if="deleteOpen" class="fixed inset-0 z-[160] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      @click.self="deleteOpen = false">
      <div class="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
        <h3 class="text-base font-semibold text-slate-900">确认注销账号</h3>
        <p class="mt-2 text-xs leading-relaxed text-slate-600">
          注销后不可恢复：微信号、昵称、密码、邮箱、头像将被清除，账号立即失效。
          历史登记与积分流水会保留用于对账，但不再关联你的身份。
        </p>
        <label class="mt-3 block">
          <span class="mb-1 block text-xs font-medium text-slate-600">请输入登录密码确认</span>
          <input v-model="deletePassword" type="password" autocomplete="current-password"
            class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-rose-500"
            placeholder="登录密码" @keyup.enter="confirmDelete" />
        </label>
        <p v-if="deleteError" class="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{{ deleteError }}</p>
        <div class="mt-4 flex gap-2">
          <button class="btn-ghost flex-1 py-2 text-sm" @click="deleteOpen = false">取消</button>
          <button class="flex-1 rounded-lg bg-rose-600 py-2 text-sm font-medium text-white disabled:opacity-50"
            :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '注销中…' : '确认注销' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
