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
import { SOCIAL_PLATFORM } from '../utils/labels';
import { emptyPage, loadAllPages } from '../utils/loadAll';

const ui = useUiStore();
const session = useSessionStore();
const models = ref<ModelProfileDto[]>([]);
const users = ref<AdminUserListItemDto[]>([]);
const loading = ref(true);

const platformOptions = SOCIAL_PLATFORMS.map((p) => ({ value: p, label: SOCIAL_PLATFORM[p] ?? p }));

async function load(): Promise<void> {
  loading.value = true;
  try {
    // 用户列表需要「授予会员」权限；运营/财务没有该权限，不调用，避免 3001
    // 服务端单页上限 100：按页拉全量，避免旧模特在列表/下拉里直接消失
    const [m, u] = await Promise.all([
      loadAllPages((page, pageSize) => api.admin.models.list({ page, pageSize }))
        .catch(() => emptyPage<ModelProfileDto>()),
      session.can('admin:membership:grant')
        ? loadAllPages((page, pageSize) => api.admin.members.list({ page, pageSize }))
            .catch(() => emptyPage<AdminUserListItemDto>())
        : Promise.resolve(emptyPage<AdminUserListItemDto>()),
    ]);
    models.value = m.list ?? [];
    users.value = u.list ?? [];
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** userId → 微信号：优先用服务端下发的绑定微信号，有用户列表时补充昵称 */
const userLabel = computed(() => {
  const map = new Map<string, string>();
  for (const m of models.value) {
    if (m.userId && m.boundWechatId) map.set(m.userId, m.boundWechatId);
  }
  for (const u of users.value) map.set(u.id, `${u.wechatId}（${u.nickname}）`);
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
  bound: m.userId ? (userLabel.value.get(m.userId) ?? `#${m.userId}`) : '纯资料模特',
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
  heightCm: '',
  bustCm: '',
  waistCm: '',
  hipCm: '',
  portfolioUrl: '',
  photos: [] as string[],
  portraitAuthStatus: 'GRANTED' as 'PENDING' | 'GRANTED' | 'EXPIRED' | 'REVOKED',
});
const socials = ref<SocialDraft[]>([]);

/** 空串 → null（未填写）；其余转数字，越界/非法由 schema 兜底报错。
 *  type="number" 的 v-model 会被 Vue 自动转成 number，先 String 再 trim。 */
const cmOrNull = (v: string | number): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};

function openCreate(): void {
  editingId.value = null;
  form.userId = '';
  form.stageName = '';
  form.heightCm = '';
  form.bustCm = '';
  form.waistCm = '';
  form.hipCm = '';
  form.portfolioUrl = '';
  form.photos = [];
  form.portraitAuthStatus = 'GRANTED';
  socials.value = [];
  dialogOpen.value = true;
}

function openEdit(m: ModelProfileDto): void {
  editingId.value = m.id;
  form.userId = m.userId ?? '';
  form.stageName = m.stageName;
  form.heightCm = m.heightCm == null ? '' : String(m.heightCm);
  form.bustCm = m.measurements?.bustCm == null ? '' : String(m.measurements.bustCm);
  form.waistCm = m.measurements?.waistCm == null ? '' : String(m.measurements.waistCm);
  form.hipCm = m.measurements?.hipCm == null ? '' : String(m.measurements.hipCm);
  form.portfolioUrl = m.portfolioUrl ?? '';
  form.photos = [...(m.photoUrls ?? [])];
  form.portraitAuthStatus = m.portraitAuthStatus;
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

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑模特' : '新增模特'" width="min(680px, 94vw)" top="8vh" destroy-on-close>
      <div class="max-h-[64vh] space-y-4 overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">基本信息</h4>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">绑定登录账号（选填）</span>
              <select v-if="!editingId" v-model="form.userId"
                class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
                <option value="">不绑定账号（纯资料模特）</option>
                <option v-for="u in selectableUsers" :key="u.id" :value="u.id">{{ u.wechatId }}（{{ u.nickname }}）</option>
              </select>
              <input v-else :value="form.userId ? (userLabel.get(form.userId) ?? form.userId) : '未绑定登录账号'" disabled
                class="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">模特名 <i class="text-rose-500">*</i></span>
              <input v-model="form.stageName" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：犬了个牙" />
            </label>
            <div class="sm:col-span-2">
              <p class="mb-1.5 text-xs font-medium text-slate-600">模特照片</p>
              <ImageUploader v-model="form.photos" :max="6" cover-hint="第一张用于详情页「模特」图区" />
            </div>
            <label class="block sm:col-span-2">
              <span class="mb-1 block text-xs font-medium text-slate-600">作品集地址</span>
              <input v-model="form.portfolioUrl" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="https://…（可留空）" />
            </label>
          </div>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-1 text-sm font-semibold text-slate-900">身体数据</h4>
          <p class="mb-3 text-xs text-amber-600">身高与三围属敏感信息，仅 VIP / SVIP 会员在前台可见；普通用户与游客看不到。留空表示不公开该项。</p>
          <div class="grid gap-3 sm:grid-cols-4">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">身高 (cm)</span>
              <input v-model="form.heightCm" type="number" min="100" max="250" inputmode="numeric"
                class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="例：168" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">胸围 (cm)</span>
              <input v-model="form.bustCm" type="number" min="50" max="200" inputmode="numeric"
                class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="选填" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">腰围 (cm)</span>
              <input v-model="form.waistCm" type="number" min="40" max="200" inputmode="numeric"
                class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="选填" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-600">臀围 (cm)</span>
              <input v-model="form.hipCm" type="number" min="50" max="200" inputmode="numeric"
                class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="选填" />
            </label>
          </div>
        </section>

        <section class="rounded-xl border border-slate-200 p-4">
          <div class="mb-1 flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">社交账号</h4>
            <el-button size="small" @click="addSocial">+ 添加账号</el-button>
          </div>
          <p class="mb-3 text-xs text-slate-500">会展示在前台场次详情的模特卡片上；留空则不显示。</p>

          <div v-if="socials.length" class="space-y-2">
            <div v-for="(s, i) in socials" :key="i" class="grid grid-cols-2 items-end gap-2 rounded-lg bg-slate-50 p-2.5 sm:grid-cols-12">
              <label class="col-span-2 block sm:col-span-3">
                <span class="mb-1 block text-xs text-slate-500">平台</span>
                <select v-model="s.platform" class="w-full rounded border border-slate-300 px-2 py-1.5 text-sm">
                  <option v-for="p in platformOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
                </select>
              </label>
              <label class="col-span-2 block sm:col-span-4">
                <span class="mb-1 block text-xs text-slate-500">账号 / ID</span>
                <input v-model="s.handle" class="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" placeholder="catpaw2026" />
              </label>
              <label class="col-span-2 block sm:col-span-4">
                <span class="mb-1 block text-xs text-slate-500">主页地址（选填）</span>
                <input v-model="s.url" class="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" placeholder="https://…" />
              </label>
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
          <label class="block sm:w-1/2">
            <span class="mb-1 block text-xs font-medium text-slate-600">授权状态</span>
            <select v-model="form.portraitAuthStatus" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500">
              <option value="PENDING">待授权</option>
              <option value="GRANTED">已授权</option>
              <option value="EXPIRED">已过期</option>
              <option value="REVOKED">已撤销</option>
            </select>
          </label>
          <p class="mt-2 text-xs text-slate-500">仅记录凭证状态，实际授权书需线下签署留存。</p>
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
