<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { changePasswordSchema, highestRoleLabel } from '@photo/shared';
import { useBreakpoint } from '../composables/useBreakpoint';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { adminMenus } from '../router';
import { api } from '../api';
import PageErrorBoundary from '../components/PageErrorBoundary.vue';

const { isDesktop } = useBreakpoint();
const ui = useUiStore();
const session = useSessionStore();
const route = useRoute();
const router = useRouter();
/** 后台挂在 /admin/ 子路径下，静态资源必须带 BASE_URL，且用绑定避免被 Vite 当模块解析 */
const logoUrl = `${import.meta.env.BASE_URL}logo.jpg`;

const visibleMenus = computed(() =>
  adminMenus.filter((m) => m.capabilities.length === 0 || m.capabilities.every((c) => session.can(c))),
);

/** 按分组渲染：运营 / 财务 / 系统，避免菜单越加越长时找不到东西 */
const groups = computed(() => {
  const order: string[] = [];
  const map = new Map<string, typeof visibleMenus.value>();
  for (const m of visibleMenus.value) {
    if (!map.has(m.group)) { map.set(m.group, []); order.push(m.group); }
    map.get(m.group)!.push(m);
  }
  return order.map((name) => ({ name, items: map.get(name)! }));
});

const roleText = computed(() => highestRoleLabel(session.roles) || '后台账号');

async function logout(): Promise<void> {
  try {
    await api.auth.logout();
  } catch {
    // 服务端登出失败时 Cookie 仍有效，直接跳登录页会被「返回」恢复会话
    ui.notify('退出失败，请检查网络后重试', 'warning');
    return;
  }
  session.logout();
  await router.push('/login');
}

/* ---------------- 本人修改密码 ---------------- */
const pwdOpen = ref(false);
const pwdBusy = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });

function openPassword(): void {
  pwdForm.oldPassword = '';
  pwdForm.newPassword = '';
  pwdForm.confirmPassword = '';
  ui.drawerOpen = false;
  pwdOpen.value = true;
}

async function submitPassword(): Promise<void> {
  if (pwdBusy.value) return;
  const parsed = changePasswordSchema.safeParse({
    oldPassword: pwdForm.oldPassword,
    newPassword: pwdForm.newPassword,
  });
  if (!parsed.success) {
    ui.notify(parsed.error.issues[0]?.message ?? '参数不合法', 'warning');
    return;
  }
  if (pwdForm.newPassword !== pwdForm.confirmPassword) {
    ui.notify('两次输入的新密码不一致', 'warning');
    return;
  }
  pwdBusy.value = true;
  try {
    await api.auth.changePassword(parsed.data);
    // 服务端已换发新 Cookie；重置内存态后重新装载，避免继续携带旧能力视图
    session.resetState();
    await session.hydrate();
    ui.notify('密码已修改，其它设备已退出登录', 'success');
    pwdOpen.value = false;
  } catch {
    // 业务错误已由 http.onError 统一提示
  } finally {
    pwdBusy.value = false;
  }
}
</script>

<template>
  <div class="min-h-dvh bg-slate-50">
    <!-- lg 以上：常驻侧边栏 240px -->
    <aside v-if="isDesktop" class="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-slate-200 bg-white px-3 py-4">
      <div class="mb-5 flex items-center gap-2 px-2">
        <img :src="logoUrl" alt="猫爪社摄影会" class="h-9 w-9 rounded-xl object-cover ring-1 ring-slate-200" />
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-slate-900">猫爪社摄影会</p>
          <p class="text-xs text-slate-500">管理后台</p>
        </div>
      </div>

      <nav class="flex-1 space-y-4 overflow-y-auto">
        <div v-for="g in groups" :key="g.name">
          <p class="mb-1 px-3 text-xs font-medium tracking-wide text-slate-500">{{ g.name }}</p>
          <RouterLink v-for="m in g.items" :key="m.to" :to="m.to"
            class="mb-0.5 flex items-center rounded-lg px-3 py-2 text-sm transition"
            :class="route.path === m.to
              ? 'bg-blue-50 font-medium text-blue-700'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'">
            {{ m.label }}
          </RouterLink>
        </div>
      </nav>

      <div class="mt-4 border-t border-slate-100 px-2 pt-3 text-xs text-slate-500">
        <p class="truncate">{{ session.user?.nickname }} · {{ roleText }}</p>
        <div class="mt-1.5 flex items-center gap-3">
          <button class="text-blue-600 hover:underline" @click="openPassword">修改密码</button>
          <button class="text-slate-500 hover:text-slate-700 hover:underline" @click="logout">退出登录</button>
        </div>
      </div>
    </aside>

    <!-- lg 以下：汉堡 + 抽屉 -->
    <header v-if="!isDesktop" class="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-3">
      <button class="text-xl" aria-label="打开菜单" @click="ui.drawerOpen = true">☰</button>
      <img :src="logoUrl" alt="猫爪社摄影会" class="h-7 w-7 rounded-lg object-cover" />
      <span class="font-semibold text-slate-900">猫爪社摄影会</span>
      <span class="text-xs text-slate-500">后台</span>
      <span class="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{{ roleText }}</span>
    </header>
    <div v-if="!isDesktop && ui.drawerOpen" class="fixed inset-0 z-50 flex">
      <div class="flex h-full w-64 flex-col bg-white p-4 shadow-xl">
        <p class="mb-3 font-semibold text-slate-900">导航</p>
        <div v-for="g in groups" :key="g.name" class="mb-3">
          <p class="mb-1 text-xs text-slate-500">{{ g.name }}</p>
          <RouterLink v-for="m in g.items" :key="m.to" :to="m.to"
            class="block rounded-lg px-3 py-2 text-sm"
            :class="route.path === m.to ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-700'"
            @click="ui.drawerOpen = false">{{ m.label }}</RouterLink>
        </div>
        <div class="mt-auto space-y-1 border-t border-slate-100 pt-3">
          <button class="block w-full text-left text-sm text-blue-600" @click="openPassword">修改密码</button>
          <button class="block w-full text-left text-sm text-slate-500" @click="logout">退出登录</button>
        </div>
      </div>
      <div class="flex-1 bg-slate-900/40" @click="ui.drawerOpen = false" />
    </div>

    <main :class="isDesktop ? 'ml-60' : ''" class="p-3 lg:p-6">
      <PageErrorBoundary>
        <RouterView />
      </PageErrorBoundary>
    </main>

    <!-- 本人修改密码：复用前台同一接口，改完当前设备保持登录、其它设备下线 -->
    <el-dialog v-model="pwdOpen" title="修改密码" width="min(420px, 92vw)" top="8vh">
      <div class="space-y-3">
        <p class="text-xs text-slate-500">
          当前账号 <span class="font-medium text-slate-800">{{ session.user?.wechatId ?? '—' }}</span>
        </p>
        <label class="block">
          <span class="mb-1 block text-xs text-slate-500">当前密码</span>
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入当前密码" autocomplete="current-password" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-slate-500">新密码</span>
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 8 位，含字母与数字" autocomplete="new-password" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-slate-500">确认新密码</span>
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password placeholder="再次输入新密码" autocomplete="new-password" @keyup.enter="submitPassword" />
        </label>
        <p class="text-xs leading-relaxed text-slate-500">
          修改成功后，其它设备上的登录会立即失效；当前设备保持登录。
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="pwdOpen = false">取消</el-button>
          <el-button type="primary" :loading="pwdBusy" @click="submitPassword">确认修改</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>
