<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { loginSchema, registerSchema } from '@photo/shared';
import { api, tokens } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';

/**
 * 注册入口暂时隐藏（2026-11-11）：账号由管理员开通，前端只保留登录。
 * 恢复时把 SHOW_REGISTER 改为 true；服务端注册接口与邀请码机制保持不变。
 */
const SHOW_REGISTER = false;
const mode = ref<'login' | 'register'>('login');
const wechatId = ref(''); const nickname = ref(''); const password = ref('');
const inviteCode = ref('');
const agreed = ref(false);

/**
 * 空表单时按钮直接置灰，配合 submit 里的必填提示：
 * 用户不会点了按钮才看到报错，也避免把「表单校验未通过」这种系统文案暴露出来。
 */
const canSubmit = computed(() =>
  mode.value === 'login'
    ? Boolean(wechatId.value.trim() && password.value)
    : Boolean(wechatId.value.trim() && password.value && nickname.value.trim() && inviteCode.value.trim() && agreed.value),
);
const router = useRouter(); const route = useRoute();
const session = useSessionStore(); const ui = useUiStore();

/** 只接受站内绝对路径，挡掉 //evil.com、/\evil.com 这类开放重定向 */
function safeRedirect(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

async function submit(): Promise<void> {
  if (mode.value === 'register') {
    const parsed = registerSchema.safeParse({
      wechatId: wechatId.value, password: password.value, nickname: nickname.value,
      inviteCode: inviteCode.value.trim().toUpperCase(),
      agreed: agreed.value,
    });
    if (!parsed.success) { ui.notify(parsed.error.issues[0]?.message ?? '参数不合法', 'fail'); return; }
    try {
      await api.auth.register(parsed.data);
      ui.notify('注册成功，请登录', 'success');
      mode.value = 'login';
    } catch {
      // 业务错误已由 http.onError 统一提示
    }
    return;
  }

  /**
   * 空输入不要直接抛服务端校验错误。
   *
   * 先做一次「必填」提示：文案比 Zod 的 issues[0].message 更贴近用户当前动作，
   * 也避免用户看到 1002「表单校验未通过」这种系统级措辞。
   */
  if (!wechatId.value.trim()) { ui.notify('请输入微信号', 'fail'); return; }
  if (!password.value) { ui.notify('请输入密码', 'fail'); return; }

  const parsed = loginSchema.safeParse({ wechatId: wechatId.value, password: password.value });
  if (!parsed.success) { ui.notify(parsed.error.issues[0]?.message ?? '参数不合法', 'fail'); return; }
  try {
    await api.auth.login(parsed.data);
    tokens.save();
    session.resetState();
    await router.push(safeRedirect(route.query.redirect));
  } catch {
    // 业务错误已由 http.onError 统一提示
  }
}
</script>

<template>
  <section class="safe-bottom mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 pb-10">
    <img src="/logo.jpg" alt="猫爪社摄影会" class="h-14 w-14 rounded-2xl object-cover ring-1 ring-brand/15" />
    <p class="mt-3 text-xs tracking-[0.35em] text-brand">猫爪社摄影会</p>
    <h1 class="mt-2 text-3xl font-semibold tracking-tight text-slate-900">摄影会登记</h1>
    <p class="mt-2 text-sm text-slate-500">用微信号登录，活动登记与会员权益都在这里</p>

    <div class="mt-7 space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <div v-if="SHOW_REGISTER" class="flex gap-1 rounded-xl bg-slate-100 p-1 text-sm">
        <button class="flex-1 rounded-lg py-2 transition"
          :class="mode === 'login' ? 'bg-white font-semibold text-slate-900 shadow-sm' : 'text-slate-500'"
          @click="mode = 'login'">登录</button>
        <button class="flex-1 rounded-lg py-2 transition"
          :class="mode === 'register' ? 'bg-white font-semibold text-slate-900 shadow-sm' : 'text-slate-500'"
          @click="mode = 'register'">注册</button>
      </div>

      <label class="block">
        <span class="mb-1 block text-xs text-slate-500">微信号</span>
        <input v-model="wechatId" class="field" placeholder="字母开头，6–20 位，如 catpaw_user" autocomplete="username"
          @keyup.enter="submit" />
      </label>
      <template v-if="mode === 'register'">
        <label class="block">
          <span class="mb-1 block text-xs text-slate-500">昵称</span>
          <input v-model="nickname" class="field" placeholder="2–24 个字符" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-slate-500">邀请码</span>
          <input v-model="inviteCode" class="field uppercase tracking-widest" placeholder="请向管理员获取" autocomplete="off" />
          <span class="mt-1 block text-xs text-slate-500">注册需要邀请码，一个邀请码仅可使用一次</span>
        </label>
      </template>
      <label class="block">
        <span class="mb-1 block text-xs text-slate-500">密码</span>
        <input v-model="password" type="password" class="field" placeholder="至少 8 位，含字母与数字" autocomplete="current-password"
          @keyup.enter="submit" />
      </label>

      <button class="btn-primary w-full" :disabled="!canSubmit" @click="submit">
        {{ mode === 'login' ? '登录' : '注册' }}
      </button>

      <label v-if="mode === 'register'" class="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
        <input v-model="agreed" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand" />
        <span>
          我已阅读并同意
          <a href="/terms" target="_blank" rel="noopener" class="text-brand hover:underline">《用户协议》</a>
          与
          <a href="/privacy" target="_blank" rel="noopener" class="text-brand hover:underline">《隐私政策》</a>
        </span>
      </label>

      <p class="text-xs leading-relaxed text-slate-500">
        微信号是唯一登录标识。账号由管理员开通，如需参加活动请先联系客服。
        积分仅 VIP / SVIP 会员具备，用于登记时结算活动权益。
      </p>
    </div>

    <RouterLink to="/" class="mt-6 text-center text-xs text-slate-500 hover:text-slate-900">先随便看看场次 →</RouterLink>

    <footer class="mt-8 text-center text-xs leading-relaxed text-slate-500">
      <p>本站为猫爪社摄影会会员内部活动管理系统，仅限受邀会员使用。</p>
      <p class="mt-1">
        <a href="/terms" target="_blank" rel="noopener" class="hover:text-slate-700">用户协议</a>
        <span class="mx-1">·</span>
        <a href="/privacy" target="_blank" rel="noopener" class="hover:text-slate-700">隐私政策</a>
        <span class="mx-1">·</span>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener" class="hover:text-slate-700">湘ICP备2026012181号-2</a>
      </p>
    </footer>
  </section>
</template>
