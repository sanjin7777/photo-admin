<script setup lang="ts">
/**
 * 优惠券管理：按微信号发放（可批量）、列表筛选、未使用券作废。
 * 金额在服务端按报名档位价重算，这里只负责券面配置。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { AdminCouponDto, AdminCouponIssuePayload, CouponStatus, CouponType } from '@photo/shared';
import { api } from '../api';
import UserPicker from '../components/UserPicker.vue';
import ResponsiveTable from '../components/ResponsiveTable.vue';
import { useUiStore } from '../stores/ui';
import { yuan } from '../utils/labels';

const ui = useUiStore();

const list = ref<AdminCouponDto[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loading = ref(true);
const statusFilter = ref('');
const keyword = ref('');

const STATUS: Readonly<Record<string, { label: string; cls: string }>> = {
  UNUSED: { label: '未使用', cls: 'bg-emerald-50 text-emerald-700' },
  USED: { label: '已使用', cls: 'bg-slate-100 text-slate-600' },
  EXPIRED: { label: '已过期', cls: 'bg-amber-50 text-amber-700' },
  REVOKED: { label: '已作废', cls: 'bg-rose-50 text-rose-600' },
};
const metaOf = (s: string): { label: string; cls: string } =>
  STATUS[s] ?? { label: s, cls: 'bg-slate-100 text-slate-600' };

const fmt = (v: string | null): string =>
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function faceText(c: AdminCouponDto): string {
  if (c.type === 'AMOUNT') return `立减 ${yuan(Number(c.amountCent ?? 0))}`;
  const rate = (Number(c.discountBp ?? 10000) / 1000).toFixed(1).replace(/\.0$/, '');
  return `${rate} 折${c.maxDiscountCent ? `（最高抵 ${yuan(c.maxDiscountCent)}）` : ''}`;
}

/** 列定义：桌面表格与移动卡片共用，改列只改这一处 */
const columns = [
  { key: 'title', label: '券名称' },
  { key: 'face', label: '类型 / 面额' },
  { key: 'minSpend', label: '门槛', width: 110 },
  { key: 'holder', label: '持有人', width: 150 },
  { key: 'status', label: '状态', width: 100 },
  { key: 'expiresAt', label: '有效期至', width: 150 },
  { key: 'usedAt', label: '使用时间', width: 150 },
  { key: 'actions', label: '操作', width: 90 },
];

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.admin.coupons.list({
      page: page.value,
      pageSize,
      status: (statusFilter.value || undefined) as CouponStatus | undefined,
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

/**
 * 表格行：把 DTO 摊平成可渲染字符串（ResponsiveTable 只认扁平对象），
 * 原始对象挂在 raw 上，操作列（作废）仍需要完整 DTO。
 */
const rows = computed(() => list.value.map((c) => ({
  id: c.id,
  raw: c,
  title: c.title,
  note: c.note,
  type: c.type,
  userWechatId: c.userWechatId,
  userNickname: c.userNickname,
  status: c.status,
  expiresAt: c.expiresAt,
  usedAt: c.usedAt,
  minSpend: c.minSpendCent > 0 ? `满 ${yuan(c.minSpendCent)}` : '无门槛',
  expiresAtText: fmt(c.expiresAt),
  usedAtText: fmt(c.usedAt),
})));
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

/* ---------------- 发券弹窗 ---------------- */
const createOpen = ref(false);
const creating = ref(false);
const form = reactive({
  wechatIds: [] as string[],
  title: '',
  type: 'DISCOUNT' as CouponType,
  /** 折扣输入：8.5 表示 8.5 折 */
  discountRate: 8.5,
  amountYuan: 30,
  minSpendYuan: 0,
  maxDiscountYuan: 0,
  expiresAt: '',
  note: '',
});

function openCreate(): void {
  Object.assign(form, {
    wechatIds: [], title: '', type: 'DISCOUNT', discountRate: 8.5,
    amountYuan: 30, minSpendYuan: 0, maxDiscountYuan: 0, expiresAt: '', note: '',
  });
  createOpen.value = true;
}

const parsedWechatIds = computed(() => [...new Set(form.wechatIds)]);

async function submitCreate(): Promise<void> {
  if (creating.value) return;
  const wechatIds = parsedWechatIds.value;
  if (!wechatIds.length) { ui.notify('请至少选择一位发放对象', 'warning'); return; }
  if (wechatIds.length > 50) { ui.notify('单次最多发放 50 人', 'warning'); return; }
  if (form.title.trim().length < 2) { ui.notify('券名称至少 2 个字符', 'warning'); return; }

  const base: AdminCouponIssuePayload = {
    wechatIds,
    title: form.title.trim(),
    type: form.type,
    minSpendCent: Math.max(0, Math.round(Number(form.minSpendYuan) * 100)),
    ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  };
  let payload: AdminCouponIssuePayload;
  if (form.type === 'DISCOUNT') {
    const bp = Math.round(Number(form.discountRate) * 1000);
    if (bp < 100 || bp > 9999) { ui.notify('折扣需在 1–9.999 折之间', 'warning'); return; }
    const maxCent = Math.round(Number(form.maxDiscountYuan) * 100);
    payload = { ...base, discountBp: bp, ...(maxCent > 0 ? { maxDiscountCent: maxCent } : {}) };
  } else {
    const amountCent = Math.round(Number(form.amountYuan) * 100);
    if (amountCent < 1) { ui.notify('立减金额至少 0.01 元', 'warning'); return; }
    payload = { ...base, amountCent };
  }

  creating.value = true;
  try {
    const res = await api.admin.coupons.issue(payload);
    ui.notify(`已发放 ${res.created} 张优惠券`, 'success');
    createOpen.value = false;
    page.value = 1;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    creating.value = false;
  }
}

async function revoke(row: AdminCouponDto): Promise<void> {
  try {
    await ui.confirm(`确认作废「${row.title}」？作废后 ${row.userWechatId} 将无法再使用该券。`);
  } catch {
    return;
  }
  try {
    await api.admin.coupons.revoke(row.id);
    ui.notify('已作废', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">优惠券</h1>
        <p class="mt-0.5 text-xs text-slate-500">
          券全场通用，不绑定场次；场次里关闭「允许使用优惠券」后该场新报名不可用券。每个名额最多用 1 张。
        </p>
      </div>
      <button
        class="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500/30 active:scale-[0.98]"
        @click="openCreate"
      >
        <span aria-hidden="true" class="text-base leading-none">+</span>
        发放优惠券
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <select v-model="statusFilter" class="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" @change="search">
        <option value="">全部状态</option>
        <option value="UNUSED">未使用</option>
        <option value="USED">已使用</option>
        <option value="EXPIRED">已过期</option>
        <option value="REVOKED">已作废</option>
      </select>
      <input v-model="keyword" class="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        placeholder="搜索微信号 / 昵称 / 券名称" @keyup.enter="search" />
      <button class="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" @click="search">查询</button>
    </div>

    <!-- 桌面表格 / 移动卡片共用一份列定义：手机横滚 8 列根本没法看 -->
    <ResponsiveTable :rows="rows" :columns="columns" :show-toolbar="false"
      :empty-text="loading ? '加载中…' : '暂无优惠券，点击右上角「发放优惠券」创建'">
      <template #cell="{ row, column }">
        <template v-if="column.key === 'title'">
          <p class="font-medium text-slate-900">{{ row.title }}</p>
          <p v-if="row.note" class="max-w-[12rem] truncate text-xs text-slate-500" :title="String(row.note)">{{ row.note }}</p>
        </template>
        <template v-else-if="column.key === 'face'">
          <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{{ row.type === 'DISCOUNT' ? '折扣券' : '立减券' }}</span>
          <span class="ml-1.5">{{ faceText(row.raw as AdminCouponDto) }}</span>
        </template>
        <template v-else-if="column.key === 'minSpend'">
          {{ row.minSpend }}
        </template>
        <template v-else-if="column.key === 'holder'">
          <p class="text-slate-700">{{ row.userWechatId }}</p>
          <p class="text-xs text-slate-500">{{ row.userNickname || '—' }}</p>
        </template>
        <template v-else-if="column.key === 'status'">
          <span class="rounded-full px-2 py-0.5 text-xs" :class="metaOf(String(row.status)).cls">{{ metaOf(String(row.status)).label }}</span>
        </template>
        <template v-else-if="column.key === 'expiresAt'">
          {{ row.expiresAtText }}
        </template>
        <template v-else-if="column.key === 'usedAt'">
          {{ row.usedAtText }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <button v-if="row.status === 'UNUSED'" class="text-xs text-rose-600 hover:underline" @click="revoke(row.raw as AdminCouponDto)">作废</button>
          <span v-else class="text-xs text-slate-300">—</span>
        </template>
      </template>
      <!-- 移动端卡片：券名 + 面额 + 持有人 + 有效期，状态徽章贴右上 -->
      <template #card="{ row }">
        <div class="card p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="clamp-1 font-medium text-slate-900">{{ row.title }}</p>
              <p v-if="row.note" class="clamp-1 text-xs text-slate-500">{{ row.note }}</p>
              <p class="mt-0.5 text-xs text-slate-600">
                {{ row.type === 'DISCOUNT' ? '折扣券' : '立减券' }} · {{ faceText(row.raw as AdminCouponDto) }}
                <span class="text-slate-500">· {{ row.minSpend }}</span>
              </p>
              <p class="mt-0.5 text-xs text-slate-600">{{ row.userWechatId }}<span v-if="row.userNickname" class="text-slate-500"> · {{ row.userNickname }}</span></p>
              <p class="text-xs text-slate-500">
                {{ row.expiresAt ? `有效期至 ${row.expiresAtText}` : '长期有效' }}
                <span v-if="row.usedAt"> · 已用于 {{ row.usedAtText }}</span>
              </p>
            </div>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="metaOf(String(row.status)).cls">{{ metaOf(String(row.status)).label }}</span>
          </div>
          <div class="mt-2">
            <button v-if="row.status === 'UNUSED'" class="text-xs text-rose-600 hover:underline" @click="revoke(row.raw as AdminCouponDto)">作废</button>
            <span v-else class="text-xs text-slate-300">—</span>
          </div>
        </div>
      </template>
    </ResponsiveTable>

    <div class="flex items-center justify-end gap-3 text-xs text-slate-500">
      <span>共 {{ total }} 张 · 第 {{ page }} / {{ pageCount }} 页</span>
      <button class="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40" :disabled="page <= 1" @click="goPage(-1)">上一页</button>
      <button class="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40" :disabled="page >= pageCount" @click="goPage(1)">下一页</button>
    </div>

    <!-- 发券弹窗 -->
    <div v-if="createOpen" class="fixed inset-0 z-[150] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
      <div class="absolute inset-0" @click="createOpen = false"></div>
      <div class="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-float ring-1 ring-slate-200 sm:rounded-2xl">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold text-slate-900">发放优惠券</h3>
          <button class="text-slate-500 hover:text-slate-700" @click="createOpen = false">✕</button>
        </div>

        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="mb-1 block text-xs text-slate-500">发放对象（下拉多选，最多 50 人）</span>
            <UserPicker v-model="form.wechatIds" multiple :max="50" placeholder="搜索微信号或昵称，可多选" />
            <span class="mt-1 block text-xs text-slate-500">已选 {{ parsedWechatIds.length }} 人；每个用户各生成一张独立券。</span>
          </label>

          <label class="block">
            <span class="mb-1 block text-xs text-slate-500">券名称</span>
            <input v-model="form.title" maxlength="32" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例如：11 月活动 85 折券" />
          </label>

          <div class="flex gap-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <label class="flex items-center gap-1.5">
              <input v-model="form.type" type="radio" value="DISCOUNT" class="text-brand focus:ring-brand/30" /> 折扣券
            </label>
            <label class="flex items-center gap-1.5">
              <input v-model="form.type" type="radio" value="AMOUNT" class="text-brand focus:ring-brand/30" /> 立减券
            </label>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <label v-if="form.type === 'DISCOUNT'" class="block">
              <span class="mb-1 block text-xs text-slate-500">折扣（8.5 = 8.5 折）</span>
              <input v-model.number="form.discountRate" type="number" min="1" max="9.999" step="0.1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label v-else class="block">
              <span class="mb-1 block text-xs text-slate-500">立减金额（元）</span>
              <input v-model.number="form.amountYuan" type="number" min="0.01" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-slate-500">最低消费（元，0 = 无门槛）</span>
              <input v-model.number="form.minSpendYuan" type="number" min="0" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
            <label v-if="form.type === 'DISCOUNT'" class="block">
              <span class="mb-1 block text-xs text-slate-500">最高优惠封顶（元，0 = 不封顶）</span>
              <input v-model.number="form.maxDiscountYuan" type="number" min="0" step="1" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </label>
          </div>

          <label class="block">
            <span class="mb-1 block text-xs text-slate-500">有效期至（选填，留空为长期有效）</span>
            <input v-model="form.expiresAt" type="datetime-local" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs text-slate-500">备注（选填）</span>
            <input v-model="form.note" maxlength="200" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例如：双十一回馈" />
          </label>

          <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
            折扣券在报名时的档位价（会员价/活动价）基础上打折；一次报名 N 个名额最多用 N 张券，
            券数不足时其余名额按原价。退款完成后退回，未过期可再次使用。
          </p>
        </div>

        <div class="mt-5 flex gap-2">
          <button class="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" @click="createOpen = false">取消</button>
          <button class="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50" :disabled="creating" @click="submitCreate">
            {{ creating ? '发放中…' : '确认发放' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
