import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

/** 提示走 Element Plus 命令式 Message：/login 独立路由也能显示 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false);
  const tableMode = ref<'table' | 'card'>(localStorage.getItem('photo_admin_table_mode') === 'card' ? 'card' : 'table');
  watch(tableMode, (v) => localStorage.setItem('photo_admin_table_mode', v));
  const message = ref('');
  function notify(text: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    message.value = text;
    ElMessage({ message: text, type, duration: 2600 });
  }
  /** 二次确认：用户点「取消」时抛错，调用方 catch 后 return 即可 */
  async function confirm(text: string, title = '请确认'): Promise<void> {
    await ElMessageBox.confirm(text, title, {
      type: 'warning',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
    });
  }
  return { drawerOpen, tableMode, message, notify, confirm };
});
