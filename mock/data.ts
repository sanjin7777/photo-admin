/**
 * 本地 Mock 数据集。
 *
 * 只依赖 @photo/shared 的类型语义，不连数据库。
 * 账号密码统一 mock123456，登录时按微信号自动带出对应角色与等级，
 * 用来在本地验证「管理员 / 运营 / 财务 / VIP / SVIP / 普通用户」等视角。
 */
import type { MemberLevel } from '../packages/shared/src/roles';
import type { BackendRole } from '../packages/shared/src/roles';

const DAY = 86_400_000;
const iso = (offsetDays: number, hour = 10, minute = 0): string => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

export interface MockAccount {
  id: string;
  wechatId: string;
  nickname: string;
  level: MemberLevel;
  roles: BackendRole[];
  balanceCent: number | null;
  /** 累计赠送积分（分）：BONUS 流水派生值，含在 balanceCent 内 */
  bonusCent?: number;
  /** 导入账号：首次登录后强制改密 */
  mustChangePassword?: boolean;
  /** 本人改密后覆盖默认演示口令（进程内生效） */
  password?: string;
  /** 用户管理页的冻结状态演示 */
  frozen?: boolean;
}

export const ACCOUNTS: MockAccount[] = [
  { id: '1', wechatId: 'admin_catpaw', nickname: '管理员', level: 'NONE', roles: ['SUPER_ADMIN'], balanceCent: null },
  { id: '9', wechatId: 'mgr_catpaw', nickname: '管理员', level: 'NONE', roles: ['ADMIN'], balanceCent: null },
  { id: '2', wechatId: 'op_catpaw', nickname: '运营', level: 'NONE', roles: ['OPERATOR'], balanceCent: null },
  { id: '3', wechatId: 'fin_catpaw', nickname: '财务', level: 'NONE', roles: ['FINANCE'], balanceCent: null },
  { id: '6', wechatId: 'svip_catpaw', nickname: 'SVIP会员', level: 'SVIP', roles: [], balanceCent: 80000, bonusCent: 20000 },
  { id: '5', wechatId: 'vip_catpaw', nickname: 'VIP会员', level: 'VIP', roles: [], balanceCent: 50000, bonusCent: 10000 },
  { id: '7', wechatId: 'u1_catpaw', nickname: '用户甲', level: 'NONE', roles: [], balanceCent: null },
  // 演示「Excel 导入账号首次登录强制改密」
  { id: '8', wechatId: 'new_catpaw', nickname: '新导入会员', level: 'VIP', roles: [], balanceCent: 0, mustChangePassword: true },
];

export const mockUserOf = (a: MockAccount) => ({
  id: a.id,
  wechatId: a.wechatId,
  nickname: a.nickname,
  avatarUrl: null,
  status: 'ACTIVE' as const,
  level: a.level,
  backendRoles: a.roles,
  sessionVersion: 1,
  emailMasked: null,
  mustChangePassword: a.mustChangePassword === true,
  createdAt: iso(-200),
  updatedAt: iso(-1),
});

const MODEL = {
  id: '1', userId: '5', boundWechatId: 'vip_catpaw', stageName: '犬了个牙', heightCm: 168, portfolioUrl: null,
  measurements: { bustCm: 86, waistCm: 60, hipCm: 88 },
  photoUrls: ['/posters/poster-catspaw.jpg', '/posters/poster-housekeeping.jpg'],
  socialAccounts: [
    { platform: 'DOUYIN' as const, handle: 'quanle_geya', url: 'https://www.douyin.com/user/quanle_geya' },
    { platform: 'XIAOHONGSHU' as const, handle: '犬了个牙', url: null },
    { platform: 'BILIBILI' as const, handle: 'quanlegeya', url: null },
  ],
  portraitAuthStatus: 'GRANTED' as const, portraitAuthExpireAt: null,
  createdAt: iso(-100), updatedAt: iso(-10),
};

/** 模特管理页的列表数据 */
export const MODELS = [
  MODEL,
  {
    id: '2', userId: null, boundWechatId: null, stageName: '小满', heightCm: 172, portfolioUrl: null,
    measurements: { bustCm: 84, waistCm: 58, hipCm: 86 },
    photoUrls: [],
    socialAccounts: [{ platform: 'XIAOHONGSHU' as const, handle: 'xiaoman_shoot', url: null }],
    portraitAuthStatus: 'GRANTED' as const, portraitAuthExpireAt: null,
    createdAt: iso(-60), updatedAt: iso(-5),
  },
];

/** 场景库演示数据（点4）：场地名 / 地址 / 简介 / 照片 / 容量 */
export const SCENES = [
  {
    id: '1', venue: '如懿映画', name: '办公室景', address: '上海市徐汇区漕溪北路 88 号 3 楼',
    description: '实景办公桌、书架与落地窗，含道具灯光，适合职场 / 通勤主题。',
    photoUrls: ['/posters/poster-catspaw.jpg'], capacity: 8,
    createdAt: iso(-90), updatedAt: iso(-10),
  },
  {
    id: '2', venue: '如懿映画', name: '家居实景', address: '上海市徐汇区漕溪北路 88 号 3 楼',
    description: '客厅 / 卧室家居景，暖光氛围，适合居家 /  lifestyle 主题。',
    photoUrls: ['/posters/poster-catspaw.jpg'], capacity: 6,
    createdAt: iso(-88), updatedAt: iso(-9),
  },
  {
    id: '3', venue: '猫爪社影棚', name: '高定礼服棚', address: '上海市静安区南京西路 1266 号 5 楼',
    description: '高定礼服、专业灯光组与实景楼梯，适合礼服 / 形象照。',
    photoUrls: ['/posters/poster-housekeeping.jpg'], capacity: 6,
    createdAt: iso(-80), updatedAt: iso(-8),
  },
  {
    id: '4', venue: '猫爪社影棚', name: '纯色背景棚', address: '上海市静安区南京西路 1266 号 5 楼',
    description: '多色无缝背景纸、棚拍闪光灯，适合肖像 / 模卡。',
    photoUrls: ['/posters/poster-housekeeping.jpg'], capacity: 4,
    createdAt: iso(-78), updatedAt: iso(-6),
  },
];

/** 退款单演示数据：带申请人，便于验证审核列表 */
export const REFUNDS = [
  {
    id: '1', registrationId: '2', amountCent: 18900,
    reason: '临时有事无法到场', status: 'REQUESTED' as const,
    requestedBy: '6', requesterWechatId: 'svip_catpaw', requesterNickname: 'SVIP会员',
    eventId: '2', eventTitle: '猫爪社 · 高定礼服专场',
    sessionId: '24', sessionLabel: '第一场', sessionStartAt: iso(6, 10), sessionEndAt: iso(6, 11),
    paymentStatus: 'UNPAID' as const,
    reviewedBy: null, reviewedAt: null, reviewRemark: null, balanceTxnId: null,
    settledBy: null, settledAt: null, settleRemark: null,
    createdAt: iso(-1), updatedAt: iso(-1),
  },
  {
    id: '2', registrationId: '1', amountCent: 5000,
    reason: '改期申请退回差价', status: 'REFUNDED' as const,
    requestedBy: '5', requesterWechatId: 'vip_catpaw', requesterNickname: 'VIP会员',
    eventId: '1', eventTitle: "Cat's paw 猫爪摄影会 · 办公室景",
    sessionId: '21', sessionLabel: '第一场', sessionStartAt: iso(3, 10), sessionEndAt: iso(3, 11),
    paymentStatus: 'PAID' as const,
    reviewedBy: '1', reviewedAt: iso(-2), reviewRemark: null, balanceTxnId: null,
    // 线下支付退款：已批准但尚未线下付款，对账时落在「待线下退款」挂账清单里
    settledBy: null, settledAt: null, settleRemark: null,
    createdAt: iso(-3), updatedAt: iso(-2),
  },
  {
    id: '3', registrationId: '3', amountCent: 16900,
    reason: '会员积分支付，临时取消', status: 'REQUESTED' as const,
    requestedBy: '5', requesterWechatId: 'vip_catpaw', requesterNickname: 'VIP会员',
    eventId: '1', eventTitle: "Cat's paw 猫爪摄影会 · 办公室景",
    sessionId: '22', sessionLabel: '第二场', sessionStartAt: iso(21, 11, 10), sessionEndAt: iso(21, 12, 10),
    paymentStatus: 'NOT_REQUIRED' as const,
    reviewedBy: null, reviewedAt: null, reviewRemark: null, balanceTxnId: null,
    settledBy: null, settledAt: null, settleRemark: null,
    createdAt: iso(-1), updatedAt: iso(-1),
  },
];

export const EVENT_PUBLIC = {
  id: '1',
  title: "Cat's paw 猫爪摄影会 · 办公室景",
  subtitle: '犬了个牙 · 4V1',
  description: '办公室主题棚拍，含妆造与灯光。每人独立出片时段，4 人 1 位模特。',
  coverUrl: '/posters/poster-catspaw.jpg',
  posterUrls: ['/posters/poster-catspaw.jpg', '/posters/poster-housekeeping.jpg'],
  wardrobeUrls: ['/posters/poster-housekeeping.jpg'],
  venueUrls: ['/posters/poster-catspaw.jpg'],
  venue: '如懿映画',
  scene: '办公室景',
  modelId: '1',
  sceneId: '1' as string | null,
  model: MODEL,
  ratioLabel: '4V1',
  modelCount: 4,
  allowProxyShoot: true,
  privateBookingNote: '单人包场请联系客服另行预约。',
  notice: '1. 请提前 10 分钟到场签到。\n2. 开始前 24 小时可免费取消。\n3. 现场提供基础妆造，特殊造型请提前沟通。',
  registrationOpenAt: iso(-10),
  registrationCloseAt: iso(20),
  startAt: iso(21, 10),
  endAt: iso(21, 18),
  visibility: 'PUBLIC' as const,
  registerMinLevel: 'NONE' as 'NONE' | 'VIP' | 'SVIP',
  feeCent: 18900,
  capacity: 12,
  capacityUsed: 3,
  allowCoupon: true,
  refundPolicy: { freeCancelBeforeHours: 24, feeRatio: 0.3 },
  status: 'REGISTRATION_OPEN' as const,
  version: 1,
  sessions: [
    { id: '21', eventId: '1', label: '第一场', startAt: iso(21, 10), endAt: iso(21, 11), capacity: 4, capacityUsed: 1, status: 'OPEN' as const },
    { id: '22', eventId: '1', label: '第二场', startAt: iso(21, 11, 10), endAt: iso(21, 12, 10), capacity: 4, capacityUsed: 2, status: 'OPEN' as const },
    { id: '23', eventId: '1', label: '第三场', startAt: iso(21, 12, 20), endAt: iso(21, 13, 20), capacity: 4, capacityUsed: 0, status: 'OPEN' as const },
    // 代拍：独立于时段，每场次默认一个，价格与正常报名一致
    { id: 'proxy-1', eventId: '1', label: '代拍', startAt: iso(21, 10), endAt: iso(21, 13, 20), capacity: 12, capacityUsed: 0, status: 'OPEN' as const, kind: 'PROXY' as const },
  ],
  prices: [
    { level: 'PUBLIC' as const, priceCent: 18900, unitLabel: '场' },
    { level: 'VIP' as const, priceCent: 16900, unitLabel: '场' },
    { level: 'SVIP' as const, priceCent: 14900, unitLabel: '场' },
  ],
  createdAt: iso(-30),
  updatedAt: iso(-2),
};

export const EVENT_SVIP = {
  ...EVENT_PUBLIC,
  id: '2',
  title: '猫爪社 · 高定礼服专场',
  subtitle: 'SVIP 专属 · 6V1',
  description: '高定礼服主题，SVIP 专属场次。',
  venue: '猫爪社影棚',
  scene: '高定礼服',
  visibility: 'SVIP' as const,
  feeCent: 20900,
  capacity: 6,
  capacityUsed: 1,
  posterUrls: ['/posters/poster-housekeeping.jpg'],
  wardrobeUrls: [],
  sessions: [
    // 故意与公开场的「第二场」时间重叠，用来演示报名时段冲突提醒
    { id: '24', eventId: '2', label: '第一场', startAt: iso(21, 11, 10), endAt: iso(21, 12, 10), capacity: 6, capacityUsed: 1, status: 'OPEN' as const },
  ],
  prices: [
    { level: 'PUBLIC' as const, priceCent: 20900, unitLabel: '场' },
    { level: 'VIP' as const, priceCent: 19900, unitLabel: '场' },
    { level: 'SVIP' as const, priceCent: 18900, unitLabel: '场' },
  ],
  createdAt: iso(-20),
  updatedAt: iso(-1),
};

/** 草稿场次：只在后台列表出现，前台不可见、不可报名 */
export const EVENT_DRAFT = {
  ...EVENT_PUBLIC,
  id: '3',
  title: '猫爪社 · 夏日泳池专场',
  subtitle: '待定模特 · 4V1',
  scene: '泳池景',
  status: 'DRAFT' as const,
  capacityUsed: 0,
  sessions: [
    { id: '25', eventId: '3', label: '第一场', startAt: iso(28, 10), endAt: iso(28, 11), capacity: 4, capacityUsed: 0, status: 'OPEN' as const },
  ],
  createdAt: iso(-1),
  updatedAt: iso(0),
};

export const REGISTRATIONS = [
  {
    id: 'r1', eventId: '1', userId: '7', sessionId: '21', status: 'CONFIRMED' as const,
    paymentStatus: 'PAID' as const, source: 'ONLINE' as const,
    feeCent: 18900, originalFeeCent: 18900, discountCent: 0, couponId: null, couponTitle: null,
    refundPolicySnapshot: { freeCancelBeforeHours: 24, feeRatio: 0.3 },
    balanceTxnId: null, cancelReason: null,
    userWechatId: 'u1_catpaw',
    eventTitle: EVENT_PUBLIC.title, sessionLabel: EVENT_PUBLIC.sessions[0].label,
    sessionStartAt: EVENT_PUBLIC.sessions[0].startAt,
    event: EVENT_PUBLIC, session: EVENT_PUBLIC.sessions[0],
    createdAt: iso(-3), updatedAt: iso(-3),
  },
  {
    id: 'r2', eventId: '2', userId: '6', sessionId: '24', status: 'CONFIRMED' as const,
    paymentStatus: 'UNPAID' as const, source: 'MANUAL' as const,
    feeCent: 16065, originalFeeCent: 18900, discountCent: 2835, couponId: 'c3', couponTitle: 'SVIP 高端场 85 折券',
    refundPolicySnapshot: { freeCancelBeforeHours: 24, feeRatio: 0.3 },
    balanceTxnId: null, cancelReason: null,
    userWechatId: 'svip_catpaw',
    eventTitle: EVENT_SVIP.title, sessionLabel: EVENT_SVIP.sessions[0].label,
    sessionStartAt: EVENT_SVIP.sessions[0].startAt,
    event: EVENT_SVIP, session: EVENT_SVIP.sessions[0],
    createdAt: iso(-2), updatedAt: iso(-2),
  },
  // 第二时段的两位会员：与 sessions[1].capacityUsed=2 对齐，供名额/名单面板演示
  {
    id: 'r3', eventId: '1', userId: '5', sessionId: '22', status: 'CONFIRMED' as const,
    paymentStatus: 'NOT_REQUIRED' as const, source: 'ONLINE' as const,
    feeCent: 16900, originalFeeCent: 16900, discountCent: 0, couponId: null, couponTitle: null,
    refundPolicySnapshot: { freeCancelBeforeHours: 24, feeRatio: 0.3 },
    balanceTxnId: null, cancelReason: null,
    userWechatId: 'vip_catpaw',
    eventTitle: EVENT_PUBLIC.title, sessionLabel: EVENT_PUBLIC.sessions[1].label,
    sessionStartAt: EVENT_PUBLIC.sessions[1].startAt,
    event: EVENT_PUBLIC, session: EVENT_PUBLIC.sessions[1],
    createdAt: iso(-2), updatedAt: iso(-2),
  },
  {
    id: 'r4', eventId: '1', userId: '6', sessionId: '22', status: 'CONFIRMED' as const,
    paymentStatus: 'NOT_REQUIRED' as const, source: 'ONLINE' as const,
    feeCent: 14900, originalFeeCent: 14900, discountCent: 0, couponId: null, couponTitle: null,
    refundPolicySnapshot: { freeCancelBeforeHours: 24, feeRatio: 0.3 },
    balanceTxnId: null, cancelReason: null,
    userWechatId: 'svip_catpaw',
    eventTitle: EVENT_PUBLIC.title, sessionLabel: EVENT_PUBLIC.sessions[1].label,
    sessionStartAt: EVENT_PUBLIC.sessions[1].startAt,
    event: EVENT_PUBLIC, session: EVENT_PUBLIC.sessions[1],
    createdAt: iso(-1), updatedAt: iso(-1),
  },
];

/**
 * 优惠券演示数据：SVIP 有 2 张可用、1 张已用；VIP 有 1 张已过期；普通用户 1 张已作废。
 * EXPIRED 不落库，读取时按 expiresAt 动态判定。
 */
export const COUPONS = [
  {
    id: 'c1', userId: '6', title: '全场 85 折券', type: 'DISCOUNT' as const,
    discountBp: 8500, amountCent: null, minSpendCent: 0, maxDiscountCent: 5000,
    expiresAt: iso(30), status: 'UNUSED' as const, usedRegistrationId: null, usedAt: null,
    note: '双十一回馈', issuedBy: '1', createdAt: iso(-1), updatedAt: iso(-1),
  },
  {
    id: 'c2', userId: '6', title: '满 150 减 50', type: 'AMOUNT' as const,
    discountBp: null, amountCent: 5000, minSpendCent: 15000, maxDiscountCent: null,
    expiresAt: iso(7), status: 'UNUSED' as const, usedRegistrationId: null, usedAt: null,
    note: null, issuedBy: '1', createdAt: iso(-1), updatedAt: iso(-1),
  },
  {
    id: 'c3', userId: '6', title: 'SVIP 高端场 85 折券', type: 'DISCOUNT' as const,
    discountBp: 8500, amountCent: null, minSpendCent: 0, maxDiscountCent: null,
    expiresAt: iso(60), status: 'USED' as const, usedRegistrationId: 'r2', usedAt: iso(-2),
    note: null, issuedBy: '1', createdAt: iso(-5), updatedAt: iso(-2),
  },
  {
    id: 'c4', userId: '5', title: '新客立减 30', type: 'AMOUNT' as const,
    discountBp: null, amountCent: 3000, minSpendCent: 0, maxDiscountCent: null,
    expiresAt: iso(-1), status: 'UNUSED' as const, usedRegistrationId: null, usedAt: null,
    note: null, issuedBy: '1', createdAt: iso(-10), updatedAt: iso(-10),
  },
  {
    id: 'c5', userId: '7', title: '已作废的测试券', type: 'DISCOUNT' as const,
    discountBp: 9000, amountCent: null, minSpendCent: 0, maxDiscountCent: null,
    expiresAt: null, status: 'REVOKED' as const, usedRegistrationId: null, usedAt: null,
    note: null, issuedBy: '1', createdAt: iso(-15), updatedAt: iso(-14),
  },
];

export const VOTE_OPEN = {
  id: '1',
  eventId: '1',
  modelId: '1',
  title: '3 月场服装方案投票',
  openAt: iso(-2),
  closeAt: iso(10),
  status: 'OPEN' as const,
  maxVotesPerUser: 1,
  resultPublishedAt: null,
  options: [
    { id: 'o1', campaignId: '1', name: '复古胶片', imageUrl: '/posters/poster-housekeeping.jpg', sort: 0 },
    { id: 'o2', campaignId: '1', name: '极简黑白', imageUrl: null, sort: 1 },
    { id: 'o3', campaignId: '1', name: '高定礼服', imageUrl: '/posters/poster-catspaw.jpg', sort: 2 },
  ],
  myOptionId: null as string | null,
  createdAt: iso(-3),
  updatedAt: iso(-1),
};

export const VOTE_DRAFT = {
  id: '3',
  // 演示「投票可以不关联场次」
  eventId: null as string | null,
  // 演示「投票也可以不关联模特」：前台不展示模特资料入口
  modelId: null as string | null,
  title: '4 月场服装方案投票（草稿）',
  openAt: iso(1),
  closeAt: iso(9),
  status: 'DRAFT' as 'DRAFT' | 'OPEN',
  maxVotesPerUser: 1,
  resultPublishedAt: null,
  options: [
    { id: 'o6', campaignId: '3', name: '春日暖阳', imageUrl: null, sort: 0 },
    { id: 'o7', campaignId: '3', name: '雨后街景', imageUrl: null, sort: 1 },
  ],
  myOptionId: null as string | null,
  createdAt: iso(-1),
  updatedAt: iso(-1),
};

export const VOTE_PUBLISHED = {
  id: '2',
  eventId: '2',
  modelId: '2',
  title: '2 月场服装方案投票（已结束）',
  openAt: iso(-30),
  closeAt: iso(-20),
  status: 'PUBLISHED' as const,
  maxVotesPerUser: 1,
  resultPublishedAt: iso(-19),
  options: [
    { id: 'o4', campaignId: '2', name: '暗夜玫瑰', imageUrl: null, sort: 0 },
    { id: 'o5', campaignId: '2', name: '白纱轻语', imageUrl: null, sort: 1 },
  ],
  myOptionId: 'o4' as string | null,
  createdAt: iso(-40),
  updatedAt: iso(-19),
};

export interface MockVoteRecord {
  userId: string;
  wechatId: string;
  nickname: string | null;
  optionId: string;
  votedAt: string;
}

/** 按选项票数批量生成投票明细，保证后台「实时投票」的票数与选项一一对应 */
function seedVoters(campaignId: string, plan: Array<[string, number]>, daysAgo: number): MockVoteRecord[] {
  const out: MockVoteRecord[] = [];
  let n = 0;
  for (const [optionId, count] of plan) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      out.push({
        userId: `v${campaignId}_${n}`,
        wechatId: `catpaw_voter${String(n).padStart(2, '0')}`,
        nickname: `会员${n}`,
        optionId,
        votedAt: iso(daysAgo, 10 + (n % 10), (n * 7) % 60),
      });
    }
  }
  return out;
}

export const VOTE_VOTERS: Record<string, MockVoteRecord[]> = {
  '1': seedVoters('1', [['o1', 20], ['o2', 14], ['o3', 8]], -1),
  '2': seedVoters('2', [['o4', 11], ['o5', 7]], -21),
};

export const AUDIT_LOGS = [
  { id: 'a1', action: 'MEMBER_IMPORT', targetType: 'user_batch', targetId: null, actorId: '1', createdAt: iso(-1) },
  { id: 'a2', action: 'REFUND_REVIEW', targetType: 'refund', targetId: 'rf1', actorId: '3', createdAt: iso(-2) },
  { id: 'a3', action: 'VOTE_RESULT_PUBLISH', targetType: 'vote_campaign', targetId: '2', actorId: '2', createdAt: iso(-3) },
];

export const PERMISSION_LOGS = [
  { id: 'p1', action: 'MEMBERSHIP_GRANT', targetType: 'user', targetId: '6', actorId: '1', createdAt: iso(-1) },
  { id: 'p2', action: 'MEMBERSHIP_REVOKE', targetType: 'user', targetId: '5', actorId: '1', createdAt: iso(-5) },
];

/** 海报配置（后台可改，进程内保存）：两张码 + 左上角标题 + 自定义版式 */
export const POSTER_SETTINGS = {
  qrUrl: null as string | null,
  siteQrUrl: null as string | null,
  brandTitle: null as string | null,
  /** 设计器保存的版式；null 表示未自定义，导出按预设渲染 */
  layout: null as unknown,
};

/** 导入预览的固定演示数据：覆盖 OK / WARN（已存在）/ ERROR 三种状态 */
export const IMPORT_PREVIEW_ROWS = [
  { row: 2, wechatId: 'catpaw_vip01', nickname: '小爪', level: 'VIP' as const, expireAt: iso(180), balanceCent: 50000, bonusCent: 10000, remark: '老会员补录', status: 'OK' as const, messages: [], exists: false, existingUserId: null },
  { row: 3, wechatId: 'catpaw_svip01', nickname: '大爪', level: 'SVIP' as const, expireAt: iso(365), balanceCent: 120000, bonusCent: 30000, remark: null, status: 'OK' as const, messages: [], exists: false, existingUserId: null },
  { row: 4, wechatId: 'vip_catpaw', nickname: 'VIP会员', level: 'VIP' as const, expireAt: iso(200), balanceCent: null, bonusCent: null, remark: null, status: 'WARN' as const, messages: ['该微信号已存在：将按「覆盖」开关决定更新或跳过'], exists: true, existingUserId: '5' },
  { row: 5, wechatId: 'catpaw_bad', nickname: '爪', level: 'VIP' as const, expireAt: iso(-30), balanceCent: -10, bonusCent: null, remark: null, status: 'ERROR' as const, messages: ['昵称需 2–24 个字符', '有效期必须晚于今天', '余额不能为负数'], exists: false, existingUserId: null },
];

/* ================= 驾驶舱演示：历史经营数据（确定性生成，无随机） ================= */

/** 12 位历史会员/用户：让等级分布、报名趋势有真实量级 */
const FAN_NAMES = ['奶盖', '布丁', '抹茶', '芋圆', '肉松', '豆乳', '可可', '糯米', '芝士', '桃桃', '乌龙', '糖霜'];
const FAN_LEVELS: MemberLevel[] = ['NONE', 'VIP', 'NONE', 'SVIP', 'NONE', 'VIP', 'NONE', 'NONE', 'VIP', 'SVIP', 'NONE', 'VIP'];
FAN_NAMES.forEach((name, i) => {
  ACCOUNTS.push({
    id: String(101 + i),
    wechatId: `claw_fan_${String(i + 1).padStart(2, '0')}`,
    nickname: name,
    level: FAN_LEVELS[i],
    roles: [],
    balanceCent: FAN_LEVELS[i] === 'NONE' ? null : 20000 + i * 8000,
    bonusCent: FAN_LEVELS[i] === 'NONE' ? 0 : 5000 + i * 1000,
  });
});

/** 历史场次：5 场已结束 + 1 场报名中，覆盖近 45 天 */
function histEvent(id: number, title: string, scene: string, dayOffset: number, sessionCount: number, cap: number, priceCent: number, upcoming = false) {
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    id: `${id}${i + 1}`, eventId: String(id), label: `第${'一二三四'[i]}场`,
    startAt: iso(dayOffset, 10 + i, i * 10), endAt: iso(dayOffset, 11 + i, i * 10),
    capacity: cap, capacityUsed: 0, status: 'OPEN' as const,
  }));
  return {
    ...EVENT_PUBLIC,
    id: String(id), title, subtitle: `${scene} · ${cap}V1`,
    description: `${title}（历史演示数据）。`,
    scene,
    posterUrls: ['/posters/poster-housekeeping.jpg'],
    wardrobeUrls: [],
    feeCent: priceCent,
    capacity: cap * sessionCount,
    capacityUsed: 0,
    registrationOpenAt: iso(dayOffset - 12),
    registrationCloseAt: iso(upcoming ? 2 : dayOffset - 1),
    startAt: iso(dayOffset, 10),
    endAt: iso(dayOffset, 18),
    status: (upcoming ? 'REGISTRATION_OPEN' : 'FINISHED') as 'REGISTRATION_OPEN' | 'FINISHED',
    sessions,
    prices: [
      { level: 'PUBLIC' as const, priceCent, unitLabel: '场' },
      { level: 'VIP' as const, priceCent: priceCent - 2000, unitLabel: '场' },
      { level: 'SVIP' as const, priceCent: priceCent - 4000, unitLabel: '场' },
    ],
    createdAt: iso(dayOffset - 14),
    updatedAt: iso(dayOffset),
  };
}

export const HISTORY_EVENTS = [
  histEvent(101, '猫爪社摄影会 · 樱花季', '樱花景', -38, 2, 6, 19900),
  histEvent(102, '猫爪社摄影会 · JK 制服', '教室景', -31, 3, 4, 17900),
  histEvent(103, '猫爪社摄影会 · 古风汉服', '园林景', -24, 2, 8, 21900),
  histEvent(104, '猫爪社摄影会 · 泳池派对', '泳池景', -17, 2, 6, 18900),
  histEvent(105, '猫爪社摄影会 · 圣诞预热', '圣诞景', -10, 3, 4, 20900),
  histEvent(106, '猫爪社摄影会 · 新年首拍', '红景', 3, 2, 6, 18900, true),
];

/** 后台场次列表用全量（含历史）；前台仍只展示当前三个场次 */
export const ALL_EVENTS = [EVENT_DRAFT, EVENT_PUBLIC, EVENT_SVIP, ...HISTORY_EVENTS];

const fanPool = ACCOUNTS.filter((a) => a.roles.length === 0);
const cancelledRows: Array<Record<string, unknown>> = [];
const couponRows: Array<Record<string, unknown>> = [];

for (const ev of HISTORY_EVENTS) {
  const eid = Number(ev.id);
  const upcoming = ev.status === 'REGISTRATION_OPEN';
  ev.sessions.forEach((s, si) => {
    const target = Math.max(1, s.capacity - ((eid + si) % 3));
    for (let k = 0; k < target; k += 1) {
      const user = fanPool[(eid * 3 + si * 5 + k) % fanPool.length];
      const cancelled = (eid + si + k) % 13 === 0;
      const baseFee = ev.prices.find((p) => p.level === (user.level === 'NONE' ? 'PUBLIC' : user.level))?.priceCent ?? ev.feeCent;
      const withCoupon = !cancelled && k % 6 === 2;
      const discountCent = withCoupon ? Math.round(baseFee * 0.15) : 0;
      const daysBeforeEvent = Math.round((Date.now() - Date.parse(s.startAt)) / DAY);
      const dayOffset = upcoming || eid === 106 ? -(k % 7) : -daysBeforeEvent - 2 - (k % 5);
      const createdAt = iso(dayOffset, 9 + ((k * 3) % 12), (k * 11) % 60);
      const row = {
        id: `h${eid}${si}${k}`, eventId: ev.id, userId: user.id, sessionId: s.id,
        status: (cancelled ? 'CANCELLED' : upcoming ? 'CONFIRMED' : 'CHECKED_IN') as 'CANCELLED' | 'CONFIRMED' | 'CHECKED_IN',
        paymentStatus: (cancelled ? 'REFUNDED' : user.level === 'NONE' ? 'PAID' : 'NOT_REQUIRED') as 'REFUNDED' | 'PAID' | 'NOT_REQUIRED',
        source: 'ONLINE' as const,
        
        feeCent: baseFee - discountCent, originalFeeCent: baseFee, discountCent,
        couponId: withCoupon ? `hc${(k % 4) + 1}` : null,
        couponTitle: withCoupon ? '全场 85 折券' : null,
        refundPolicySnapshot: ev.refundPolicy, balanceTxnId: null,
        cancelReason: cancelled ? '个人原因取消' : null,
        userWechatId: user.wechatId,
        eventTitle: ev.title, sessionLabel: s.label, sessionStartAt: s.startAt,
        event: ev, session: s, createdAt, updatedAt: createdAt,
      };
      (REGISTRATIONS as unknown as Array<Record<string, unknown>>).push(row);
      if (cancelled) cancelledRows.push(row); else s.capacityUsed += 1;
      if (withCoupon) couponRows.push(row);
    }
    ev.capacityUsed += s.capacityUsed;
  });
}

/** 历史退款：4 笔已退 + 1 笔驳回，配合既有 REQUESTED / REFUNDED 演示退款监控 */
cancelledRows.slice(0, 4).forEach((r, i) => {
  (REFUNDS as unknown as Array<Record<string, unknown>>).push({
    id: `hr${i + 1}`, registrationId: r.id, amountCent: r.feeCent,
    reason: '行程冲突，申请退款', status: 'REFUNDED' as const,
    requestedBy: r.userId, requesterWechatId: r.userWechatId, requesterNickname: null,
    eventId: r.eventId, eventTitle: r.eventTitle,
    sessionId: r.sessionId, sessionLabel: r.sessionLabel, sessionStartAt: r.sessionStartAt, sessionEndAt: null,
    paymentStatus: (ACCOUNTS.find((a) => a.id === r.userId)?.level === 'NONE' ? 'PAID' : 'NOT_REQUIRED') as 'PAID' | 'NOT_REQUIRED',
    reviewedBy: '3', reviewedAt: r.createdAt, reviewRemark: '符合免费取消规则', balanceTxnId: null,
    settledBy: '3', settledAt: r.createdAt, settleRemark: '线下转账已退',
    createdAt: r.createdAt, updatedAt: r.createdAt,
  });
});
if (cancelledRows[4]) {
  const r = cancelledRows[4];
  (REFUNDS as unknown as Array<Record<string, unknown>>).push({
    id: 'hr5', registrationId: r.id, amountCent: r.feeCent,
    reason: '临时不想拍了', status: 'REJECTED' as const,
    requestedBy: r.userId, requesterWechatId: r.userWechatId, requesterNickname: null,
    eventId: r.eventId, eventTitle: r.eventTitle,
    sessionId: r.sessionId, sessionLabel: r.sessionLabel, sessionStartAt: r.sessionStartAt, sessionEndAt: null,
    paymentStatus: (ACCOUNTS.find((a) => a.id === r.userId)?.level === 'NONE' ? 'PAID' : 'NOT_REQUIRED') as 'PAID' | 'NOT_REQUIRED',
    reviewedBy: '3', reviewedAt: r.createdAt, reviewRemark: '已过免费取消时限', balanceTxnId: null,
    settledBy: null, settledAt: null, settleRemark: null,
    createdAt: r.createdAt, updatedAt: r.createdAt,
  });
}

/** 历史优惠券：4 张已用 + 2 张已过期（读取时动态判定）+ 2 张未使用 */
const couponFan = (i: number) => fanPool[(i * 5 + 2) % fanPool.length];
for (let i = 0; i < 4; i += 1) {
  const u = couponFan(i);
  const used = couponRows[i % couponRows.length];
  (COUPONS as unknown as Array<Record<string, unknown>>).push({
    id: `hc${i + 1}`, userId: u.id, title: '全场 85 折券', type: 'DISCOUNT' as const,
    discountBp: 8500, amountCent: null, minSpendCent: 0, maxDiscountCent: 5000,
    expiresAt: iso(60), status: 'USED' as const,
    usedRegistrationId: used?.id ?? null, usedAt: iso(-20 + i * 5),
    note: '历史活动发放', issuedBy: '1', createdAt: iso(-30 + i * 3), updatedAt: iso(-20 + i * 5),
  });
}
for (let i = 0; i < 2; i += 1) {
  const u = couponFan(i + 4);
  (COUPONS as unknown as Array<Record<string, unknown>>).push({
    id: `hc${i + 5}`, userId: u.id, title: '新客立减 30', type: 'AMOUNT' as const,
    discountBp: null, amountCent: 3000, minSpendCent: 0, maxDiscountCent: null,
    expiresAt: iso(-5 - i * 7), status: 'UNUSED' as const,
    usedRegistrationId: null, usedAt: null,
    note: '新客礼', issuedBy: '1', createdAt: iso(-40 + i * 4), updatedAt: iso(-40 + i * 4),
  });
}
for (let i = 0; i < 2; i += 1) {
  const u = couponFan(i + 6);
  (COUPONS as unknown as Array<Record<string, unknown>>).push({
    id: `hc${i + 7}`, userId: u.id, title: '满 150 减 50', type: 'AMOUNT' as const,
    discountBp: null, amountCent: 5000, minSpendCent: 15000, maxDiscountCent: null,
    expiresAt: iso(25 + i * 15), status: 'UNUSED' as const,
    usedRegistrationId: null, usedAt: null,
    note: '双十一预热', issuedBy: '1', createdAt: iso(-2 - i), updatedAt: iso(-2 - i),
  });
}
