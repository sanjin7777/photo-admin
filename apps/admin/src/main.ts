import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './style.css';
import App from './App.vue';
import router from './router';

/**
 * 必须显式传中文 locale：Element Plus 默认是英文，
 * 否则日期选择器会显示 "November"、分页显示 "Go to"，中英文混排。
 */
createApp(App)
  .use(createPinia())
  .use(router)
  .use(ElementPlus, { locale: zhCn })
  .mount('#app');
