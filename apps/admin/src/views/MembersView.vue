<script setup lang="ts">
/**
 * 会员管理：用户列表为主；单个授予与 Excel 批量导入都走弹窗。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { AdminUserListItemDto, AssignableBackendRole, MemberImportPreviewDto, MemberImportResultDto } from '@photo/shared';
import { adminCreateUserSchema, ASSIGNABLE_BACKEND_ROLES, BACKEND_ROLE_META, labelsOf } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import { MEMBER_LEVEL, metaOf, personLabel, points, shortTime } from '../utils/labels';
import AppPagination from '../components/AppPagination.vue';

const ui = useUiStore();
const session = useSessionStore();

const list = ref<AdminUserListItemDto[]>([]);
const loading = ref(true);
const keyword = ref('');
const levelFilter = ref('');

/* 服务端分页：用户表只增不减，按页拉全量迟早会把老会员挤出可见范围 */
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

const levelMeta = MEMBER_LEVEL;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.admin.members.list({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      level: levelFilter.value || undefined,
    });
    // 页码越界（例如筛选后总数变少）时回到最后一页重查，避免停在空白页
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (page.value > lastPage) {
      page.value = lastPage;
      return load();
    }
    list.value = res.list;
    total.value = res.total;
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
/** 筛选条件变化必须回第 1 页，否则会停在上一次的页码上看到空列表 */
function search(): void {
  page.value = 1;
  void load();
}
function goPage(next: number): void {
  page.value = Math.min(Math.max(1, next), pageCount.value);
  void load();
}
/** 分页组件回调：直接跳到目标页（已由组件保证合法） */
function goPageTo(next: number): void {
  page.value = next;
  void load();
}
/** 切换每页条数：回到第 1 页，避免页码越界 */
function changePageSize(size: number): void {
  pageSize.value = size;
  page.value = 1;
  void load();
}
onMounted(load);

/* ---------------- 授予弹窗 ---------------- */
const grantOpen = ref(false);
const granting = ref(false);
/**
 * 授予会员：用**微信号**定位用户（后台看到的是微信号，用户 ID 不直观）。
 * 有效期默认永久（永久开关打开时忽略天数）；可同时录入积分同步到账户。
 */
const grant = reactive({
  wechatId: '',
  level: 'VIP' as 'VIP' | 'SVIP',
  permanent: true,
  days: 365,
  amountYuan: 0,
  bonusYuan: 0,
  reason: '',
});

function openGrant(user?: AdminUserListItemDto): void {
  grant.wechatId = user?.wechatId ?? '';
  grant.level = user?.level === 'SVIP' ? 'SVIP' : 'VIP';
  grant.permanent = true;
  grant.days = 365;
  grant.amountYuan = 0;
  grant.bonusYuan = 0;
  grant.reason = '';
  grantOpen.value = true;
}

async function doGrant(): Promise<void> {
  if (!grant.wechatId.trim()) { ui.notify('请填写微信号', 'warning'); return; }
  if (!grant.reason.trim()) { ui.notify('授予原因必填，会写入权限日志', 'warning'); return; }
  if (grant.amountYuan < 0) { ui.notify('入账积分不能为负', 'warning'); return; }
  if (grant.bonusYuan < 0) { ui.notify('赠送积分不能为负', 'warning'); return; }
  granting.value = true;
  const startAt = new Date();
  const expireAt = grant.permanent
    ? null
    : new Date(startAt.getTime() + grant.days * 86_400_000);
  try {
    await api.admin.memberships.grant({
      wechatId: grant.wechatId.trim(),
      level: grant.level,
      startAt: startAt.toISOString(),
      ...(expireAt ? { expireAt: expireAt.toISOString() } : {}),
      ...(grant.amountYuan > 0 ? { amountYuan: grant.amountYuan } : {}),
      ...(grant.bonusYuan > 0 ? { bonusYuan: grant.bonusYuan } : {}),
      reason: grant.reason.trim(),
    });
    const parts: string[] = [];
    if (grant.amountYuan > 0) parts.push(`入账 ${grant.amountYuan.toFixed(2)} 积分`);
    if (grant.bonusYuan > 0) parts.push(`赠送 ${grant.bonusYuan.toFixed(2)} 积分`);
    ui.notify(
      parts.length ? `授予成功，已同步${parts.join('、')}` : '授予成功，该用户旧会话已失效',
      'success',
    );
    grantOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    granting.value = false;
  }
}

/* ---------------- 重置密码（仅管理员与运维账号） ---------------- */
const resettingId = ref<string | null>(null);
const resetResult = ref<{ wechatId: string; nickname: string | null; temporaryPassword: string } | null>(null);

/** 运维账号由系统保护，服务端也会拒绝；前端直接不展示按钮 */
const canResetPassword = (u: AdminUserListItemDto): boolean =>
  session.can('admin:user:reset-password') && !u.roles.includes('SUPER_ADMIN');

async function resetPassword(u: AdminUserListItemDto): Promise<void> {
  try {
    await ui.confirm(
      `重置「${personLabel(u.nickname, u.wechatId, u.id)}」的密码？原密码立即失效，旧会话会被登出，并生成一次性展示的临时密码。`,
      '重置密码',
    );
  } catch {
    return;
  }
  resettingId.value = u.id;
  try {
    resetResult.value = await api.admin.members.resetPassword({ wechatId: u.wechatId });
    ui.notify('密码已重置，请转告临时密码', 'success');
  } catch {
    // 统一错误提示
  } finally {
    resettingId.value = null;
  }
}

/* ---------------- 新增用户弹窗 ---------------- */
const createOpen = ref(false);
const creating = ref(false);
const createForm = reactive({
  wechatId: '',
  nickname: '',
  password: '',
  level: 'NONE' as 'NONE' | 'VIP' | 'SVIP',
  expireAt: '',
  roles: [] as AssignableBackendRole[],
  balanceYuan: 0,
  bonusYuan: 0,
});

const roleOptions = ASSIGNABLE_BACKEND_ROLES.map((r) => ({ value: r, label: BACKEND_ROLE_META[r].label }));

function openCreate(): void {
  createForm.wechatId = '';
  createForm.nickname = '';
  createForm.password = '';
  createForm.level = 'NONE';
  createForm.expireAt = '';
  createForm.roles = [];
  createForm.balanceYuan = 0;
  createForm.bonusYuan = 0;
  createOpen.value = true;
}

function toggleRole(value: AssignableBackendRole): void {
  const i = createForm.roles.indexOf(value);
  if (i >= 0) createForm.roles.splice(i, 1);
  else createForm.roles.push(value);
}

async function doCreate(): Promise<void> {
  const parsed = adminCreateUserSchema.safeParse({
    wechatId: createForm.wechatId.trim(),
    nickname: createForm.nickname.trim(),
    password: createForm.password,
    level: createForm.level,
    expireAt: createForm.level === 'NONE'
      ? null
      : createForm.expireAt ? new Date(createForm.expireAt).toISOString() : undefined,
    roles: createForm.roles,
    balanceYuan: createForm.level === 'NONE' ? undefined : (createForm.balanceYuan || undefined),
    bonusYuan: createForm.level === 'NONE' ? undefined : (createForm.bonusYuan || undefined),
  });
  if (!parsed.success) {
    ui.notify(parsed.error.issues[0]?.message ?? '表单校验未通过', 'warning');
    return;
  }
  creating.value = true;
  try {
    await api.admin.members.create(parsed.data);
    ui.notify('用户已创建，请把初始密码告知对方', 'success');
    createOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    creating.value = false;
  }
}

/* ---------------- 编辑用户 ---------------- */
const editOpen = ref(false);
const updating = ref(false);
const editTarget = ref<AdminUserListItemDto | null>(null);
const editForm = reactive({
  nickname: '',
  level: 'NONE' as 'NONE' | 'VIP' | 'SVIP',
  expireAt: '',
  roles: [] as AssignableBackendRole[],
  status: 'ACTIVE' as 'ACTIVE' | 'FROZEN',
});

/** 远端用 9999 表示永久；这里统一转成「留空」 */
const isPermanent = (iso: string | null): boolean => Boolean(iso && new Date(iso).getFullYear() >= 9999);

function openEditUser(u: AdminUserListItemDto): void {
  editTarget.value = u;
  editForm.nickname = u.nickname;
  editForm.level = u.level;
  editForm.expireAt = u.levelExpireAt && !isPermanent(u.levelExpireAt)
    ? new Date(u.levelExpireAt).toISOString().slice(0, 10)
    : '';
  // 系统维护账号不出现在后台用户列表，这里再过滤一次做类型收敛：表单只接受可分配角色
  editForm.roles = u.roles.filter((r): r is AssignableBackendRole => r !== 'SUPER_ADMIN');
  editForm.status = u.status;
  editOpen.value = true;
}

function toggleEditRole(value: AssignableBackendRole): void {
  const i = editForm.roles.indexOf(value);
  if (i >= 0) editForm.roles.splice(i, 1);
  else editForm.roles.push(value);
}

async function doUpdate(): Promise<void> {
  if (!editTarget.value) return;
  updating.value = true;
  try {
    await api.admin.members.update(editTarget.value.id, {
      nickname: editForm.nickname.trim(),
      level: editForm.level,
      // 留空 = 永久有效
      expireAt: editForm.level === 'NONE' ? null : editForm.expireAt ? new Date(editForm.expireAt).toISOString() : null,
      roles: editForm.roles,
      status: editForm.status,
    });
    ui.notify('已保存，该用户旧会话已失效', 'success');
    editOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    updating.value = false;
  }
}

/* ---------------- 导入弹窗 ---------------- */
const importOpen = ref(false);
type Stage = 'upload' | 'preview' | 'done';
const stage = ref<Stage>('upload');
const fileName = ref('');
const parsing = ref(false);
const committing = ref(false);
const dragging = ref(false);
const preview = ref<MemberImportPreviewDto | null>(null);
const result = ref<MemberImportResultDto | null>(null);
const overwrite = ref(false);
const strict = ref(false);

const importableRows = computed(() => preview.value?.rows.filter((r) => r.status !== 'ERROR') ?? []);

const rowStatus: Record<string, { label: string; cls: string }> = {
  OK: { label: '可导入', cls: 'bg-emerald-50 text-emerald-700' },
  WARN: { label: '有提示', cls: 'bg-amber-50 text-amber-700' },
  ERROR: { label: '不可导入', cls: 'bg-rose-50 text-rose-700' },
};

function openImport(): void {
  stage.value = 'upload';
  preview.value = null;
  result.value = null;
  fileName.value = '';
  overwrite.value = false;
  strict.value = false;
  importOpen.value = true;
}

async function pick(file: File | null | undefined): Promise<void> {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { ui.notify('文件不能超过 5MB', 'warning'); return; }
  parsing.value = true;
  fileName.value = file.name;
  try {
    const res = await api.admin.membersImport.preview(file);
    preview.value = res;
    stage.value = 'preview';
    if (res.fatal.length) ui.notify(res.fatal[0] ?? '解析失败', 'error');
  } catch {
    // 统一错误提示
  } finally {
    parsing.value = false;
  }
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  void pick(input.files?.[0]);
  input.value = '';
}
function onDrop(e: DragEvent): void {
  dragging.value = false;
  void pick(e.dataTransfer?.files?.[0]);
}

async function commit(): Promise<void> {
  if (!importableRows.value.length) return;
  committing.value = true;
  try {
    result.value = await api.admin.membersImport.commit({
      rows: importableRows.value,
      strict: strict.value,
      overwrite: overwrite.value,
    });
    stage.value = 'done';
    ui.notify('导入完成', 'success');
    await load();
  } catch {
    // 统一错误提示
  } finally {
    committing.value = false;
  }
}

/**
 * 下载导入模板。
 *
 * 不用 `<a href>` 直连：那样浏览器会自己发一个不带 axios 配置的导航请求，
 * 401 时会把整个 SPA 顶掉变成错误页/空白页。这里用 fetch 走同一套 Cookie，
 * 失败只提示不跳转，并沿用服务端给的 Content-Disposition 文件名。
 */
async function downloadTemplate(): Promise<void> {
  try {
    const res = await fetch(api.admin.membersImport.templateUrl, { credentials: 'include' });
    if (!res.ok) {
      ui.notify(res.status === 403 ? '当前账号没有下载模板的权限' : '模板下载失败，请重试', 'error');
      return;
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const matched = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const filename = matched?.[1] ? decodeURIComponent(matched[1]) : 'member-import-template.xlsx';

    const blob = await res.blob();
    if (!blob.size) {
      ui.notify('模板内容为空，请检查服务端日志', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // 交给浏览器下载后回收，避免内存泄漏
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch {
    ui.notify('模板下载失败，请检查网络', 'error');
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">用户管理</h1>
        <p class="mt-1 text-sm text-slate-500">
          所有注册用户都在这里。普通用户没有积分，会员（VIP / SVIP）才有积分账户；「邀请码」一列显示该用户的注册来源。
        </p>
      </div>
      <div class="flex gap-2">
        <el-button @click="downloadTemplate">下载模板</el-button>
        <el-button @click="openImport">批量导入</el-button>
        <el-button type="primary" @click="openCreate">+ 新增用户</el-button>
      </div>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <el-input v-model="keyword" placeholder="搜索微信号或昵称" clearable class="!w-60" @keyup.enter="search" />
      <el-select v-model="levelFilter" placeholder="全部等级" clearable class="!w-36" @change="search">
        <el-option label="普通用户" value="NONE" />
        <el-option label="VIP" value="VIP" />
        <el-option label="SVIP" value="SVIP" />
      </el-select>
      <el-button size="small" @click="search">查询</el-button>
      <span class="ml-auto text-xs text-slate-500">共 {{ total }} 人</span>
    </div>

    <div class="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table class="hidden w-full text-left text-sm md:table">
        <thead class="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th class="px-3 py-2.5 font-medium">昵称</th>
            <th class="px-3 py-2.5 font-medium">微信号</th>
            <th class="px-3 py-2.5 font-medium">等级</th>
            <th class="px-3 py-2.5 font-medium">到期</th>
            <th class="px-3 py-2.5 font-medium">积分</th>
            <th class="px-3 py-2.5 font-medium">累计赠送</th>
            <th class="px-3 py-2.5 font-medium">后台角色</th>
            <th class="px-3 py-2.5 font-medium">邀请码</th>
            <th class="px-3 py-2.5 font-medium">注册时间</th>
            <th class="px-3 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in list" :key="u.id" class="border-t border-slate-100 hover:bg-slate-50/60">
            <td class="px-3 py-2.5 font-medium text-slate-900">
              {{ u.nickname || '—' }}
              <span v-if="u.status === 'FROZEN'" class="ml-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600">已冻结</span>
            </td>
            <td class="px-3 py-2.5 font-mono text-xs text-slate-600">{{ u.wechatId }}</td>
            <td class="px-3 py-2.5">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(levelMeta, u.level).cls">
                {{ metaOf(levelMeta, u.level).label }}
              </span>
            </td>
            <td class="px-3 py-2.5 text-xs text-slate-500">{{ u.levelExpireAt ? new Date(u.levelExpireAt).toLocaleDateString('zh-CN') : '—' }}</td>
            <td class="px-3 py-2.5 text-slate-700">{{ u.balanceCent == null ? '—' : points(u.balanceCent) }}</td>
            <td class="px-3 py-2.5 text-slate-500">{{ u.bonusGrantedCent > 0 ? points(u.bonusGrantedCent) : '—' }}</td>
            <td class="px-3 py-2.5 text-xs text-slate-500">{{ labelsOf(u.roles) }}</td>
            <td class="px-3 py-2.5 font-mono text-xs tracking-wide text-slate-600" :title="u.invitedByCode ?? ''">
              {{ u.invitedByCode ?? '—' }}
            </td>
            <td class="px-3 py-2.5 text-xs text-slate-500">{{ shortTime(u.createdAt) }}</td>
            <td class="px-3 py-2.5 text-right whitespace-nowrap">
              <el-button size="small" @click="openEditUser(u)">编辑</el-button>
              <el-button size="small" @click="openGrant(u)">{{ u.level === 'NONE' ? '授予' : '续期' }}</el-button>
              <el-button v-if="canResetPassword(u)" size="small" :loading="resettingId === u.id" @click="resetPassword(u)">重置密码</el-button>
            </td>
          </tr>
          <tr v-if="!loading && !list.length">
            <td colspan="10" class="px-3 py-14 text-center">
              <p class="text-sm text-slate-600">没有匹配的用户</p>
              <p class="mt-1 text-xs text-slate-500">可以清空筛选条件，或用「批量导入」把现有会员导进来</p>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="divide-y divide-slate-100 md:hidden">
        <div v-for="u in list" :key="u.id" class="p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="clamp-1 font-medium text-slate-900">{{ u.nickname || '—' }}</p>
              <p class="mt-0.5 font-mono text-xs text-slate-500">
                {{ u.wechatId }}
                <span v-if="u.status === 'FROZEN'" class="ml-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600">已冻结</span>
              </p>
            </div>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px]" :class="metaOf(levelMeta, u.level).cls">{{ metaOf(levelMeta, u.level).label }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            积分 {{ u.balanceCent == null ? '—' : points(u.balanceCent) }}
            <span v-if="u.bonusGrantedCent > 0"> · 含赠送 {{ points(u.bonusGrantedCent) }}</span>
            <span v-if="u.levelExpireAt"> · 至 {{ new Date(u.levelExpireAt).toLocaleDateString('zh-CN') }}</span>
          </p>
          <p class="mt-0.5 text-xs text-slate-500">邀请码 {{ u.invitedByCode ?? '—' }}</p>
          <el-button size="small" class="mt-2" @click="openEditUser(u)">编辑</el-button>
          <el-button size="small" class="mt-2" @click="openGrant(u)">授予 / 续期</el-button>
          <el-button v-if="canResetPassword(u)" size="small" class="mt-2" :loading="resettingId === u.id" @click="resetPassword(u)">重置密码</el-button>
        </div>
        <div v-if="!loading && !list.length" class="px-3 py-12 text-center text-sm text-slate-500">没有匹配的用户</div>
      </div>

      <AppPagination
        :page="page"
        :page-size="pageSize"
        :total="total"
        :hide-on-single-page="true"
        @change="(p) => goPageTo(p)"
        @size-change="(s) => changePageSize(s)"
      />
    </div>

    <!-- 授予弹窗 -->
    <el-dialog v-model="grantOpen" title="授予会员" width="min(520px, 94vw)" destroy-on-close>
      <el-form label-width="110px" label-position="left">
        <el-form-item label="微信号" required>
          <el-input v-model="grant.wechatId" placeholder="从上方列表点「授予」会自动带入" />
        </el-form-item>
        <el-form-item label="会员等级">
          <el-select v-model="grant.level" class="!w-40">
            <el-option label="VIP" value="VIP" />
            <el-option label="SVIP" value="SVIP" />
          </el-select>
        </el-form-item>
        <el-form-item label="同时发放积分">
          <div class="w-full">
            <el-input-number v-model="grant.amountYuan" :min="0" :step="1" :precision="2"
              controls-position="right" class="!w-40" placeholder="0 = 不发放" />
            <span class="ml-2 text-xs text-slate-500">积分</span>
          </div>
        </el-form-item>
        <el-form-item label="赠送积分">
          <div class="w-full">
            <el-input-number v-model="grant.bonusYuan" :min="0" :step="1" :precision="2"
              controls-position="right" class="!w-40" placeholder="0 = 不赠送" />
            <span class="ml-2 text-xs text-slate-500">单独记一笔「赠送积分」流水</span>
          </div>
        </el-form-item>
        <el-form-item label="有效期">
          <el-checkbox v-model="grant.permanent">永久有效</el-checkbox>
          <el-input-number v-if="!grant.permanent" v-model="grant.days" :min="1" :step="1"
            controls-position="right" class="!ml-3 !w-28" />
          <span v-if="!grant.permanent" class="ml-1 text-xs text-slate-500">天</span>
        </el-form-item>
        <el-form-item label="授予原因" required>
          <el-input v-model="grant.reason" maxlength="200" show-word-limit
            placeholder="例：线下办理年卡，会写入权限日志" />
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false"
        title="授予后 session_version +1，该用户旧登录凭证立即失效；填了积分会同步记一笔积分流水，便于对账。" />
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="grantOpen = false">取消</el-button>
          <el-button type="primary" :loading="granting" @click="doGrant">确认授予</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 新增用户弹窗 -->
    <el-dialog v-model="createOpen" title="新增用户" width="min(620px, 94vw)" top="8vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">账号信息</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="微信号" required>
              <el-input v-model="createForm.wechatId" placeholder="字母开头 6–20 位，登录用" />
            </el-form-item>
            <el-form-item label="昵称" required>
              <el-input v-model="createForm.nickname" placeholder="2–24 个字" maxlength="24" />
            </el-form-item>
            <el-form-item label="初始密码" required>
              <el-input v-model="createForm.password" type="password" show-password
                placeholder="至少 8 位，含字母与数字" />
            </el-form-item>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">会员与积分</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="会员等级">
              <el-select v-model="createForm.level" class="!w-52">
                <el-option label="普通用户（无积分）" value="NONE" />
                <el-option label="VIP" value="VIP" />
                <el-option label="SVIP" value="SVIP" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="createForm.level !== 'NONE'" label="有效期至">
              <el-date-picker v-model="createForm.expireAt" type="date" placeholder="留空 = 永久有效"
                format="YYYY-MM-DD" value-format="YYYY-MM-DD" clearable />
            </el-form-item>
            <el-form-item v-if="createForm.level !== 'NONE'" label="初始积分">
              <el-input-number v-model="createForm.balanceYuan" :min="0" :step="1"
                controls-position="right" class="!w-36" placeholder="0 = 不开户" />
            </el-form-item>
            <el-form-item v-if="createForm.level !== 'NONE'" label="赠送积分">
              <el-input-number v-model="createForm.bonusYuan" :min="0" :step="1"
                controls-position="right" class="!w-36" placeholder="0 = 不赠送" />
            </el-form-item>
          </el-form>
          <el-alert v-if="createForm.level === 'NONE'" type="info" :closable="false"
            title="普通用户没有积分账户，登记后由运营确认名额。需要积分请选 VIP / SVIP。" />
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-1 text-sm font-semibold text-slate-900">后台角色</h4>
          <p class="mb-3 text-xs text-slate-500">不选则该用户只能使用前台；系统维护角色不在后台授予。</p>
          <div class="flex flex-wrap gap-2">
            <button v-for="r in roleOptions" :key="r.value" type="button"
              class="rounded-lg border px-3 py-1.5 text-xs transition"
              :class="createForm.roles.includes(r.value)
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-700'
                : 'border-slate-300 text-slate-600 hover:border-slate-400'"
              @click="toggleRole(r.value)">{{ r.label }}</button>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="createOpen = false">取消</el-button>
          <el-button type="primary" :loading="creating" @click="doCreate">创建用户</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 编辑用户弹窗 -->
    <el-dialog v-model="editOpen" title="编辑用户" width="min(620px, 94vw)" top="8vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">账号信息</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="微信号">
              <el-input :model-value="editTarget?.wechatId" disabled />
            </el-form-item>
            <el-form-item label="昵称">
              <el-input v-model="editForm.nickname" maxlength="24" />
            </el-form-item>
            <el-form-item label="账号状态">
              <el-select v-model="editForm.status" class="!w-52">
                <el-option label="正常" value="ACTIVE" />
                <el-option label="冻结（禁止登录）" value="FROZEN" />
              </el-select>
            </el-form-item>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">会员与积分</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="会员等级">
              <el-select v-model="editForm.level" class="!w-52">
                <el-option label="普通用户（无积分）" value="NONE" />
                <el-option label="VIP" value="VIP" />
                <el-option label="SVIP" value="SVIP" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="editForm.level !== 'NONE'" label="有效期至">
              <el-date-picker v-model="editForm.expireAt" type="date" placeholder="留空 = 永久有效"
                format="YYYY-MM-DD" value-format="YYYY-MM-DD" clearable />
            </el-form-item>
          </el-form>
          <el-alert type="info" :closable="false"
            title="改等级会结束当前会员记录并按新等级重建；积分账户不会被清空。" />
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-1 text-sm font-semibold text-slate-900">后台角色</h4>
          <p class="mb-3 text-xs text-slate-500">不选则该用户只能使用前台；系统维护角色不在后台授予。</p>
          <div class="flex flex-wrap gap-2">
            <button v-for="r in roleOptions" :key="r.value" type="button"
              class="rounded-lg border px-3 py-1.5 text-xs transition"
              :class="editForm.roles.includes(r.value)
                ? 'border-blue-500 bg-blue-50 font-medium text-blue-700'
                : 'border-slate-300 text-slate-600 hover:border-slate-400'"
              @click="toggleEditRole(r.value)">{{ r.label }}</button>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="editOpen = false">取消</el-button>
          <el-button type="primary" :loading="updating" @click="doUpdate">保存修改</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 导入弹窗 -->
    <el-dialog v-model="importOpen" title="批量导入会员" width="min(960px, 94vw)" top="6vh" destroy-on-close>
      <!-- 上传 -->
      <div v-if="stage === 'upload'">
        <div
          class="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center transition"
          :class="dragging ? 'border-blue-400 bg-blue-50/50' : ''"
          @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
          <p class="text-sm font-medium text-slate-700">把 Excel 拖到这里，或选择文件</p>
          <p class="text-xs text-slate-500">.xlsx / .xls / .csv，≤5MB、≤2000 行</p>
          <label class="mt-2 cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            {{ parsing ? '解析中…' : '选择文件' }}
            <input type="file" accept=".xlsx,.xls,.csv" class="hidden" :disabled="parsing" @change="onPick" />
          </label>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-xl border border-slate-200 p-3">
            <p class="mb-1.5 text-xs font-semibold text-slate-700">必填列</p>
            <p class="text-xs leading-relaxed text-slate-500">微信号（字母开头 6–20 位，唯一）、昵称（2–24 字）</p>
          </div>
          <div class="rounded-xl border border-slate-200 p-3">
            <p class="mb-1.5 text-xs font-semibold text-slate-700">选填列</p>
            <p class="text-xs leading-relaxed text-slate-500">会员等级（VIP/SVIP）、有效期至、积分、赠送积分、备注</p>
          </div>
        </div>
        <p class="mt-3 text-xs text-slate-500">表头名称的大小写、空格、括号差异都能识别；不确定就先点右上角「下载模板」。</p>
      </div>

      <!-- 预览 -->
      <div v-else-if="stage === 'preview' && preview">
        <div class="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{{ fileName }}</span>
          <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700">可导入 {{ preview.ok }}</span>
          <span class="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700">有提示 {{ preview.warn }}</span>
          <span class="rounded-full bg-rose-50 px-2.5 py-1 text-xs text-rose-700">不可导入 {{ preview.error }}</span>
          <span class="text-xs text-slate-500">共 {{ preview.total }} 行</span>
          <el-button class="ml-auto" size="small" @click="stage = 'upload'; preview = null">重新选择</el-button>
        </div>

        <div v-for="msg in preview.fatal" :key="msg" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ msg }}</div>
        <div v-if="preview.unknownColumns.length" class="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          未识别的列将被忽略：{{ preview.unknownColumns.join('、') }}
        </div>

        <div class="max-h-[46vh] overflow-auto rounded-xl border border-slate-200">
          <table class="w-full text-left text-xs">
            <thead class="sticky top-0 bg-slate-50 text-slate-500">
              <tr>
                <th class="px-3 py-2 font-medium">行</th>
                <th class="px-3 py-2 font-medium">昵称</th>
                <th class="px-3 py-2 font-medium">微信号</th>
                <th class="px-3 py-2 font-medium">等级</th>
                <th class="px-3 py-2 font-medium">有效期</th>
                <th class="px-3 py-2 font-medium">积分</th>
                <th class="px-3 py-2 font-medium">赠送</th>
                <th class="px-3 py-2 font-medium">状态</th>
                <th class="px-3 py-2 font-medium">提示</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in preview.rows" :key="r.row" class="border-t border-slate-100 align-top">
                <td class="px-3 py-2 text-slate-500">{{ r.row }}</td>
                <td class="px-3 py-2 font-medium text-slate-800">
                  {{ r.nickname || '—' }}
                  <span v-if="r.exists" class="ml-1 rounded bg-slate-100 px-1 text-[11px] text-slate-500">已存在</span>
                </td>
                <td class="px-3 py-2 font-mono text-slate-600">{{ r.wechatId }}</td>
                <td class="px-3 py-2 text-slate-600">{{ r.level === 'NONE' ? '—' : r.level }}</td>
                <td class="px-3 py-2 text-slate-600">{{ r.expireAt ? new Date(r.expireAt).toLocaleDateString('zh-CN') : '—' }}</td>
                <td class="px-3 py-2 text-slate-600">{{ r.balanceCent == null ? '—' : points(r.balanceCent) }}</td>
                <td class="px-3 py-2 text-slate-600">{{ r.bonusCent == null ? '—' : points(r.bonusCent) }}</td>
                <td class="px-3 py-2">
                  <span class="rounded-full px-2 py-0.5 text-xs" :class="rowStatus[r.status]?.cls">{{ rowStatus[r.status]?.label }}</span>
                </td>
                <td class="px-3 py-2 text-slate-500">
                  <span v-for="(m, i) in r.messages" :key="i" class="block">{{ m }}</span>
                </td>
              </tr>
              <tr v-if="!preview.rows.length">
                <td colspan="9" class="px-3 py-10 text-center text-slate-500">没有解析到数据行</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-4 rounded-xl bg-slate-50 px-3 py-2.5">
          <el-checkbox v-model="overwrite">覆盖已存在的会员（不勾选则跳过）</el-checkbox>
          <el-checkbox v-model="strict">严格模式（任一行失败整批回滚）</el-checkbox>
          <span v-if="preview.error" class="text-xs text-rose-600">{{ preview.error }} 行有错误将被跳过</span>
        </div>
      </div>

      <!-- 结果 -->
      <div v-else-if="stage === 'done' && result" class="space-y-3">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-xl border border-slate-200 p-3 text-center">
            <p class="text-xs text-slate-500">新建</p><p class="mt-1 text-xl font-semibold text-slate-900">{{ result.created }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 p-3 text-center">
            <p class="text-xs text-slate-500">更新</p><p class="mt-1 text-xl font-semibold text-slate-900">{{ result.updated }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 p-3 text-center">
            <p class="text-xs text-slate-500">跳过</p><p class="mt-1 text-xl font-semibold text-slate-900">{{ result.skipped }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 p-3 text-center">
            <p class="text-xs text-slate-500">失败</p>
            <p class="mt-1 text-xl font-semibold" :class="result.failed ? 'text-rose-600' : 'text-slate-900'">{{ result.failed }}</p>
          </div>
        </div>

        <div v-if="result.credentials.length" class="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p class="text-xs font-medium text-amber-800">新建账号临时密码（只显示这一次）</p>
          <div class="mt-1 max-h-40 overflow-auto rounded-lg bg-white/70 px-2 py-1.5 font-mono text-xs text-amber-900">
            <p v-for="c in result.credentials" :key="c.wechatId" class="flex justify-between gap-3 py-0.5">
              <span>{{ personLabel(c.nickname, c.wechatId) }}</span><span>{{ c.temporaryPassword }}</span>
            </p>
          </div>
          <p class="mt-1 text-xs text-amber-700">
            请逐个转告会员；临时密码每批随机生成，首次登录会强制修改密码后才能继续使用。
          </p>
        </div>

        <div v-if="result.errors.length" class="rounded-xl border border-rose-200 p-3">
          <p class="mb-1.5 text-sm font-medium text-rose-700">失败明细</p>
          <ul class="space-y-1 text-xs text-slate-600">
            <li v-for="e in result.errors" :key="`${e.row}-${e.wechatId}`">第 {{ e.row }} 行 · {{ personLabel(e.nickname, e.wechatId) }}：{{ e.reason }}</li>
          </ul>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="importOpen = false">{{ stage === 'done' ? '关闭' : '取消' }}</el-button>
          <el-button v-if="stage === 'preview'" type="primary" :loading="committing" :disabled="!importableRows.length" @click="commit">
            确认导入 {{ importableRows.length }} 行
          </el-button>
          <el-button v-if="stage === 'done'" @click="openImport">再导一批</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 重置密码结果：临时密码只显示这一次 -->
    <el-dialog :model-value="!!resetResult" title="密码已重置" width="min(440px, 94vw)" :close-on-click-modal="false" @close="resetResult = null">
      <div v-if="resetResult" class="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <p class="text-xs font-medium text-amber-800">「{{ personLabel(resetResult.nickname, resetResult.wechatId) }}」的临时密码（只显示这一次）</p>
        <p class="mt-0.5 font-mono text-base text-amber-900">{{ resetResult.temporaryPassword }}</p>
        <p class="mt-1 text-xs text-amber-700">请通过可靠渠道转告用户，并提醒登录后尽快修改；原密码与旧会话已失效。</p>
      </div>
      <template #footer>
        <el-button type="primary" @click="resetResult = null">我已记录，关闭</el-button>
      </template>
    </el-dialog>
  </section>
</template>
