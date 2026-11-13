/**
 * 会话保活（点5，后台）：登录期间跟踪操作，活跃时主动续期，
 * 长时间无操作弹「即将登出」提示，宽限期结束仍无操作则登出。
 * 在 App.vue 挂载一次；提示用 Element Plus 对话框渲染。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import { createIdleTracker, type IdleTracker } from '@photo/shared/session';
import { http } from '../api';
import { useSessionStore } from '../stores/session';

const TICK_MS = 30_000;
const ACTIVITY_THROTTLE_MS = 1_000;
const LOGIN_PATH = `${import.meta.env.BASE_URL}login`;

export function useIdleSession() {
  const session = useSessionStore();
  const warningOpen = ref(false);
  const secondsLeft = ref(0);

  let tracker: IdleTracker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastEvent = 0;

  const onActivity = (): void => {
    const t = Date.now();
    if (t - lastEvent < ACTIVITY_THROTTLE_MS) return;
    lastEvent = t;
    tracker?.activity();
  };

  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
    events.forEach((e) => window.removeEventListener(e, onActivity));
    tracker = null;
    warningOpen.value = false;
    secondsLeft.value = 0;
  }

  function start(): void {
    stop();
    tracker = createIdleTracker({
      onRefresh: () => { void http.refresh().catch(() => { /* 刷新失败由 http 统一跳登录 */ }); },
      onWarn: (s) => { secondsLeft.value = s; warningOpen.value = true; },
      onKeepAlive: () => { warningOpen.value = false; secondsLeft.value = 0; },
      onLogout: () => {
        warningOpen.value = false;
        session.logout();
        window.location.assign(LOGIN_PATH);
      },
    });
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    timer = setInterval(() => tracker?.tick(), TICK_MS);
  }

  function keepAlive(): void {
    tracker?.keepAlive();
    warningOpen.value = false;
    secondsLeft.value = 0;
  }

  function logoutNow(): void {
    warningOpen.value = false;
    session.logout();
    window.location.assign(LOGIN_PATH);
  }

  watch(() => session.user, (u) => { if (u) start(); else stop(); }, { immediate: true });
  onBeforeUnmount(stop);

  return { warningOpen, secondsLeft, keepAlive, logoutNow };
}