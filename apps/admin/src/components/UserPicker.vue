<script setup lang="ts">
/**
 * 下拉选人：手动录入报名 / 优惠券发放共用。
 * 数据源 /admin/registrations/users（报名能力即可），运营无会员管理权限也能用。
 */
import { computed, onMounted, ref } from 'vue';
import type { AdminUserOptionDto } from '@photo/shared';
import { api } from '../api';
import { MEMBER_LEVEL, metaOf, personLabel } from '../utils/labels';

const props = withDefaults(defineProps<{
  modelValue: string | string[];
  multiple?: boolean;
  max?: number;
  placeholder?: string;
}>(), {
  multiple: false,
  max: 50,
  placeholder: '搜索微信号或昵称',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | string[]): void;
  (e: 'change', options: AdminUserOptionDto[]): void;
}>();

const options = ref<AdminUserOptionDto[]>([]);
const loading = ref(false);
const cache = new Map<string, AdminUserOptionDto>();

const selectedValues = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : [],
);

/** 已选项必须可见：搜索结果不含它时从缓存补进选项列表 */
const displayOptions = computed(() => {
  const missing: AdminUserOptionDto[] = [];
  for (const v of selectedValues.value) {
    const o = cache.get(v);
    if (o && !options.value.some((x) => x.wechatId === o.wechatId)) missing.push(o);
  }
  return [...missing, ...options.value];
});

async function search(keyword: string): Promise<void> {
  loading.value = true;
  try {
    const rows = await api.admin.registrations.userOptions({ keyword: keyword.trim() || undefined, limit: 50 });
    rows.forEach((r) => cache.set(r.wechatId, r));
    options.value = rows;
  } catch {
    // 统一错误提示
  } finally {
    loading.value = false;
  }
}
onMounted(() => { void search(''); });

function onChange(value: string | string[]): void {
  emit('update:modelValue', value);
  const values = Array.isArray(value) ? value : value ? [value] : [];
  emit('change', values.map((v) => cache.get(v)).filter((o): o is AdminUserOptionDto => Boolean(o)));
}
</script>

<template>
  <el-select
    :model-value="modelValue"
    :multiple="multiple"
    :multiple-limit="multiple ? max : 0"
    filterable
    remote
    :remote-method="search"
    :loading="loading"
    :placeholder="placeholder"
    clearable
    class="w-full"
    @update:model-value="onChange"
  >
    <el-option
      v-for="o in displayOptions"
      :key="o.wechatId"
      :value="o.wechatId"
      :label="personLabel(o.nickname, o.wechatId)"
    >
      <span class="flex items-center gap-2">
        <span>{{ o.nickname || o.wechatId }}</span>
        <span class="text-xs text-slate-500">{{ o.wechatId }}</span>
        <span class="rounded-full px-1.5 py-0.5 text-[11px]" :class="metaOf(MEMBER_LEVEL, o.level).cls">
          {{ metaOf(MEMBER_LEVEL, o.level).label }}
        </span>
        <span v-if="o.status === 'FROZEN'" class="rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600">冻结</span>
      </span>
    </el-option>
  </el-select>
</template>