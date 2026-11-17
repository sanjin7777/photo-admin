<script setup lang="ts">
/**
 * 权限与治理：审计日志 / 权限日志 / 脱敏导出。
 * 这三项只有运维账号具备能力（admin:audit:read / admin:permission:log:read / admin:export），
 * 菜单本身也要求 admin:audit:read，所以普通管理员根本进不来；页内再按能力过滤，防止以后放宽菜单后越权。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { useUiStore } from '../stores/ui';
import ResponsiveTable from '../components/ResponsiveTable.vue';
import { AUDIT_ACTION, TARGET_TYPE, personLabel } from '../utils/labels';

const ui = useUiStore();
const session = useSessionStore();

const tab = ref('');
const auditRows = ref<Array<Record<string, unknown>>>([]);
const permissionRows = ref<Array<Record<string, unknown>>>([]);
const auditTotal = ref(0);
const permissionTotal = ref(0);
const auditKeyword = ref('');
const auditAction = ref('');
const permissionKeyword = ref('');

const columns = [
  { key: 'id', label: 'ID' }, { key: 'action', label: '动作' }, { key: 'target', label: '对象' },
  { key: 'actor', label: '操作人' }, { key: 'created', label: '时间' },
];

/** 导出对象用中文名展示，避免运营面对英文表名 */
const EXPORT_TARGETS = [
  { target: 'registrations', label: '报名记录', hint: '微信号、场次、时段、状态、金额' },
  { target: 'refunds', label: '退款单', hint: '报名编号、金额、审核状态' },
  { target: 'balance_transactions', label: '积分流水', hint: '方向、金额、业务来源' },
  { target: 'audit_logs', label: '审计日志', hint: '动作、对象、操作人、时间' },
] as const;

/** Tab 与能力一一对应；没有能力就不渲染，而不是渲染后点进去 403 */
const tabs = computed(() =>
  [
    { name: 'audit', label: '审计日志', cap: 'admin:audit:read' as const },
    { name: 'permissions', label: '权限日志', cap: 'admin:permission:log:read' as const },
    { name: 'export', label: '脱敏导出', cap: 'admin:export' as const },
  ].filter((t) => session.can(t.cap)),
);

async function load(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  if (session.can('admin:audit:read')) {
    tasks.push((async () => {
      const logs = await api.admin.audit.logs({
        pageSize: 100,
        keyword: auditKeyword.value.trim() || undefined,
        action: auditAction.value || undefined,
      });
      auditTotal.value = logs.total;
      auditRows.value = logs.list.map((l) => ({
        id: l.id,
        action: AUDIT_ACTION[l.action] ?? l.action,
        // 对象列：targetType==='user' 时服务端 join 出了对方昵称，直接显示；
        // 其它实体（场次/报名/退款…）的 target_id 指向不同表，只能退化成 #id
        target: l.targetNickname || l.targetWechatId
          ? `${TARGET_TYPE[l.targetType] ?? l.targetType} ${personLabel(l.targetNickname, l.targetWechatId, l.targetId)}`
          : `${TARGET_TYPE[l.targetType] ?? l.targetType}${l.targetId ? ` #${l.targetId}` : ''}`,
        actor: l.actorId ? personLabel(l.actorNickname, l.actorWechatId, l.actorId) : '系统',
        created: new Date(l.createdAt).toLocaleString('zh-CN'),
      }));
    })());
  }
  if (session.can('admin:permission:log:read')) {
    tasks.push((async () => {
      const perms = await api.admin.audit.permissions({
        pageSize: 100,
        keyword: permissionKeyword.value.trim() || undefined,
      });
      permissionTotal.value = perms.total;
      permissionRows.value = perms.list.map((p) => ({
        id: p.id,
        action: AUDIT_ACTION[p.action] ?? p.action,
        // 权限日志的对象一定是"某个用户"，服务端 join 了 target users，这里直接给昵称
        target: `${TARGET_TYPE[p.targetType] ?? p.targetType} ${
          personLabel(p.targetNickname, p.targetWechatId, p.targetId)
        }`,
        actor: p.actorId ? personLabel(p.actorNickname, p.actorWechatId, p.actorId) : '系统',
        created: new Date(p.createdAt).toLocaleString('zh-CN'),
      }));
    })());
  }
  try {
    await Promise.all(tasks);
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '加载失败');
  }
}

onMounted(async () => {
  tab.value = tabs.value[0]?.name ?? '';
  await load();
});

async function exportCsv(target: string): Promise<void> {
  try {
    const res = await api.admin.exports({ target });
    const a = document.createElement('a');
    a.href = res.url; a.download = `${target}.csv`; a.click();
    ui.notify('导出已生成（已记审计日志）', 'success');
  } catch (e) {
    ui.notify(e instanceof Error ? e.message : '导出失败');
  }
}
</script>

<template>
  <section>
    <div class="mb-4">
      <h1 class="text-xl font-semibold text-slate-900">权限与治理</h1>
      <p class="mt-1 text-sm text-slate-500">
        系统维护功能。审计日志记录全站写操作；权限日志记录会员授予/撤销与角色变更；导出走字段白名单。
      </p>
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane v-for="t in tabs" :key="t.name" :label="t.label" :name="t.name">
        <div v-if="t.name === 'audit'">
          <el-form inline class="mb-3 rounded-xl border border-slate-200 bg-white p-3">
            <el-form-item label="动作">
              <el-select v-model="auditAction" placeholder="全部动作" clearable class="!w-44" @change="load">
                <el-option v-for="(label, key) in AUDIT_ACTION" :key="key" :label="label" :value="key" />
              </el-select>
            </el-form-item>
            <el-form-item label="关键词">
              <el-input v-model="auditKeyword" placeholder="操作人微信号 / 对象类型 / 对象 ID"
                clearable class="!w-72" @keyup.enter="load" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="load">查询</el-button>
            </el-form-item>
            <el-form-item>
              <span class="text-xs text-slate-500">共 {{ auditTotal }} 条（显示最近 100 条）</span>
            </el-form-item>
          </el-form>
          <ResponsiveTable :rows="auditRows" :columns="columns" />
        </div>
        <div v-else-if="t.name === 'permissions'">
          <el-form inline class="mb-3 rounded-xl border border-slate-200 bg-white p-3">
            <el-form-item label="关键词">
              <el-input v-model="permissionKeyword" placeholder="操作人 / 被授予人微信号"
                clearable class="!w-72" @keyup.enter="load" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="load">查询</el-button>
            </el-form-item>
            <el-form-item>
              <span class="text-xs text-slate-500">共 {{ permissionTotal }} 条（显示最近 100 条）</span>
            </el-form-item>
          </el-form>
          <ResponsiveTable :rows="permissionRows" :columns="columns" />
        </div>
        <div v-else class="max-w-xl space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p class="text-sm text-slate-700">
            导出走字段白名单，不含手机号、邮箱、联系方式与审计明细；每次导出写审计日志。
          </p>
          <div class="grid gap-2 sm:grid-cols-2">
            <button v-for="t2 in EXPORT_TARGETS" :key="t2.target" type="button"
              class="rounded-lg border border-slate-300 px-3 py-2 text-left transition hover:border-blue-400 hover:bg-blue-50/40"
              @click="exportCsv(t2.target)">
              <span class="block text-sm text-slate-800">{{ t2.label }}</span>
              <span class="mt-0.5 block text-xs text-slate-500">{{ t2.hint }}</span>
            </button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <p v-if="!tabs.length" class="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      当前账号没有审计、权限日志或导出的权限，请联系系统维护人员。
    </p>
  </section>
</template>
