/**
 * DB 行 → 响应 DTO。脱敏在这一层完成：联系方式、密码哈希、内部备注永不外泄。
 * dateStrings=true 下 DATETIME 为 UTC 字面值，统一转 ISO 8601。
 */
import type { RowDataPacket } from 'mysql2/promise';
import type {
  AuditLogDto,
  BalanceAccountDto,
  BalanceTransactionDto,
  EventDto,
  EventPriceDto,
  EventSessionDto,
  MembershipDto,
  ModelMeasurements,
  ModelProfileDto,
  Paginated,
  PermissionLogDto,
  RefundOrderDto,
  RefundPolicy,
  RegistrationDto,
  SceneDto,
  VoteCampaignDto,
  VoteOptionDto,
  VoteResultDto,
} from '@photo/shared';
import type { BackendRole, EventVisibility, MemberLevel, PaidLevel } from '@photo/shared';
import type { CouponDto } from '@photo/shared';
import { fromSqlDateTime } from '../utils/datetime';

const iso = (v: Date | string | null): string =>
  v == null ? new Date(0).toISOString() : fromSqlDateTime(v as Date | string).toISOString();

export interface EventRow extends RowDataPacket {
  id: string; title: string; subtitle: string | null; description: string | null;
  cover_url: string | null; poster_urls: unknown; wardrobe_urls: unknown;
  venue: string; scene: string | null; notice: string | null;
  ratio_label: string | null; model_count: number; allow_proxy_shoot: number;
  private_booking_note: string | null; model_id: string | null;
  /** 关联场景库（020）；旧数据 / 未 select 时兜底 null */
  scene_id?: string | null;
  registration_open_at: string; registration_close_at: string; start_at: string; end_at: string;
  visibility: EventVisibility;
  /** 人工报名门槛（019）；旧数据 / 未 select 时兜底 NONE */
  register_min_level?: MemberLevel;
  fee_cent: string; capacity: number; capacity_used: number;
  allow_coupon: number; refund_policy: RefundPolicy; status: string; version: number;
  created_at: string; updated_at: string;
}

export interface RegistrationRow extends RowDataPacket {
  id: string; event_id: string; session_id: string | null; user_id: string; status: string;
  payment_status: string;
  /** 报名来源列（018）；旧数据 / 未 select 时由 mapper 兜底 ONLINE */
  source?: string;
  fee_cent: string;
  original_fee_cent: string; discount_cent: string; coupon_id: string | null;
  refund_policy_snapshot: RefundPolicy; balance_txn_id: string | null;
  cancel_reason: string | null; created_at: string; updated_at: string;
  /** 后台列表 join users 回填 */
  user_wechat_id?: string | null;
  /** 列表 join events / event_sessions 回填的展示字段 */
  event_title?: string | null;
  session_label?: string | null;
  session_start_at?: string | null;
  /** 后台列表 join event_sessions 的完整时段列，用于余位/已满展示 */
  session_end_at?: string | null;
  session_capacity?: number | null;
  session_capacity_used?: number | null;
  session_status?: string | null;
  session_sort_no?: number | null;
  /** join coupons 回填的券面标题 */
  coupon_title?: string | null;
}

/**
 * JSON 列里的图片 URL 数组。
 * mysql2 默认会把 JSON 列解析成数组，但当连接使用了 jsonStrings 或列内容异常时
 * 可能拿到字符串，这里统一兜底，避免图片字段被静默解析成空数组（页面裂图）。
 */
const asUrlArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }
  return [];
};

export function sessionDtoOf(r: RowDataPacket): EventSessionDto {
  return {
    id: String(r.id), eventId: String(r.event_id), label: r.label,
    startAt: iso(r.start_at), endAt: iso(r.end_at),
    capacity: Number(r.capacity), capacityUsed: Number(r.capacity_used),
    status: r.status as EventSessionDto['status'], sort: Number(r.sort_no),
  };
}

export function priceDtoOf(r: RowDataPacket): EventPriceDto {
  return {
    level: r.level, priceCent: Number(r.price_cent),
    unitLabel: r.unit_label ?? '场',
  };
}

/** 后台报名列表 join event_sessions 的完整列 → 时段 DTO；未 join 或旧数据返回 null */
export function joinedSessionDtoOf(r: RegistrationRow): EventSessionDto | null {
  if (!r.session_id || r.session_label == null) return null;
  return {
    id: String(r.session_id), eventId: String(r.event_id), label: r.session_label,
    startAt: iso(r.session_start_at ?? null), endAt: iso(r.session_end_at ?? null),
    capacity: Number(r.session_capacity ?? 0), capacityUsed: Number(r.session_capacity_used ?? 0),
    status: (r.session_status ?? 'OPEN') as EventSessionDto['status'],
    sort: Number(r.session_sort_no ?? 0),
  };
}

/**
 * 兼容字段推导：startAt/endAt/feeCent/capacity 由时段与价格汇总，
 * 保持旧前端与旧数据可用；新前端应优先读 sessions / prices。
 */
export function eventDtoOf(
  r: EventRow,
  model: ModelProfileDto | null = null,
  sessions: EventSessionDto[] = [],
  prices: EventPriceDto[] = [],
): EventDto {
  const sorted = [...sessions].sort((a, b) => a.sort - b.sort);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const publicPrice = prices.find((p) => p.level === 'PUBLIC');
  const totalCapacity = sorted.length ? sorted.reduce((s, x) => s + x.capacity, 0) : Number(r.capacity);
  const totalUsed = sorted.length ? sorted.reduce((s, x) => s + x.capacityUsed, 0) : Number(r.capacity_used);

  return {
    id: String(r.id), title: r.title, subtitle: r.subtitle ?? null,
    description: r.description, coverUrl: r.cover_url,
    posterUrls: asUrlArray(r.poster_urls), wardrobeUrls: asUrlArray(r.wardrobe_urls),
    venueUrls: asUrlArray(r.venue_urls),
    venue: r.venue, scene: r.scene ?? null, notice: r.notice ?? null,
    ratioLabel: r.ratio_label ?? null, modelCount: Number(r.model_count ?? 1),
    allowProxyShoot: Boolean(r.allow_proxy_shoot), privateBookingNote: r.private_booking_note ?? null,
    modelId: r.model_id ? String(r.model_id) : null, model,
    sceneId: r.scene_id ? String(r.scene_id) : null,
    registrationOpenAt: iso(r.registration_open_at), registrationCloseAt: iso(r.registration_close_at),
    startAt: first ? first.startAt : iso(r.start_at),
    endAt: last ? last.endAt : iso(r.end_at),
    visibility: r.visibility,
    registerMinLevel: (r.register_min_level ?? 'NONE') as MemberLevel,
    feeCent: publicPrice ? publicPrice.priceCent : Number(r.fee_cent),
    capacity: totalCapacity, capacityUsed: totalUsed,
    allowCoupon: Boolean(r.allow_coupon),
    refundPolicy: r.refund_policy ?? { freeCancelBeforeHours: 24, feeRatio: 0 },
    status: r.status as EventDto['status'], version: Number(r.version),
    sessions: sorted, prices,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function registrationDtoOf(
  r: RegistrationRow,
  event: EventDto | null = null,
  session: EventSessionDto | null = null,
): RegistrationDto {
  const feeCent = Number(r.fee_cent);
  // 旧数据（迁移前）original_fee_cent 为 0 时按实付兜底，避免出现「原价 0」
  const originalFeeCent = r.original_fee_cent == null || Number(r.original_fee_cent) === 0
    ? feeCent
    : Number(r.original_fee_cent);
  return {
    id: String(r.id), eventId: String(r.event_id),
    sessionId: r.session_id ? String(r.session_id) : null,
    session: session ?? joinedSessionDtoOf(r),
    userId: String(r.user_id),
    userWechatId: r.user_wechat_id ? String(r.user_wechat_id) : null,
    eventTitle: r.event_title ?? event?.title ?? null,
    sessionLabel: r.session_label ?? session?.label ?? null,
    sessionStartAt: r.session_start_at ? iso(r.session_start_at) : session?.startAt ?? null,
    status: r.status as RegistrationDto['status'],
    paymentStatus: r.payment_status as RegistrationDto['paymentStatus'],
    source: (r.source ?? 'ONLINE') as RegistrationDto['source'],
    feeCent, originalFeeCent,
    discountCent: Math.max(0, originalFeeCent - feeCent),
    couponId: r.coupon_id ? String(r.coupon_id) : null,
    couponTitle: r.coupon_title ?? null,
    refundPolicySnapshot: r.refund_policy_snapshot,
    balanceTxnId: r.balance_txn_id ? String(r.balance_txn_id) : null,
    cancelReason: r.cancel_reason, event, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** 优惠券实例。EXPIRED 由 expires_at 动态判定，不落库。 */
export function couponDtoOf(r: RowDataPacket): CouponDto {
  const rawStatus = r.status as CouponDto['status'];
  const expiredAt = r.expires_at == null ? null : iso(r.expires_at);
  const status: CouponDto['status'] = rawStatus === 'UNUSED' && expiredAt && Date.parse(expiredAt) <= Date.now()
    ? 'EXPIRED'
    : rawStatus;
  return {
    id: String(r.id),
    title: String(r.title),
    type: r.type,
    discountBp: r.discount_bp == null ? null : Number(r.discount_bp),
    amountCent: r.amount_cent == null ? null : Number(r.amount_cent),
    minSpendCent: Number(r.min_spend_cent ?? 0),
    maxDiscountCent: r.max_discount_cent == null ? null : Number(r.max_discount_cent),
    expiresAt: expiredAt,
    status,
    usedRegistrationId: r.used_registration_id ? String(r.used_registration_id) : null,
    usedAt: r.used_at ? iso(r.used_at) : null,
    note: r.note == null ? null : String(r.note),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** JSON 列在 mysql2 里可能是 string 也可能是 object，统一成数组 */
function jsonArrayOf(value: unknown): Array<Record<string, unknown>> {
  if (value == null) return [];
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
    } catch { return []; }
  }
  return [];
}

/**
 * 三围 JSON 列 → DTO。mysql2 可能给 object 也可能给 string，统一兜底。
 * 三个值全空时返回 null（前端按「未填写」处理，不展示空三围）。
 */
function measurementsOf(value: unknown): ModelMeasurements | null {
  let obj: unknown = value;
  if (typeof value === 'string') {
    try { obj = JSON.parse(value); } catch { return null; }
  }
  if (obj == null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bustCm = num(rec.bustCm);
  const waistCm = num(rec.waistCm);
  const hipCm = num(rec.hipCm);
  if (bustCm == null && waistCm == null && hipCm == null) return null;
  return { bustCm, waistCm, hipCm };
}

/**
 * 模特档案 DTO。
 * @param includeBody 是否输出身高/三围等敏感身体数据。
 *   公开端按「当前用户是否 VIP/SVIP」传入；后台管理端恒为 true。
 *   默认 false（安全兜底）：漏传时宁可少展示，也不泄露敏感数据。
 */
export function modelDtoOf(r: RowDataPacket, includeBody = false): ModelProfileDto {
  return {
    id: String(r.id),
    // 纯资料模特没有登录账号
    userId: r.user_id == null ? null : String(r.user_id),
    boundWechatId: r.bound_wechat_id == null ? null : String(r.bound_wechat_id),
    stageName: r.stage_name,
    heightCm: includeBody && r.height_cm != null ? Number(r.height_cm) : null,
    measurements: includeBody ? measurementsOf(r.measurements_json) : null,
    portfolioUrl: r.portfolio_url ?? null,
    photoUrls: jsonArrayOf(r.photo_urls).map((v) => String(v)).filter(Boolean),
    socialAccounts: jsonArrayOf(r.social_accounts).map((s) => ({
      platform: String(s.platform ?? 'OTHER') as ModelProfileDto['socialAccounts'][number]['platform'],
      handle: String(s.handle ?? ''),
      url: s.url == null ? null : String(s.url),
    })).filter((s) => s.handle),
    portraitAuthStatus: r.portrait_auth_status,
    portraitAuthExpireAt: r.portrait_auth_expire_at ? iso(r.portrait_auth_expire_at) : null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** 场景库档案 DTO（点4）。照片走 asUrlArray 兜底，避免裂图。 */
export function sceneDtoOf(r: RowDataPacket): SceneDto {
  return {
    id: String(r.id),
    venue: r.venue ?? '',
    name: r.name,
    address: r.address ?? null,
    description: r.description ?? null,
    photoUrls: asUrlArray(r.photo_urls),
    capacity: r.capacity == null ? null : Number(r.capacity),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function balanceAccountDtoOf(r: RowDataPacket): BalanceAccountDto {
  return {
    userId: String(r.user_id), availableCent: Number(r.available_cent),
    frozenCent: Number(r.frozen_cent), bonusGrantedCent: Number(r.bonus_granted_cent ?? 0),
    version: Number(r.version), updatedAt: iso(r.updated_at),
  };
}

export function balanceTxnDtoOf(r: RowDataPacket): BalanceTransactionDto {
  return {
    id: String(r.id), accountUserId: String(r.account_user_id),
    accountWechatId: r.account_wechat_id ? String(r.account_wechat_id) : null,
    direction: r.direction,
    amountCent: Number(r.amount_cent), balanceAfterCent: Number(r.balance_after_cent),
    bizType: r.biz_type, bizId: String(r.biz_id),
    originTxnId: r.origin_txn_id ? String(r.origin_txn_id) : null,
    operatorId: r.operator_id ? String(r.operator_id) : null, remark: r.remark ?? null,
    createdAt: iso(r.created_at),
  };
}

export function membershipDtoOf(r: RowDataPacket): MembershipDto {
  return {
    id: String(r.id), userId: String(r.user_id), level: r.level as PaidLevel, status: r.status,
    startAt: iso(r.start_at), expireAt: iso(r.expire_at), source: r.source,
    grantedBy: r.granted_by ? String(r.granted_by) : null, grantReason: r.grant_reason ?? null,
    revokedBy: r.revoked_by ? String(r.revoked_by) : null,
    revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function refundDtoOf(r: RowDataPacket): RefundOrderDto {
  return {
    id: String(r.id), registrationId: String(r.registration_id), amountCent: Number(r.amount_cent),
    reason: r.reason ?? null, status: r.status, requestedBy: String(r.requested_by),
    requesterWechatId: r.requester_wechat_id ?? null,
    requesterNickname: r.requester_nickname ?? null,
    eventId: r.event_id == null ? null : String(r.event_id),
    eventTitle: r.event_title ?? null,
    sessionId: r.session_id == null ? null : String(r.session_id),
    sessionLabel: r.session_label ?? null,
    sessionStartAt: r.session_start_at ? iso(r.session_start_at) : null,
    sessionEndAt: r.session_end_at ? iso(r.session_end_at) : null,
    paymentStatus: r.reg_payment_status ? (r.reg_payment_status as RefundOrderDto['paymentStatus']) : null,
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    reviewedAt: r.reviewed_at ? iso(r.reviewed_at) : null, reviewRemark: r.review_remark ?? null,
    balanceTxnId: r.balance_txn_id ? String(r.balance_txn_id) : null,
    settledBy: r.settled_by ? String(r.settled_by) : null,
    settledAt: r.settled_at ? iso(r.settled_at) : null,
    settleRemark: r.settle_remark ?? null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function voteOptionDtoOf(r: RowDataPacket): VoteOptionDto {
  return {
    id: String(r.id), campaignId: String(r.campaign_id), name: r.name,
    imageUrl: r.image_url ?? null, sort: Number(r.sort_no),
  };
}

export function voteCampaignDtoOf(r: RowDataPacket, options: VoteOptionDto[], myOptionId: string | null, model: ModelProfileDto | null = null): VoteCampaignDto {
  return {
    id: String(r.id), eventId: r.event_id == null ? null : String(r.event_id),
    modelId: r.model_id == null ? null : String(r.model_id),
    model, title: r.title,
    openAt: iso(r.open_at), closeAt: iso(r.close_at), status: r.status,
    maxVotesPerUser: Number(r.max_votes_per_user), options,
    resultPublishedAt: r.result_published_at ? iso(r.result_published_at) : null,
    myOptionId, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export function auditDtoOf(r: RowDataPacket): AuditLogDto {
  return {
    id: String(r.id), actorId: r.actor_id ? String(r.actor_id) : null,
    actorWechatId: r.actor_wechat_id ?? null,
    action: r.action, targetType: r.target_type,
    targetId: r.target_id ? String(r.target_id) : null,
    before: r.before_json ?? null, after: r.after_json ?? null,
    ip: r.ip ?? null, ua: r.ua ?? null, traceId: r.trace_id, createdAt: iso(r.created_at),
  };
}

export function permissionLogDtoOf(r: RowDataPacket): PermissionLogDto {
  // permission_logs 只有 target_user_id，没有 audit_logs 的 target_type/target_id；
  // 不显式补齐会让前端拿到 undefined，列表「对象」列显示成 undefined。
  return {
    ...auditDtoOf(r),
    targetType: 'user',
    targetId: r.target_user_id == null ? null : String(r.target_user_id),
    before: null,
    after: null,
    levelBefore: (r.level_before ?? null) as MemberLevel | null,
    levelAfter: (r.level_after ?? null) as MemberLevel | null,
  };
}

export function paginatedOf<T>(list: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { list, total: Number(total), page: Number(page), pageSize: Number(pageSize) };
}

export function pageArgsOf(query: { page?: number; pageSize?: number }): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function rolesOf(rows: RowDataPacket[]): BackendRole[] {
  return rows.map((r) => r.role as BackendRole);
}

export function voteResultDtoOf(
  campaignId: string,
  rows: Array<{ optionId: string; name: string; count: number }>,
  suppressed: boolean,
): VoteResultDto {
  const totalVotes = rows.reduce((sum, r) => sum + r.count, 0);
  return {
    campaignId, totalVotes, suppressed,
    options: rows.map((r) => ({
      optionId: r.optionId, name: r.name,
      voteCount: suppressed ? null : r.count,
      ratio: suppressed || totalVotes === 0 ? null : Number((r.count / totalVotes).toFixed(4)),
    })),
  };
}
