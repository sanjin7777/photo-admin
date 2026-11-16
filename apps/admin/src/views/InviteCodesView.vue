<script setup lang="ts">
/**
 * 邀请码管理：列表优先 + 弹窗批量生成。
 * 明文只在「生成」响应里返回一次，页面提供单条复制与整批复制；
 * 列表从库里读，已使用的码保留记录以便追溯新用户来源。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { InviteCodeCreatePayload, InviteCodeDto } from '@photo/shared';
import { api } from '../api';
import ResponsiveTable from '../components/ResponsiveTable.vue';
import AppPagination from '../components/AppPagination.vue';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();

const list = ref<InviteCodeDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(true);
const statusFilter = ref('');
const keyword = ref('');

const STATUS: Readonly<Record<string, { label: string; cls: string }>> = {
  UNUSED: { label: '未使用', cls: 'bg-emerald-50 text-emerald-700' },
  USED: { label: '已使用', cls: 'bg-slate-100 text-slate-600' },
  REVOKED: { label: '已作废', cls: 'bg-rose-50 text-rose-600' },
};
const metaOf = (s: string): { label: string; cls: string } =>
  STATUS[s] ?? { label: s, cls: 'bg-slate-100 text-slate-600' };
const fmt = (v: string | null): string =>
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

/** 列定义：桌面表格与移动卡片共用 */
const columns = [
  { key: 'code', label: '邀请码', width: 150 },
  { key: 'status', label: '状态', width: 100 },
  { key: 'createdBy', label: '生成人', width: 130 },
  { key: 'usedBy', label: '使用人', width: 130 },
  { key: 'usedAt', label: '使用时间', width: 160 },
  { key: 'expiresAt', label: '有效期至', width: 160 },
  { key: 'note', label: '备注', width: 160 },
  { key: 'actions', label: '操作', width: 100 },
];

/**
 * 表格行：DTO 摊平成可渲染字符串（ResponsiveTable 只认扁平对象），
 * 原始对象挂在 raw 上供「作废」使用。
 */
const rows = computed(() => list.value.map((c) => ({
  id: c.id,
  raw: c,
  code: c.code,
  status: c.status,
  createdByWechatId: c.createdByWechatId,
  usedByWechatId: c.usedByWechatId,
  note: c.note,
  createdBy: c.createdByWechatId ?? '—',
  usedBy: c.usedByWechatId ?? '—',
  usedAt: fmt(c.usedAt),
  expiresAt: fmt(c.expiresAt),
  usedAtText: fmt(c.usedAt),
  expiresAtText: fmt(c.expiresAt),
})));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.admin.inviteCodes.list({
      page: page.value,
      pageSize: pageSize.value,
      status: (statusFilter.value || undefined) as InviteCodeDto['status'] | undefined,
      keyword: keyword.value.trim() || undefined,
    });
    list.value = res.list;
    total.value = res.total;
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function search(): void {
  page.value = 1;
  void load();
}
function goPage(delta: number): void {
  const next = page.value + delta;
  if (next < 1 || next > pageCount.value) return;
  page.value = next;
  void load();
}

/** 分页组件回调（绝对页码，已由组件保证合法） */
function goPageTo(next: number): void {
  if (next === page.value) return;
  page.value = next;
  void load();
}

/** 切换每页条数：回到第 1 页，避免页码越界 */
function changePageSize(size: number): void {
  pageSize.value = size;
  page.value = 1;
  void load();
}

/* ---------------- 批量生成弹窗 ---------------- */
const createOpen = ref(false);
const creating = ref(false);
const form = reactive({ count: 5, expiresAt: '', note: '' });
const created = ref<string[]>([]);

function openCreate(): void {
  created.value = [];
  form.count = 5;
  form.expiresAt = '';
  form.note = '';
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  if (creating.value) return;
  if (!Number.isInteger(form.count) || form.count < 1 || form.count > 50) {
    ui.notify('生成数量需为 1–50 之间的整数', 'warning');
    return;
  }
  creating.value = true;
  try {
    const payload: InviteCodeCreatePayload = {
      count: form.count,
      ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    };
    const res = await api.admin.inviteCodes.create(payload);
    created.value = res.codes;
    ui.notify(`已生成 ${res.count} 个邀请码，请及时复制交给用户`, 'success');
    await load();
  } catch {
    // 统一错误提示
  } finally {
    creating.value = false;
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui.notify('已复制到剪贴板', 'success');
  } catch {
    ui.notify('复制失败，请手动选择文本', 'warning');
  }
}

async function revoke(row: InviteCodeDto): Promise<void> {
  try {
    await ui.confirm(`确认作废邀请码 ${row.code}？作废后该码将无法用于注册。`);
  } catch {
    return;
  }
  try {
    await api.admin.inviteCodes.revoke(row.id);
    ui.notify('已作废', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- 标题栏 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">邀请码</h1>
        <p class="mt-0.5 text-xs text-slate-500">用户需凭邀请码注册，一个邀请码仅可使用一次；用户管理里可查看每个新用户的来源邀请码。</p>
      </div>
      <el-button type="primary" @click="openCreate">+ 生成邀请码</el-button>
    </div>

    <!-- 筛选 -->
    <el-form inline class="rounded-xl border border-slate-200 bg-white p-3">
      <el-form-item label="状态">
        <el-select v-model="statusFilter" placeholder="全部状态" clearable class="!w-36" @change="search">
          <el-option label="未使用" value="UNUSED" />
          <el-option label="已使用" value="USED" />
          <el-option label="已作废" value="REVOKED" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键词">
        <el-input v-model="keyword" placeholder="搜索邀请码 / 生成人 / 使用人"
          clearable class="!w-72" @keyup.enter="search" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">查询</el-button>
      </el-form-item>
    </el-form>

    <!-- 桌面表格 / 移动卡片共用一份列定义 -->
    <ResponsiveTable :rows="rows" :columns="columns" :show-toolbar="false"
      :empty-text="loading ? '加载中…' : '暂无邀请码，点击右上角「生成邀请码」创建'">
      <template #cell="{ row, column }">
        <template v-if="column.key === 'code'">
          <span class="font-mono font-medium tracking-wider text-slate-900">{{ row.code }}</span>
        </template>
        <template v-else-if="column.key === 'status'">
          <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(String(row.status)).cls">{{ metaOf(String(row.status)).label }}</span>
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="flex justify-end gap-2 md:justify-start">
            <button class="text-xs text-blue-600 hover:underline" @click="copy(String(row.code))">复制</button>
            <button v-if="row.status === 'UNUSED'" class="text-xs text-rose-600 hover:underline" @click="revoke(row.raw as InviteCodeDto)">作废</button>
          </div>
        </template>
      </template>
      <!-- 移动端卡片：邀请码本身要能一眼看清，操作按钮固定在底部一行 -->
      <template #card="{ row }">
        <div class="card p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-mono text-base font-semibold tracking-widest text-slate-900">{{ row.code }}</p>
              <p class="mt-0.5 text-xs text-slate-600">
                生成人 {{ row.createdByWechatId ?? '—' }}
                <span v-if="row.usedByWechatId"> · 使用人 {{ row.usedByWechatId }}</span>
              </p>
              <p class="text-xs text-slate-500">
                有效期至 {{ row.expiresAtText }}
                <span v-if="row.usedAt"> · 使用于 {{ row.usedAtText }}</span>
              </p>
              <p v-if="row.note" class="mt-0.5 text-xs text-slate-500">{{ row.note }}</p>
            </div>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="metaOf(String(row.status)).cls">{{ metaOf(String(row.status)).label }}</span>
          </div>
          <div class="mt-2 flex gap-4">
            <button class="text-xs text-blue-600 hover:underline" @click="copy(String(row.code))">复制</button>
            <button v-if="row.status === 'UNUSED'" class="text-xs text-rose-600 hover:underline" @click="revoke(row.raw as InviteCodeDto)">作废</button>
          </div>
        </div>
      </template>
    </ResponsiveTable>

    <!-- 分页 -->
    <AppPagination
      :page="page"
      :page-size="pageSize"
      :total="total"
      :hide-on-single-page="true"
      :summary="`共 ${total} 条`"
      @change="(p) => goPageTo(p)"
      @size-change="(s) => changePageSize(s)"
    />

    <!-- 生成弹窗 -->
    <el-dialog v-model="createOpen" title="生成邀请码" width="min(520px, 94vw)" destroy-on-close>
      <el-form v-if="!created.length" label-width="86px" label-position="left">
        <el-form-item label="生成数量">
          <el-input-number v-model="form.count" :min="1" :max="50" controls-position="right"
            class="!w-32" />
          <span class="ml-2 text-xs text-slate-500">1–50 个</span>
        </el-form-item>
        <el-form-item label="有效期">
          <el-date-picker v-model="form.expiresAt" type="datetime" placeholder="留空为长期有效"
            format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DDTHH:mm:ss" clearable class="!w-full" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" maxlength="200" show-word-limit
            placeholder="例如：11 月线下活动发放" />
        </el-form-item>
      </el-form>

      <!-- 生成结果：明文只在这里展示一次 -->
      <div v-if="created.length" class="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-emerald-800">本次生成 {{ created.length }} 个，请复制后交给用户</p>
          <el-button link type="primary" size="small" @click="copy(created.join('\n'))">复制全部</el-button>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <el-tag v-for="code in created" :key="code" type="success" effect="plain"
            class="!cursor-pointer !font-mono !tracking-wider" @click="copy(code)">{{ code }}</el-tag>
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <template v-if="!created.length">
            <el-button @click="createOpen = false">取消</el-button>
            <el-button type="primary" :loading="creating" @click="submitCreate">确认生成</el-button>
          </template>
          <template v-else>
            <el-button @click="created = []">再生成一批</el-button>
            <el-button type="primary" @click="createOpen = false">完成</el-button>
          </template>
        </div>
      </template>
    </el-dialog>
  </div>
</template>
