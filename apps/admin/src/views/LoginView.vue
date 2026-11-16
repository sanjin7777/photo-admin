<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { loginSchema } from '@photo/shared';
import { api, tokens } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

const account = ref(''); const password = ref('');
const errorText = ref('');
const logoUrl = `${import.meta.env.BASE_URL}logo.jpg`;
const router = useRouter(); const route = useRoute();
const session = useSessionStore(); const ui = useUiStore();

/** 只接受站内绝对路径，挡掉 //evil.com、/\evil.com 这类开放重定向 */
function safeRedirect(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

/**
 * 注意：字段名必须与 @photo/shared 的 loginSchema 一致（wechatId）。
 * 该 schema 是 .strict() 的，字段名不符会在 safeParse 阶段直接失败——
 * 表现为「点了登录但没有任何请求发出」，所以这里同时做内联错误提示便于定位。
 */
async function submit(): Promise<void> {
  errorText.value = '';
  const parsed = loginSchema.safeParse({ wechatId: account.value, password: password.value });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? '参数不合法';
    errorText.value = msg;
    ui.notify(msg, 'warning');
    return;
  }
  try {
    // 凭证由服务端 Set-Cookie 下发，前端不接触 token
    await api.auth.login(parsed.data);
    tokens.save();
    session.resetState();
    const caps = await api.auth.capabilities();
    if (!caps.backendRoles.length) {
      session.logout();
      errorText.value = '该账号不是后台角色';
      ui.notify('该账号不是后台角色', 'warning');
      return;
    }
    await router.push(safeRedirect(route.query.redirect));
  } catch {
    // 业务错误已由 http.onError 统一弹 ElMessage
  }
}
</script>

<template>
  <section class="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5">
    <div class="mb-6 flex items-center gap-3">
      <img :src="logoUrl" alt="猫爪社摄影会" class="h-12 w-12 rounded-2xl object-cover ring-1 ring-slate-200" />
      <div>
        <h1 class="text-2xl font-semibold text-slate-900">猫爪社摄影会</h1>
        <p class="text-sm text-slate-500">管理后台 · 管理员 / 运营 / 财务登录</p>
      </div>
    </div>
    <div class="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <el-form @submit.prevent>
        <el-form-item>
          <el-input v-model="account" size="large" placeholder="微信号" autocomplete="username"
            clearable @keyup.enter="submit" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" size="large" placeholder="密码"
            autocomplete="current-password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" show-icon class="!mb-3" />
        <el-button type="primary" native-type="button" size="large" class="w-full" @click="submit">登录</el-button>
      </el-form>
      <p class="text-xs leading-relaxed text-slate-500">
        仅管理员 / 运营 / 财务账号可进入；PC 端体验最佳，移动端可查看与简单操作。
      </p>
    </div>
    <p class="mt-4 text-center text-xs text-slate-500">
      账号为<b>微信号</b>；忘记密码请联系系统维护人员重置。
    </p>
  </section>
</template>
