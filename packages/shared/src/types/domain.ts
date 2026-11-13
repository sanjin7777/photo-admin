/**
 * 服务端响应 DTO（输出契约）。
 *
 * 请求体类型一律由 `@photo/shared/schemas` 的 Zod schema 用 z.infer 推导，
 * 此处不重复手写，避免前后端校验规则漂移。
 * 所有输出均已在服务端序列化层按角色脱敏：模特联系方式、余额流水操作人等敏感字段
 * 不出现在公开响应中。
 */
import type { BackendRole, EventVisibility, MemberLevel, PaidLevel } from '../roles';
import type { Capability } from '../capabilities';
import type {
  AuditAction,
  BalanceBizType,
  BalanceTxnDirection,
  CouponStatus,
  CouponType,
  EventStatus,
  MembershipStatus,
  PaymentStatus,
  PortraitAuthStatus,
  RefundStatus,
  RegistrationSource,
  RegistrationStatus,
  SessionStatus,
  UserStatus,
  VoteCampaignStatus,
} from '../enums';
import type { Cent, Id, ISODateTime, Paginated, RefundPolicy, Timestamps } from './common';

/* ---------------- 认证 / 用户 ---------------- */
export interface UserDto extends Timestamps {
  id: Id;
  /** 微信号：登录唯一标识，不可重复 */
  wechatId: string;
  nickname: string;
  avatarUrl: string | null;
  status: UserStatus;
  /** 服务端按当前时间计算后的有效等级，不是会员表里的历史记录 */
  level: MemberLevel;
  backendRoles: BackendRole[];
  sessionVersion: number;
  emailMasked: string | null;
  /** Excel 导入账号首次登录须先改密；为 true 时前端只允许进入修改密码页 */
  mustChangePassword: boolean;
}

/**
 * httpsOnly Cookie 模式：登录/刷新**不再把 token 放进响应体**，
 * 服务端通过 Set-Cookie 下发（HttpOnly + Secure + SameSite），JS 永远接触不到凭证。
 */
export interface LoginResultDto {
  user: UserDto;
  /** access cookie 有效期（秒） */
  expiresIn: number;
}

export interface RefreshResultDto {
  expiresIn: number;
}

/** 前端仅用于渲染；后端每个接口独立鉴权，不以此为准 */
export interface CapabilitiesDto {
  capabilities: Capability[];
  level: MemberLevel;
  backendRoles: BackendRole[];
  sessionVersion: number;
  issuedAt: ISODateTime;
}

/* ---------------- 会员 ---------------- */
export interface MembershipDto extends Timestamps {
  id: Id;
  userId: Id;
  level: PaidLevel;
  status: MembershipStatus;
  startAt: ISODateTime;
  expireAt: ISODateTime;
  source: 'GRANT' | 'RENEWAL';
  grantedBy: Id | null;
  grantReason: string | null;
  revokedBy: Id | null;
  revokedAt: ISODateTime | null;
}

/* ---------------- 余额账本 ---------------- */
export interface BalanceAccountDto {
  userId: Id;
  availableCent: Cent;
  frozenCent: Cent;
  /** 累计赠送积分（分）：由 BONUS 入账流水求和派生，不单独占余额桶 */
  bonusGrantedCent: Cent;
  version: number;
  updatedAt: ISODateTime;
}

/**
 * 余额视图：仅 VIP/SVIP 有账户。
 * applicable=false 时前端不得展示余额区块（普通用户无积分账户），直接隐藏、不做开通引导（点D），避免「¥0.00」误导。
 */
export interface BalanceViewDto {
  applicable: boolean;
  account: BalanceAccountDto | null;
}

/** append-only 流水；amountCent 恒为正数，方向由 direction 表达 */
export interface BalanceTransactionDto {
  id: Id;
  accountUserId: Id;
  /** 账户所属用户微信号（后台列表 join users 回填，便于认出是谁） */
  accountWechatId: string | null;
  direction: BalanceTxnDirection;
  amountCent: Cent;
  balanceAfterCent: Cent;
  bizType: BalanceBizType;
  bizId: Id;
  originTxnId: Id | null;
  operatorId: Id | null;
  remark: string | null;
  createdAt: ISODateTime;
}

export type BalanceTransactionPage = Paginated<BalanceTransactionDto>;

/** 后台积分流水查询：按业务类型与关键词筛，筛选下推 SQL */
export interface AdminBalanceTxnListQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  bizType?: BalanceBizType;
  keyword?: string;
  /** 流水时间范围（含首含尾的自然日，YYYY-MM-DD） */
  dateFrom?: string;
  dateTo?: string;
}

/* ---------------- 模特 ---------------- */
/** 公开资料 DTO：刻意不包含联系方式 */
/** 模特可对外展示的社交平台 */
export const SOCIAL_PLATFORMS = ['DOUYIN', 'XIAOHONGSHU', 'BILIBILI', 'WEIBO', 'INSTAGRAM', 'OTHER'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface ModelSocialAccount {
  platform: SocialPlatform;
  /** 账号名或 ID，如 catpaw2026 */
  handle: string;
  /** 完整主页地址，可空；有值时前台做成可点击链接 */
  url: string | null;
}

/** 模特身体数据（敏感）：仅 VIP/SVIP 会员可见，公开 DTO 对普通用户/游客置 null */
export interface ModelMeasurements {
  /** 胸围 cm */
  bustCm: number | null;
  /** 腰围 cm */
  waistCm: number | null;
  /** 臀围 cm */
  hipCm: number | null;
}

export interface ModelProfileDto extends Timestamps {
  /** 模特档案 ID（独立于用户，场次的 modelId 指向它） */
  id: Id;
  /** 绑定的登录用户；纯资料模特为 null */
  userId: Id | null;
  /** 绑定账号的微信号（服务端 join 带出），供无会员列表权限的角色显示 */
  boundWechatId: string | null;
  stageName: string;
  /** 身高（敏感）：仅会员可见，普通用户/游客为 null */
  heightCm: number | null;
  /** 三围（敏感）：仅会员可见，普通用户/游客为 null */
  measurements: ModelMeasurements | null;
  portfolioUrl: string | null;
  /** 模特照片（多图），详情页「模特」图区 */
  photoUrls: string[];
  /** 社交账号；空数组表示未填写 */
  socialAccounts: ModelSocialAccount[];
  portraitAuthStatus: PortraitAuthStatus;
  portraitAuthExpireAt: ISODateTime | null;
}

/* ---------------- 场次 ---------------- */
/** 活动时段：一场活动可有多段，容量与时间以时段为准 */
/** 报名时的时段冲突项：用于前端二次确认弹窗 */
export interface ScheduleConflictDto {
  registrationId: Id;
  eventId: Id;
  eventTitle: string;
  sessionLabel: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
}

export interface EventSessionDto {
  id: Id;
  eventId: Id;
  label: string;
  startAt: ISODateTime;
  endAt: ISODateTime;
  capacity: number;
  capacityUsed: number;
  status: SessionStatus;
  sort: number;
}

/** 分档价格；PUBLIC 即非会员价 */
export interface EventPriceDto {
  level: EventVisibility;
  priceCent: Cent;
  unitLabel: string;
}

export interface EventDto extends Timestamps {
  id: Id;
  title: string;
  subtitle: string | null;
  description: string | null;
  coverUrl: string | null;
  /** 宣传海报多图，详情页轮播 */
  posterUrls: string[];
  /** 当日服装图 */
  wardrobeUrls: string[];
  /** 场地照片，详情页「场地」图区 */
  venueUrls: string[];
  venue: string;
  scene: string | null;
  /** 报名须知：迟到、取消、退款等规则 */
  notice: string | null;
  /** 人数比文案，如 4V1 */
  ratioLabel: string | null;
  modelCount: number;
  allowProxyShoot: boolean;
  privateBookingNote: string | null;
  modelId: Id | null;
  model: ModelProfileDto | null;
  /** 关联场景库（点4）；仅引用，场地展示仍用本场次自己的 venue/scene/venueUrls 快照 */
  sceneId: Id | null;
  registrationOpenAt: ISODateTime;
  registrationCloseAt: ISODateTime;
  /** 兼容字段：等于最早时段的起止时间 */
  startAt: ISODateTime;
  endAt: ISODateTime;
  visibility: EventVisibility;
  /** 人工报名门槛（点2）：此刻允许报名的最低会员等级，运营手动从 SVIP→VIP→NONE 逐步放开；与可见性独立 */
  registerMinLevel: MemberLevel;
  /** 兼容字段：等于 PUBLIC 档价格 */
  feeCent: Cent;
  capacity: number;
  capacityUsed: number;
  /** 该场次是否允许使用优惠券（关闭后仅拦截新报名） */
  allowCoupon: boolean;
  refundPolicy: RefundPolicy;
  status: EventStatus;
  version: number;
  sessions: EventSessionDto[];
  prices: EventPriceDto[];
}

/** 余量查询：不返回其他用户信息 */
export interface EventAvailabilityDto {
  eventId: Id;
  capacity: number;
  capacityUsed: number;
  remaining: number;
  canRegister: boolean;
  /** 不可报名时的业务码，供前端做升级/充值引导 */
  reasonCode: number | null;
}

export type EventPage = Paginated<EventDto>;

/* ---------------- 场景库（点4） ---------------- */
/** 可复用的拍摄场地档案；新增场次时下拉选择，自动带出照片与信息 */
export interface SceneDto extends Timestamps {
  id: Id;
  /** 所属场地（一个场地多个场景，按此名分组） */
  venue: string;
  name: string;
  address: string | null;
  description: string | null;
  /** 场地照片数组 */
  photoUrls: string[];
  /** 容纳人数（可空） */
  capacity: number | null;
}

export type ScenePage = Paginated<SceneDto>;

/* ---------------- 报名 ---------------- */
export interface RegistrationDto extends Timestamps {
  id: Id;
  eventId: Id;
  /** 报名绑定的时段；旧数据可能为空 */
  sessionId: Id | null;
  session: EventSessionDto | null;
  userId: Id;
  /** 后台列表回填的微信号，便于运营按微信号找人 */
  userWechatId: string | null;
  /** 关联场次名称（列表 join events 回填，避免只看到 #id） */
  eventTitle: string | null;
  /** 关联时段名称（列表 join event_sessions 回填） */
  sessionLabel: string | null;
  /** 关联时段开始时间（列表 join event_sessions 回填） */
  sessionStartAt: ISODateTime | null;
  status: RegistrationStatus;
  /** 会员用余额（NOT_REQUIRED）；非会员线下支付（UNPAID → PAID） */
  paymentStatus: PaymentStatus;
  /** 报名来源：ONLINE=前台自助报名；MANUAL=后台手动录入（线下报名） */
  source: RegistrationSource;
  /** 实付金额：使用优惠券后为折后金额 */
  feeCent: Cent;
  /** 报名时的档位原价（未用券时等于 feeCent） */
  originalFeeCent: Cent;
  /** 本单优惠金额 = originalFeeCent - feeCent */
  discountCent: Cent;
  couponId: Id | null;
  /** 后台/我的报名展示用：券面标题 */
  couponTitle: string | null;
  refundPolicySnapshot: RefundPolicy;
  balanceTxnId: Id | null;
  cancelReason: string | null;
  event: EventDto | null;
}

export type RegistrationPage = Paginated<RegistrationDto>;

/**
 * 后台报名列表。
 * unpaidTotal 是**全局**待收款数（不受当前页与筛选影响），用于顶部角标；
 * 放在响应里而不是让前端遍历列表统计，否则分页后角标只剩当前页的数。
 */
export type AdminRegistrationPage = Paginated<RegistrationDto> & { unpaidTotal: number };

/**
 * 一次报名多个名额的响应。
 * 服务端在同一事务内生成 seats 条独立报名记录，每条可单独取消 / 退款 / 签到。
 */
export interface RegistrationBatchDto {
  registrations: RegistrationDto[];
  /** 本次实际创建的名额数 */
  seats: number;
}

/* ---------------- 退款 ---------------- */
export interface RefundOrderDto extends Timestamps {
  id: Id;
  registrationId: Id;
  amountCent: Cent;
  reason: string | null;
  status: RefundStatus;
  requestedBy: Id;
  /** 申请人微信号（后台审核时需要知道是谁申请，服务端 join users 带出） */
  requesterWechatId: string | null;
  requesterNickname: string | null;
  /** 退款对应的场次 / 时段（后台审核列表回填，避免只看到报名 #id） */
  eventId: Id | null;
  eventTitle: string | null;
  sessionId: Id | null;
  sessionLabel: string | null;
  sessionStartAt: ISODateTime | null;
  sessionEndAt: ISODateTime | null;
  /**
   * 对应报名的支付状态（审核列表 join registrations 带出）：
   * NOT_REQUIRED=积分支付，审核通过回充积分；UNPAID/PAID=线下支付，审核通过后线下退款，不回充积分。
   * 用户端 /mine、/:id 未 join 报名，为 null。
   */
  paymentStatus: PaymentStatus | null;
  reviewedBy: Id | null;
  reviewedAt: ISODateTime | null;
  reviewRemark: string | null;
  balanceTxnId: Id | null;
  /**
   * 资金实际落定时间与经办人（对账口径，2026-11-13）。
   * 会员（积分支付）在审核通过时由系统自动写入；非会员为线下退款，审核通过时为空，
   * 运营实际退款后再补记。`status=REFUNDED && settledAt=null` 即「已批准、待线下退款」。
   */
  settledBy: Id | null;
  settledAt: ISODateTime | null;
  settleRemark: string | null;
}

export type RefundOrderPage = Paginated<RefundOrderDto>;

/** 后台退款列表：pendingTotal / unsettledTotal 是全局聚合，不受分页与筛选影响 */
export type AdminRefundOrderPage = RefundOrderPage & {
  pendingTotal: number;
  unsettledTotal: number;
};

/** 后台退款列表查询：settle 维度区分「已通过但线下未退钱」的挂账单 */
export interface AdminRefundListQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  status?: RefundStatus;
  settle?: 'UNSETTLED' | 'SETTLED';
  keyword?: string;
  /** 申请时间范围（含首含尾的自然日，YYYY-MM-DD） */
  dateFrom?: string;
  dateTo?: string;
}

/* ---------------- 投票 ---------------- */
export interface VoteOptionDto {
  id: Id;
  campaignId: Id;
  name: string;
  imageUrl: string | null;
  sort: number;
}

export interface VoteCampaignDto extends Timestamps {
  id: Id;
  /** 不强制关联场次；独立投票为 null */
  eventId: Id | null;
  /** 直接关联的模特（点C）；未关联为 null，前台据此决定是否展示模特资料入口 */
  modelId: Id | null;
  /** 关联模特资料（点C）；身高/三围按会员 gating，未关联或模特已软删除为 null */
  model: ModelProfileDto | null;
  title: string;
  openAt: ISODateTime;
  closeAt: ISODateTime;
  status: VoteCampaignStatus;
  maxVotesPerUser: number;
  options: VoteOptionDto[];
  resultPublishedAt: ISODateTime | null;
  /** 当前用户是否已投票（服务端按会话判定，不暴露他人选择） */
  myOptionId: Id | null;
}

/**
 * 后台用户列表项：会员管理页用。
 * 只暴露运营需要的最小字段；手机号等联系方式一律脱敏，不在此返回。
 */
export interface AdminUserListItemDto {
  id: Id;
  wechatId: string;
  nickname: string;
  /** 服务端按当前时间算出的有效等级 */
  level: MemberLevel;
  levelExpireAt: ISODateTime | null;
  roles: BackendRole[];
  /** 仅会员有余额账户；普通用户为 null */
  balanceCent: number | null;
  /** 累计赠送积分（分）；无账户时为 0 */
  bonusGrantedCent: number;
  /** 注册时使用的邀请码；管理员代注册 / 导入为 null */
  invitedByCode: string | null;
  /** 账号状态：编辑弹窗必须回填真实值，否则会静默解冻 */
  status: 'ACTIVE' | 'FROZEN';
  createdAt: ISODateTime;
}
export type AdminUserListPage = Paginated<AdminUserListItemDto>;

/**
 * 手动录入报名的账号校验结果。
 * 报名管理只需要「这个人是谁、按哪档计价」，不返回手机号等联系方式。
 */
export interface AdminRegistrationLookupDto {
  id: Id;
  wechatId: string;
  nickname: string;
  /** 服务端按当前时间算出的有效等级 */
  level: MemberLevel;
  status: 'ACTIVE' | 'FROZEN';
}

/**
 * 下拉选人选项（手动录入报名 / 优惠券发放共用）。
 * 与 lookup 同构：只给「是谁、按哪档计价、是否冻结」，不含联系方式。
 */
export type AdminUserOptionDto = AdminRegistrationLookupDto;

export interface AdminUserOptionsQuery {
  /** 微信号 / 昵称模糊搜索 */
  keyword?: string;
  /** 选项条数上限，默认 20，最大 50 */
  limit?: number;
}

/* ---------------- 注册邀请码 ---------------- */
export interface InviteCodeDto {
  id: Id;
  code: string;
  status: 'UNUSED' | 'USED' | 'REVOKED';
  /** 生成人微信号；列表 JOIN users 得到 */
  createdByWechatId: string | null;
  /** 使用人微信号；未使用为 null */
  usedByWechatId: string | null;
  usedAt: ISODateTime | null;
  expiresAt: ISODateTime | null;
  note: string | null;
  createdAt: ISODateTime;
}
export type InviteCodePage = Paginated<InviteCodeDto>;

/** 批量生成的返回：明文只在这里返回一次，后续列表从库里读 */
export interface InviteCodeCreateResultDto {
  codes: string[];
  count: number;
  expiresAt: ISODateTime | null;
}

/**
 * 投票活动摘要：前台投票列表用。
 * 只给「当前用户可见的活动」——服务端按 vote:cast 能力过滤，非 SVIP 拿不到列表。
 */
export interface VoteCampaignSummaryDto {
  id: Id;
  /** 不强制关联场次；独立投票为 null */
  eventId: Id | null;
  eventTitle: string | null;
  title: string;
  status: VoteCampaignStatus;
  openAt: ISODateTime;
  closeAt: ISODateTime;
  optionCount: number;
  /** 封面取第一个带图的选项，无图返回 null（前端回退为文字卡） */
  coverImageUrl: string | null;
  /** 当前用户是否已投票 */
  myVoted: boolean;
}

/** 只返回聚合数；小样本抑制时 suppressed=true 且明细计数置空 */export interface VoteResultDto {
  campaignId: Id;
  totalVotes: number;
  suppressed: boolean;
  options: Array<{
    optionId: Id;
    name: string;
    voteCount: number | null;
    ratio: number | null;
  }>;
}

/** 后台列表项：在活动 DTO 上补总票数与最近投票时间，便于一眼看热度 */
export interface AdminVoteCampaignDto extends VoteCampaignDto {
  totalVotes: number;
  lastVotedAt: ISODateTime | null;
}

export interface VoteLiveOptionDto {
  optionId: Id;
  name: string;
  imageUrl: string | null;
  voteCount: number;
  /** 0–1；总票数为 0 时为 null */
  ratio: number | null;
}

/** 后台投票人明细：仅运营可见，前台始终只输出聚合结果 */
export interface VoteVoterDto {
  userId: Id;
  wechatId: string | null;
  nickname: string | null;
  optionId: Id;
  optionName: string;
  votedAt: ISODateTime;
}

/** 后台实时投票面板：票数不抑制、带投票人明细 */
export interface VoteLiveDto {
  campaign: VoteCampaignDto;
  totalVotes: number;
  lastVotedAt: ISODateTime | null;
  options: VoteLiveOptionDto[];
  voters: VoteVoterDto[];
}

/* ---------------- 审计 ---------------- */
export interface AuditLogDto {
  id: Id;
  actorId: Id | null;
  /** 操作人微信号（后台列表 join users 带出；系统任务为 null） */
  actorWechatId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: Id | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  ua: string | null;
  traceId: string;
  createdAt: ISODateTime;
}

export interface PermissionLogDto extends AuditLogDto {
  levelBefore: MemberLevel | null;
  levelAfter: MemberLevel | null;
}

export type AuditLogPage = Paginated<AuditLogDto>;

/* ---------------- 后台列表查询 ---------------- */
/** 场次海报配置：网站二维码 + 客服二维码 + 左上角标题 */
export interface PosterSettingsDto {
  /** 客服二维码：同源 /uploads 路径或 http(s) 绝对地址；null 表示尚未配置 */
  qrUrl: string | null;
  /** 网站二维码：null 表示未上传，海报回退使用内置默认图 */
  siteQrUrl: string | null;
  /** 海报左上角标题：null 表示使用内置默认标题 */
  brandTitle: string | null;
}

/** 前台公开设置（无需登录），目前只有客服二维码 */
export interface PublicSettingsDto {
  serviceQrUrl: string | null;
}

export interface AdminEventListQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  status?: EventStatus;
  visibility?: EventVisibility;
  keyword?: string;
}

export interface AdminRegistrationListQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  eventId?: Id;
  /** 只看某个时段的报名（场次管理「查看名单」跳转携带） */
  sessionId?: Id;
  status?: RegistrationStatus;
  paymentStatus?: PaymentStatus;
  keyword?: string;
  /** 报名时间范围（含首含尾的自然日，YYYY-MM-DD） */
  dateFrom?: string;
  dateTo?: string;
}

/* ---------------- 优惠券 ---------------- */
/**
 * 优惠券实例：发券即为某个用户创建一份，单次使用。
 * EXPIRED 不入库，读取时按 expiresAt 动态判定。
 */
export interface CouponDto extends Timestamps {
  id: Id;
  title: string;
  type: CouponType;
  /** 折扣券：8500 = 85 折；立减券为 null */
  discountBp: number | null;
  /** 立减券：固定减免金额（分）；折扣券为 null */
  amountCent: Cent | null;
  /** 单席最低消费门槛（分），0 表示无门槛 */
  minSpendCent: number;
  /** 折扣券最高优惠封顶（分），null 表示不封顶 */
  maxDiscountCent: Cent | null;
  expiresAt: ISODateTime | null;
  status: CouponStatus;
  usedRegistrationId: Id | null;
  usedAt: ISODateTime | null;
  note: string | null;
}

/** 后台券列表：带持有人信息 */
export interface AdminCouponDto extends CouponDto {
  userId: Id;
  userWechatId: string;
  userNickname: string;
}

export interface AdminCouponListQuery {
  page?: number;
  pageSize?: number;
  status?: CouponStatus;
  /** 按持有人微信号/昵称或券标题模糊匹配 */
  keyword?: string;
}

export interface CouponIssueResultDto {
  created: number;
  couponIds: Id[];
}
