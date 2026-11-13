<script setup lang="ts">
/**
 * 协议同意闸门：登录后若当前用户尚未同意最新版用户协议/隐私政策，弹窗拦截。
 * 注册用户已在注册时留痕，这里主要覆盖迁移前注册的存量用户与协议改版后的补勾。
 */
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const route = useRoute();
const visible = ref(false);
const checked = ref(false);
const submitting = ref(false);

async function check(): Promise<void> {
  if (!session.user || route.path === '/login') {
    visible.value = false;
    return;
  }
  try {
    const status = await api.consents.mine();
    visible.value = status.needConsent;
  } catch {
    // 同意状态拿不到时不阻塞使用，避免网络抖动导致用户进不来
    visible.value = false;
  }
}

watch(() => session.user?.id, check, { immediate: true });

async function accept(): Promise<void> {
  if (!checked.value || submitting.value) return;
  submitting.value = true;
  try {
    await api.consents.accept();
    visible.value = false;
  } catch {
    // 统一错误提示
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-[200] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
    <div class="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
      <h3 class="text-lg font-semibold text-slate-900">请阅读并同意</h3>
      <p class="mt-2 text-xs leading-relaxed text-slate-500">
        继续使用本系统前，请阅读并同意最新版的《用户协议》与《隐私政策》。
        我们会记录您的同意时间与版本，用于合规留痕。
      </p>

      <div class="mt-3 space-y-2">
        <a href="/terms" target="_blank" rel="noopener"
          class="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
          <span>用户协议</span><span class="text-xs text-brand">查看 →</span>
        </a>
        <a href="/privacy" target="_blank" rel="noopener"
          class="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
          <span>隐私政策</span><span class="text-xs text-brand">查看 →</span>
        </a>
      </div>

      <label class="mt-3 flex items-start gap-2 text-xs leading-relaxed text-slate-500">
        <input v-model="checked" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand" />
        <span>我已阅读并同意《用户协议》与《隐私政策》</span>
      </label>

      <button class="btn-primary mt-4 w-full disabled:opacity-50" :disabled="!checked || submitting" @click="accept">
        {{ submitting ? '提交中…' : '同意并继续' }}
      </button>
    </div>
  </div>
</template>
