<script setup lang="ts">
/**
 * 场景管理（点4）：可复用拍摄场地档案。
 * 一个「场地」下挂多个「场景」（如 A厅 / 自然光棚），列表按场地分组；地址属场地信息。
 * 新建场次时下拉选择场景，自动带出场地名/场景名/地址/简介/照片；场次仍保留自由文本可再改。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import type { SceneDto } from '@photo/shared';
import { sceneUpsertSchema } from '@photo/shared';
import { api } from '../api';
import { useUiStore } from '../stores/ui';
import ImageUploader from '../components/ImageUploader.vue';
import ResponsiveTable from '../components/ResponsiveTable.vue';
import AppPagination from '../components/AppPagination.vue';
import { loadAllPages } from '../utils/loadAll';

const ui = useUiStore();
const scenes = ref<SceneDto[]>([]);
const loading = ref(true);

/**
 * 列表行：把 SceneDto 摊平成可渲染字段（ResponsiveTable 只认扁平对象），
 * 原始对象挂在 raw 上供「编辑 / 删除」使用。
 */
function sceneRow(s: SceneDto): Record<string, unknown> {
  return {
    id: s.id,
    raw: s,
    name: s.name,
    description: s.description,
    photoUrls: s.photoUrls,
    capacity: s.capacity,
  };
}

const sceneColumns = [
  { key: 'name', label: '场景' },
  { key: 'photos', label: '照片' },
  { key: 'capacity', label: '容纳人数', width: 100 },
  { key: 'actions', label: '操作', width: 140 },
];

/** 按场地名分组：一个场地多个场景；地址取该场地首条场景（同场地应一致） */
const groupedScenes = computed(() => {
  const map = new Map<string, { venue: string; address: string | null; rows: Array<Record<string, unknown>>; count: number }>();
  for (const s of pagedScenes.value) {
    const key = s.venue || '默认场地';
    let g = map.get(key);
    if (!g) { g = { venue: key, address: s.address ?? null, rows: [], count: 0 }; map.set(key, g); }
    g.rows.push(sceneRow(s));
    g.count += 1;
  }
  return [...map.values()];
});
/** 已有场地名，供新建场景时快速复用（datalist），避免同场地拼写不一致 */
const venueNames = computed(() => [...new Set(scenes.value.map((s) => s.venue).filter(Boolean))]);

/**
 * 场景库用**前端分页**而非服务端分页。
 *
 * 原因：列表要按场地名分组渲染（一个场地多个场景），服务端分页会把同一场地
 * 的场景切到不同页，分组被割裂；且 `venueNames`（新建弹窗的场地名复用提示）
 * 需要全部数据。场景库总量很小（几十条），一次拉全再切页更合适。
 */
const page = ref(1);
const pageSize = ref(20);
const total = computed(() => scenes.value.length);
const pagedScenes = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return scenes.value.slice(start, start + pageSize.value);
});

/** 分页组件回调（页码已由组件保证合法） */
function goPageTo(next: number): void {
  if (next === page.value) return;
  page.value = next;
}

/** 切换每页条数：回到第 1 页，避免页码越界 */
function changePageSize(size: number): void {
  pageSize.value = size;
  page.value = 1;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await loadAllPages((page, pageSize) => api.admin.scenes.list({ page, pageSize }));
    scenes.value = res.list ?? [];
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/* ---------------- 弹窗 ---------------- */
const dialogOpen = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);

const form = reactive({
  venue: '',
  name: '',
  address: '',
  description: '',
  photos: [] as string[],
  /** el-input-number 需要 number | undefined；空值用 undefined 表示不填 */
  capacity: undefined as number | undefined,
});

/** 场地名自动补全：复用已有场地名，避免同场地拼写不一致 */
function suggestVenue(query: string, cb: (items: Array<{ value: string }>) => void): void {
  const kw = query.trim().toLowerCase();
  const all = venueNames.value.filter((v) => !kw || v.toLowerCase().includes(kw));
  cb(all.map((v) => ({ value: v })));
}

function openCreate(): void {
  editingId.value = null;
  form.venue = '';
  form.name = '';
  form.address = '';
  form.description = '';
  form.photos = [];
  form.capacity = undefined;
  dialogOpen.value = true;
}

function openEdit(s: SceneDto): void {
  editingId.value = s.id;
  form.venue = s.venue ?? '';
  form.name = s.name;
  form.address = s.address ?? '';
  form.description = s.description ?? '';
  form.photos = [...(s.photoUrls ?? [])];
  form.capacity = s.capacity == null ? undefined : s.capacity;
  dialogOpen.value = true;
}

async function save(): Promise<void> {
  // type="number" 的 v-model 会被 Vue 自动转成 number，先 String 再 trim，避免 .trim 报错
  const cap = String(form.capacity ?? '').trim();
  const parsed = sceneUpsertSchema.safeParse({
    venue: form.venue.trim(),
    name: form.name.trim(),
    address: form.address.trim() || null,
    description: form.description.trim() || null,
    photoUrls: form.photos,
    capacity: cap === '' ? null : Number(cap),
  });
  if (!parsed.success) { ui.notify(parsed.error.issues[0]?.message ?? '表单校验未通过', 'warning'); return; }

  saving.value = true;
  try {
    await api.admin.scenes.upsert(editingId.value, parsed.data);
    ui.notify(editingId.value ? '场景已更新' : '场景已创建', 'success');
    dialogOpen.value = false;
    await load();
  } catch {
    // 统一错误提示
  } finally {
    saving.value = false;
  }
}

async function remove(s: SceneDto): Promise<void> {
  try {
    await ui.confirm(`确认删除场景「${s.name}」？已引用它的场次保留各自的场地快照，不受影响。`);
  } catch {
    return;
  }
  try {
    await api.admin.scenes.remove(s.id);
    ui.notify('场景已删除', 'success');
    await load();
  } catch {
    // 统一错误提示
  }
}
</script>

<template>
  <section>
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900">场景管理</h1>
        <p class="mt-1 text-sm text-slate-500">
          一个场地可挂多个场景（如 A厅 / 自然光棚），按场地分组管理；新建场次时下拉选场景，自动带出场地与照片。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">+ 新增场景</el-button>
    </div>

    <div class="space-y-4">
      <div v-for="g in groupedScenes" :key="g.venue" class="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div class="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-slate-900">{{ g.venue }}</p>
            <p class="truncate text-xs text-slate-500">{{ g.address || '未填地址' }}</p>
          </div>
          <span class="shrink-0 rounded-full bg-slate-200/70 px-2 py-0.5 text-xs text-slate-600">{{ g.count }} 个场景</span>
        </div>

        <ResponsiveTable :rows="g.rows" :columns="sceneColumns" :show-toolbar="false" empty-text="该场地还没有场景">
          <template #cell="{ row, column }">
            <template v-if="column.key === 'name'">
              <p class="font-medium text-slate-900">{{ row.name }}</p>
              <p v-if="row.description" class="line-clamp-1 text-xs text-slate-500">{{ row.description }}</p>
            </template>
            <template v-else-if="column.key === 'photos'">
              <div v-if="(row.photoUrls as string[]).length" class="flex justify-end gap-1 md:justify-start">
                <img v-for="(u, i) in (row.photoUrls as string[]).slice(0, 3)" :key="i" :src="u" alt=""
                  class="h-9 w-9 rounded object-cover ring-1 ring-slate-200" />
                <span v-if="(row.photoUrls as string[]).length > 3" class="self-center text-xs text-slate-500">
                  +{{ (row.photoUrls as string[]).length - 3 }}
                </span>
              </div>
              <span v-else class="text-xs text-slate-500">无</span>
            </template>
            <template v-else-if="column.key === 'capacity'">
              {{ row.capacity ?? '—' }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <div class="flex justify-end gap-2">
                <el-button size="small" @click="openEdit(row.raw as SceneDto)">编辑</el-button>
                <el-button size="small" text type="danger" @click="remove(row.raw as SceneDto)">删除</el-button>
              </div>
            </template>
          </template>
        </ResponsiveTable>
      </div>

      <div v-if="!loading && !scenes.length" class="rounded-xl border border-slate-200 bg-white px-3 py-14 text-center">
        <p class="text-sm text-slate-600">还没有场景档案</p>
        <p class="mt-1 text-xs text-slate-500">点右上角「+ 新增场景」，先填所属场地，再录入场景照片与信息</p>
      </div>

      <AppPagination
        :page="page"
        :page-size="pageSize"
        :total="total"
        :hide-on-single-page="true"
        :summary="`共 ${total} 个场景`"
        @change="(p) => goPageTo(p)"
        @size-change="(s) => changePageSize(s)"
      />
    </div>

    <el-dialog v-model="dialogOpen" :title="editingId ? '编辑场景' : '新增场景'" width="min(680px, 94vw)" top="8vh" destroy-on-close>
      <div class="max-h-[64vh] overflow-y-auto pr-1">
        <section class="rounded-xl border border-slate-200 p-4">
          <h4 class="mb-3 text-sm font-semibold text-slate-900">场地信息</h4>
          <el-form label-width="96px" label-position="left">
            <el-form-item label="所属场地" required>
              <div class="w-full">
                <el-autocomplete v-model="form.venue" :fetch-suggestions="suggestVenue"
                  placeholder="例：猫爪社影棚（一个场地可挂多个场景）" clearable class="!w-full" />
                <span class="mt-1 block text-xs text-slate-500">同一场地下的多个场景填相同场地名即可自动归组。</span>
              </div>
            </el-form-item>
            <el-form-item label="场景名称" required>
              <el-input v-model="form.name" placeholder="例：A 厅 · 自然光棚" clearable />
            </el-form-item>
            <el-form-item label="容纳人数">
              <el-input-number v-model="form.capacity" :min="1" :max="1000" controls-position="right"
                placeholder="例：20" class="!w-40" />
            </el-form-item>
            <el-form-item label="场地地址">
              <el-input v-model="form.address" placeholder="例：成都市武侯区…（可留空）" clearable />
            </el-form-item>
            <el-form-item label="场地简介">
              <el-input v-model="form.description" type="textarea" :rows="3"
                placeholder="自然光棚、可换景、停车方便…（可留空）" />
            </el-form-item>
            <el-form-item label="场地照片">
              <ImageUploader v-model="form.photos" :max="9" cover-hint="第一张用于场次详情页「场地」图区" />
            </el-form-item>
          </el-form>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">{{ editingId ? '保存修改' : '创建场景' }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>