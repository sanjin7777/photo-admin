/**
 * 会话保活 / 无操作到期状态机（点5，前端专用、框架无关）。
 *
 * 设计：
 * - 活跃时每隔 refreshIntervalMs 主动续期一次 access，避免「操作到一半突然 401」；
 * - 无操作达 warnAfterMs 进入 warned，回调 onWarn(剩余秒数) 让 UI 弹「即将登出」；
 * - warned 期间用户任意操作 / 点「保持登录」即回到 active 并续期；
 * - 无操作累计达 warnAfterMs + graceMs 进入 expired，回调 onLogout 由 UI 清态跳登录。
 *
 * 不在内部起定时器：由调用方（Vue composable）按固定节拍调用 tick()，
 * 时钟也可注入，便于在 verify 里用假时钟确定性测试。
 */
import { ACCESS_TOKEN_TTL_SECONDS, SESSION_IDLE_GRACE_SECONDS, SESSION_IDLE_WARN_SECONDS } from '../constants';

export type IdlePhase = 'active' | 'warned' | 'expired';

export interface IdleTrackerOptions {
  /** 可注入时钟（毫秒），默认 Date.now */
  now?: () => number;
  /** 活跃态主动续期间隔；默认 access 时效减 1 小时 */
  refreshIntervalMs?: number;
  /** 无操作多久后开始告警；默认 SESSION_IDLE_WARN_SECONDS */
  warnAfterMs?: number;
  /** 告警后再无操作多久登出；默认 SESSION_IDLE_GRACE_SECONDS */
  graceMs?: number;
  onRefresh: () => void;
  onWarn: (secondsLeft: number) => void;
  /** 由用户操作从 warned 回到 active 时触发（用于收起提示） */
  onKeepAlive?: () => void;
  onLogout: () => void;
}

export interface IdleTracker {
  /** 用户任意交互：重置无操作计时；若正在告警则收起 */
  activity(): void;
  /** 显式「保持登录」：重置计时并立即续期 */
  keepAlive(): void;
  /** 由外部节拍驱动（如每 30 秒） */
  tick(): void;
  readonly phase: IdlePhase;
  readonly secondsLeft: number;
}

export function createIdleTracker(options: IdleTrackerOptions): IdleTracker {
  const now = options.now ?? (() => Date.now());
  const refreshIntervalMs = options.refreshIntervalMs ?? Math.max(60_000, (ACCESS_TOKEN_TTL_SECONDS - 3600) * 1000);
  const warnAfterMs = options.warnAfterMs ?? SESSION_IDLE_WARN_SECONDS * 1000;
  const graceMs = options.graceMs ?? SESSION_IDLE_GRACE_SECONDS * 1000;

  let lastActivity = now();
  let lastRefresh = now();
  let phase: IdlePhase = 'active';
  let secondsLeft = 0;

  function activity(): void {
    if (phase === 'expired') return;
    lastActivity = now();
    if (phase === 'warned') {
      phase = 'active';
      secondsLeft = 0;
      options.onKeepAlive?.();
    }
  }

  function keepAlive(): void {
    if (phase === 'expired') return;
    lastActivity = now();
    lastRefresh = now();
    phase = 'active';
    secondsLeft = 0;
    options.onRefresh();
  }

  function tick(): void {
    if (phase === 'expired') return;
    const t = now();
    const idle = t - lastActivity;
    if (idle >= warnAfterMs + graceMs) {
      phase = 'expired';
      secondsLeft = 0;
      options.onLogout();
      return;
    }
    if (idle >= warnAfterMs) {
      phase = 'warned';
      secondsLeft = Math.max(0, Math.ceil((warnAfterMs + graceMs - idle) / 1000));
      options.onWarn(secondsLeft);
      return;
    }
    if (phase === 'warned') {
      phase = 'active';
      secondsLeft = 0;
    }
    if (t - lastRefresh >= refreshIntervalMs) {
      lastRefresh = t;
      options.onRefresh();
    }
  }

  return {
    activity,
    keepAlive,
    tick,
    get phase() { return phase; },
    get secondsLeft() { return secondsLeft; },
  };
}