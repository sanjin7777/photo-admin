<script setup lang="ts">
import ConsentGate from './components/ConsentGate.vue';
import { useIdleSession } from './composables/useIdleSession';

const { warningOpen, secondsLeft, keepAlive, logoutNow } = useIdleSession();
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
</script>

<template>
  <router-view />
  <ConsentGate />

  <!-- 无操作到期提示（点5）：移动端底部弹出，桌面端居中 -->
  <Teleport to="body">
    <div v-if="warningOpen" class="fixed inset-0 z-[180] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
      <div class="fade-up w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
        <h3 class="text-base font-semibold text-slate-900">长时间未操作，即将退出登录</h3>
        <p class="mt-2 text-sm leading-relaxed text-slate-600">
          为保护账号安全，<span class="font-semibold tabular-nums text-rose-600">{{ mmss(secondsLeft) }}</span> 后将自动退出。点击「保持登录」可继续当前会话。
        </p>
        <div class="mt-5 flex gap-2">
          <button class="btn-ghost flex-1" @click="logoutNow">退出登录</button>
          <button class="btn-primary flex-1" @click="keepAlive">保持登录</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>