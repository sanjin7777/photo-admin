<script setup lang="ts">
/**
 * 模特管理：经常复用的模特在这里建档，场次编辑时直接下拉选择即可，不用每次填 ID。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { AdminUserListItemDto, ModelProfileDto, ModelSocialAccount, SocialPlatform } from '@photo/shared';
import { modelProfileUpsertSchema, SOCIAL_PLATFORMS } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import { useSessionStore } from '../stores/session';
import ImageUploader from '../components/ImageUploader.vue';
import ResponsiveTable from '../components/ResponsiveTable.vue';
import AppPagination from '../components/AppPagination.vue';
import { SOCIAL_PLATFORM, personLabel } from '../utils/labels';
import { emptyPage, loadAllPages } from '../utils/loadAll';

const ui = useUiStore();
const session = useSessionStore();
const models = ref<ModelProfileDto[]>([]);
const users = ref<AdminUserListItemDto[]>([]);
const loading = ref(true);

const platformOptions = SOCIAL_PLATFORMS.map((p) => ({ value: p, label: SOCIAL_PLATFORM[p] ?? p }));

/* ---------------- 列表：服务端分页 ---------------- */
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

/** 用户选项只需「全部可选账号」，与模特列表分页无关，保持全量 */
async function loadUsers(): Promise<void> {
  // 需要「授予会员」权限；运营/财务没有该权限，不调用，避免 3001
  if (!session.can('admin:membership:grant')) {
    users.value = [];
    return;
  }
  try {
    const u = await loadAllPages((p, size) => api.admin.members.list({ page: p, pageSize: size }));
    users.value = u.list ?? [];
  } catch {
    users.value = [];
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.admin.models.list({ page: page.value, pageSize: pageSize.value });
    // 页码越界（例如删掉最后一页的唯一一条）时回到最后一页重查
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (page.value > lastPage) {
      page.value = lastPage;
      return load();
    }
    models.value = res.list ?? [];
    total.value = res.total;
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}

/** 分页组件回调（页码已由组件保证合法） */
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

onMounted(async () => {
  await Promise.all([load(), loadUsers()]);
});

/** userId → 展示名：优先用服务端下发的绑定昵称，其次微信号，有用户列表时补充 */
const userLabel = computed(() => {
  const map = new Map<string, string>();
  for (const m of models.value) {
    if (m.userId) map.set(m.userId, personLabel(m.boundNickname, m.boundWechatId));
  }
  for (const u of users.value) map.set(u.id, personLabel(u.nickname, u.wechatId, u.id));
  return map;
});

const PORTRAIT_LABEL: Readonly<Record<string, string>> = {
  GRANTED: '已授权',
  PENDING: '待授权',
  EXPIRED: '已过期',
  REVOKED: '已撤销',
};

/**
 * 列表行：把嵌套对象摊平成字符串字段，交给 ResponsiveTable 统一渲染。
 * 原始对象留在 raw 上，操作列（编辑）仍拿得到完整 DTO。
 */
const modelRows = computed(() => models.value.map((m) => ({
  id: m.id,
  raw: m,
  stageName: m.stageName,
  portfolioUrl: m.portfolioUrl,
  bound: m.userId ? (userLabel.value.get(m.userId) ?? personLabel(null, m.boundWechatId, m.userId)) : '纯资料模特',
  socialCount: m.socialAccounts.length,
  socialAccounts: m.socialAccounts,
  portrait: PORTRAIT_LABEL[m.portraitAuthStatus] ?? m.portraitAuthStatus,
})));

const modelColumns = [
  { key: 'stageName', label: '模特名' },
  { key: 'bound', label: '绑定账号' },
  { key: 'social', label: '社交账号' },
  { key: 'portrait', label: '肖像授权' },
  { key: 'actions', label: '操作', width: 100 },
];

/* ---------------- 弹窗 ---------------- */
const dialogOpen = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);

interface SocialDraft { platform: SocialPlatform; handle: string; url: string }

const form = reactive({
  userId: '',
  stageName: '',
  /** el-input-number 需要 number | undefined；undefined 表示未填写 */
  heightCm: undefined as number | undefined,
  bustCm: undefined as number | undefined,
  waistCm: undefined as number | undefined,
  hipCm: undefined as number | undefined,
  portfolioUrl: '',
  photos: [] as string[],
  portraitAuthStatus: 'GRANTED' as 'PENDING' | 'GRANTED' | 'EXPIRED' | 'REVOKED',
  /** 敏感个人信息单独同意（身高/三围） */
  bodyDataConsent: false,
  bodyDataConsentNote: '',
});
/** 编辑态下服务端已有的同意留痕时间，仅用于展示 */
const editingConsentAt = ref<string | null>(null);
const socials = ref<SocialDraft[]>([]);

/** 空串 → null（未填写）；其余转数字，越界/非法由 schema 兜底报错。
 *  type="number" 的 v-model 会被 Vue 自动转成 number，先 String 再 trim。 */
/** 空值 → null（未填写）；其余转数字，越界/非法由 schema 兜底报错。 */
const cmOrNull = (v: number | string | undefined | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};

function openCreate(): void {
  editingId.value = null;
  form.userId = '';
  form.stageName = '';
  form.heightCm = undefined;
  form.bustCm = undefined;
  form.waistCm = undefined;
  form.hipCm = undefined;
  form.portfolioUrl = '';
  form.photos = [];
  form.portraitAuthStatus = 'GRANTED';
  form.bodyDataConsent = false;
  form.bodyDataConsentNote = '';
  editingConsentAt.value = null;
  socials.value = [];
  dialogOpen.value = true;
}

function openEdit(m: ModelProfileDto): void {
  editingId.value = m.id;
  form.userId = m.userId ?? '';
  form.stageName = m.stageName;
  form.heightCm = m.heightCm ?? undefined;
  form.bustCm = m.measurements?.bustCm ?? undefined;
  form.waistCm = m.measurements?.waistCm ?? undefined;
  form.hipCm = m.measurements?.hipCm ?? undefined;
  form.portfolioUrl = m.portfolioUrl ?? '';
  form.photos = [...(m.photoUrls ?? [])];
  form.portraitAuthStatus = m.portraitAuthStatus;
  form.bodyDataConsent = m.bodyDataConsentAt != null;
  form.bodyDataConsentNote = m.bodyDataConsentNote ?? '';
  editingConsentAt.value = m.bodyDataConsentAt ?? null;
  socials.value = (m.socialAccounts ?? []).map((s) => ({
    platform: s.platform, handle: s.handle, url: s.url ?? '',
  }));
  dialogOpen.value = true;
}

function addSocial(): void {
  if (socials.value.length >= 10) { ui.notify('最多 10 个社交账号', 'warning'); return; }
  socials.value.push({ platform: 'DOUYIN', handle: '', url: '' });
}
function removeSocial(i: number): void {
  socials.value.splice(i, 1);
}

async function save(): Promise<void> {
  const payloadSocials: ModelSocialAccount[] = socials.value
    .filter((s) => s.handle.trim())
    .map((s) => ({ platform: s.platform, handle: s.handle.trim(), url: s.url.trim() || null }));

  const parsed = modelProfileUpsertSchema.safeParse({
    ...(form.userId.trim() ? { userId: form.userId.trim() } : {}),
    stageName: form.stageName.trim(),
    heightCm: cmOrNull(form.heightCm),
    measurements: {
      bustCm: cmOrNull(form.bustCm),
      waistCm: cmOrNull(form.waistCm),
      hipCm: cmOrNull(form.hipCm),
    },
    portfolioUrl: form.portfolioUrl.trim() || null,
    photoUrls: form.photos,
    socialAccounts: payloadSocials,
    portraitAuthStatus: form.portraitAuthStatus,
    bodyDataConsent: form.bodyDataConsent,
    bodyDataConsentNote: form.bodyDataConsent ? (form.bodyDataConsentNote.trim() || null) : null,
  });
  if (!parsed.success) { ui.notify(parsed.error.issues[0]?.message ?? '表单校验未通过', 'warning'); return; }

  saving.value = true;
  try {
    await api.admin.models.upsert(editingId.value, parsed.data);
    ui.notify(editingId.value ? '模特资料已更新' : '模特已创建', 'success');
    dialogOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

/** 还没建档案的用户，才出现在「新增模特」的下拉里 */
const selectableUsers = computed(() => {
  const existing = new Set(models.value.map((m) => m.userId).filter(Boolean) as string[]);
  return users.value.filter((u) => !existing.has(u.id));
});
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">模特管理</h1>
        <p class="mt-1 text-sm text-slate-500">
          常用模特在这里建档，新建场次时直接从下拉里选，不用每次填用户 ID。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">+ 新增模特</el-button>
    </div>

    <ResponsiveTable :rows="modelRows" :columns="modelColumns" :show-toolbar="false" empty-text="还没有模特档案">
      <template #cell="{ row, column }">
        <template v-if="column.key === 'stageName'">
          <p class="font-medium text-slate-900">{{ row.stageName }}</p>
          <p v-if="row.portfolioUrl" class="text-xs text-slate-500">有作品集</p>
        </template>
        <template v-else-if="column.key === 'bound'">
          {{ row.bound }}
        </template>
        <template v-else-if="column.key === 'social'">
          <div v-if="row.socialCount" class="flex flex-wrap justify-end gap-1 md:justify-start">
            <span v-for="s in row.socialAccounts as Array<{ platform: string; handle: string }>" :key="s.platform + s.handle"
              class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
              {{ SOCIAL_PLATFORM[s.platform] ?? s.platform }} · {{ s.handle }}
            </span>
          </div>
          <span v-else class="text-xs text-slate-500">未填写</span>
        </template>
        <template v-else-if="column.key === 'portrait'">
          {{ row.portrait }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <el-button size="small" @click="openEdit(row.raw as ModelProfileDto)">编辑</el-button>
        </template>
      </template>
    </ResponsiveTable>

    <AppPagination
      :page="page"
      :page-size="pageSize"
      :total="total"
      :hide-on-single-page="true"
      :summary="`共 ${total} 位模特`"
      @change="(p) => goPageTo(p)"
      @size-change="(s) => changePageSize(s)"
    />

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑模特' : '新增模特'" width="min(680px, 94vw)" top="8vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">基本信息</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="绑定账号">
              <el-select v-if="!editingId" v-model="form.userId" placeholder="不绑定账号（纯资料模特）"
                clearable filterable class="!w-full">
                <el-option v-for="u in selectableUsers" :key="u.id"
                  :label="personLabel(u.nickname, u.wechatId)" :value="u.id" />
              </el-select>
              <el-input v-else :model-value="form.userId ? (userLabel.get(form.userId) ?? form.userId) : '未绑定登录账号'"
                disabled />
            </el-form-item>
            <el-form-item label="模特名" required>
              <el-input v-model="form.stageName" placeholder="例：犬了个牙" clearable />
            </el-form-item>
            <el-form-item label="模特照片">
              <ImageUploader v-model="form.photos" :max="6" cover-hint="第一张用于详情页「模特」图区" />
            </el-form-item>
            <el-form-item label="作品集">
              <el-input v-model="form.portfolioUrl" placeholder="https://…（可留空）" clearable />
            </el-form-item>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-1 text-sm font-semibold text-slate-900">身体数据</h4>
          <p class="mb-3 text-xs text-amber-600">身高与三围属敏感信息，仅 VIP / SVIP 会员在前台可见；普通用户与游客看不到。留空表示不公开该项。</p>
          <el-form label-width="96px" label-position="left">
            <div class="grid gap-3 sm:grid-cols-2">
              <el-form-item label="身高 (cm)">
                <el-input-number v-model="form.heightCm" :min="100" :max="250" controls-position="right"
                  placeholder="例：168" class="!w-36" />
              </el-form-item>
              <el-form-item label="胸围 (cm)">
                <el-input-number v-model="form.bustCm" :min="50" :max="200" controls-position="right"
                  placeholder="选填" class="!w-36" />
              </el-form-item>
              <el-form-item label="腰围 (cm)">
                <el-input-number v-model="form.waistCm" :min="40" :max="200" controls-position="right"
                  placeholder="选填" class="!w-36" />
              </el-form-item>
              <el-form-item label="臀围 (cm)">
                <el-input-number v-model="form.hipCm" :min="50" :max="200" controls-position="right"
                  placeholder="选填" class="!w-36" />
              </el-form-item>
            </div>

            <!-- 敏感个人信息（PIPL 第 28–29 条）：必须单独同意，不能藏在总同意里 -->
            <div class="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <el-checkbox v-model="form.bodyDataConsent">
                已取得本人对身高 / 三围收录与会员端展示的<b>单独同意</b>
              </el-checkbox>
              <div v-if="form.bodyDataConsent" class="mt-2">
                <el-input v-model="form.bodyDataConsentNote" maxlength="200" show-word-limit
                  placeholder="同意方式留痕，例：2026-11-14 微信书面确认" />
              </div>
              <p v-else class="mt-1.5 text-xs text-amber-700">
                未勾选时不应填写身高与三围；已填写的建议先删除或补取同意。
              </p>
              <p v-if="editingId && editingConsentAt" class="mt-1.5 text-xs text-slate-500">
                当前留痕：{{ new Date(editingConsentAt).toLocaleString('zh-CN') }}
              </p>
            </div>
          </el-form>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <div class="mb-1 flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">社交账号</h4>
            <el-button size="small" @click="addSocial">+ 添加账号</el-button>
          </div>
          <p class="mb-3 text-xs text-slate-500">会展示在前台场次详情的模特卡片上；留空则不显示。</p>

          <div v-if="socials.length" class="space-y-2">
            <div v-for="(s, i) in socials" :key="i" class="grid grid-cols-2 items-end gap-2 rounded-lg bg-slate-50 p-2.5 sm:grid-cols-12">
              <div class="col-span-2 sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">平台</span>
                <el-select v-model="s.platform" class="!w-full">
                  <el-option v-for="p in platformOptions" :key="p.value" :label="p.label" :value="p.value" />
                </el-select>
              </div>
              <div class="col-span-2 sm:col-span-4">
                <span class="mb-1 block text-xs text-slate-500">账号 / ID</span>
                <el-input v-model="s.handle" placeholder="catpaw2026" />
              </div>
              <div class="col-span-2 sm:col-span-4">
                <span class="mb-1 block text-xs text-slate-500">主页地址（选填）</span>
                <el-input v-model="s.url" placeholder="https://…" />
              </div>
              <div class="col-span-2 flex justify-end sm:col-span-1">
                <el-button size="small" text type="danger" @click="removeSocial(i)">删</el-button>
              </div>
            </div>
          </div>
          <p v-else class="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
            还没有添加社交账号
          </p>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">肖像授权</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="授权状态">
              <el-select v-model="form.portraitAuthStatus" class="!w-44">
                <el-option label="待授权" value="PENDING" />
                <el-option label="已授权" value="GRANTED" />
                <el-option label="已过期" value="EXPIRED" />
                <el-option label="已撤销" value="REVOKED" />
              </el-select>
            </el-form-item>
          </el-form>
          <p class="text-xs text-slate-500">仅记录凭证状态，实际授权书需线下签署留存。</p>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">{{ editingId ? '保存修改' : '创建模特' }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
