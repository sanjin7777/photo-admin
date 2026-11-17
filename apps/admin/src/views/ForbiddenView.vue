<script setup lang="ts">
/**
 * 403 要区分两种完全不同的情况，否则用户会误以为「登录失败」：
 *   - 没登录             → 引导去登录
 *   - 登录了但没有后台角色 → 说明账号本身正常，缺的是权限（最常见：账号建好了但角色没给）
 *   - 有角色但缺该模块权限 → 提示联系管理员调整
 */
import { computed, onMounted } from 'vue';
import { useSessionStore } from '../stores/session';
import { tokens } from '../api';

const session = useSessionStore();

onMounted(() => {
  // 未装载过能力时补一次，否则刷新 403 页会误判成"未登录"；
  // 没有 token 就不要发请求，免得弹出无关的"请先登录"提示
  if (!session.loaded && tokens.read()) void session.hydrate();
});

const reason = computed(() => {
  if (!session.user) {
    return {
      title: '需要先登录',
      detail: '你还没有登录，或者登录状态已过期。',
      action: '/login',
      actionText: '去登录',
    };
  }
  if (session.roles.length === 0) {
    return {
      title: '账号正常，但没有后台权限',
      detail: '这个微信号可以登录前台，但还没被授予运营 / 财务 / 管理员角色。请联系管理员在「用户管理」里给它加上对应角色。',
      action: '/login',
      actionText: '换个账号登录',
    };
  }
  return {
    title: '当前角色无权访问该模块',
    detail: `你当前的身份是：${session.roles.join('、')}。部分模块（如权限与治理）需要更高角色。`,
    action: '/',
    actionText: '返回概览',
  };
});
</script>

<template>
  <section class="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
    <p class="text-4xl font-semibold text-slate-300">403</p>
    <h1 class="mt-3 text-lg font-semibold text-slate-900">{{ reason.title }}</h1>
    <p class="mt-2 text-sm leading-relaxed text-slate-500">{{ reason.detail }}</p>

    <p v-if="session.user" class="mt-3 text-xs text-slate-500">
      当前账号：{{ session.user.nickname || session.user.wechatId }}（{{ session.user.wechatId }}）
    </p>

    <RouterLink :to="reason.action"
      class="mt-5 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
      {{ reason.actionText }}
    </RouterLink>
  </section>
</template>
