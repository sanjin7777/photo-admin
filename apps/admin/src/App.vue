<script setup lang="ts">
import { useIdleSession } from './composables/useIdleSession';

const { warningOpen, secondsLeft, keepAlive, logoutNow } = useIdleSession();
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
</script>

<template>
  <router-view />

  <!-- 无操作到期提示（点5）：强制选择，倒计时结束自动登出 -->
  <el-dialog
    v-model="warningOpen"
    title="长时间未操作，即将退出登录"
    width="min(420px, 92vw)"
    align-center
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <p class="text-sm leading-relaxed text-slate-600">
      为保护账号安全，<span class="font-semibold tabular-nums text-rose-600">{{ mmss(secondsLeft) }}</span> 后将自动退出登录。点击「保持登录」可继续当前会话。
    </p>
    <template #footer>
      <el-button @click="logoutNow">退出登录</el-button>
      <el-button type="primary" @click="keepAlive">保持登录</el-button>
    </template>
  </el-dialog>
</template>