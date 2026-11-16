/** RESTful 端点清单（对应方案 §5）。所有请求由 baseURL = /api/v1 前缀拼接。 */
export const ENDPOINTS = {
  auth: {
    register: '/auth/register',
    login: '/auth/login',
    refresh: '/auth/refresh',
    logout: '/auth/logout',
    me: '/me',
    capabilities: '/me/capabilities',
    /** 本人改密：放在 /me 下而非 /auth，access token 过期时可正常走 refresh 重放 */
    password: '/me/password',
    /** 本人注销账号：软删除 + 匿名化，需再次输入密码 */
    deleteAccount: '/me/delete',
  },
  events: {
    list: '/events',
    detail: (id: string) => `/events/${id}`,
    availability: (id: string) => `/events/${id}/availability`,
    /** SVIP 专属：登记中场次的已登记昵称名单 */
    participants: (id: string) => `/events/${id}/participants`,
  },
  registrations: {
    create: '/registrations',
    mine: '/registrations/mine',
    detail: (id: string) => `/registrations/${id}`,
    cancel: (id: string) => `/registrations/${id}/cancel`,
  },
  refunds: {
    mine: '/refunds/mine',
    detail: (id: string) => `/refunds/${id}`,
  },
  balance: {
    account: '/balance',
    transactions: '/balance/transactions',
  },
  coupons: {
    /** 我的券包：含未使用/已使用/已过期/已作废 */
    mine: '/me/coupons',
  },
  consents: {
    /** 当前用户对最新版协议/隐私政策的同意状态 */
    mine: '/me/consents',
    /** 勾选同意后写入留痕（同一版本只记首次） */
    accept: '/me/consents',
  },
  memberships: {
    mine: '/memberships/mine',
    privileges: '/memberships/mine/privileges',
  },
  models: {
    list: '/models',
    detail: (id: string) => `/models/${id}`,
    events: (id: string) => `/models/${id}/events`,
  },
  votes: {
    /** 当前用户可见的投票活动列表（需 vote:cast，非 SVIP 拿不到） */
    list: '/vote-campaigns',
    campaign: (id: string) => `/vote-campaigns/${id}`,
    cast: '/votes',
    result: (id: string) => `/vote-campaigns/${id}/result`,
  },
  settings: {
    /** 前台公开设置（无需登录）：目前只有客服二维码 */
    public: '/settings/public',
  },
  admin: {
    events: '/admin/events',
    event: (id: string) => `/admin/events/${id}`,
    eventCancel: (id: string) => `/admin/events/${id}/cancel`,
    /** 把已取消的场次恢复（按报名窗口回落到报名中/已发布） */
    eventRestore: (id: string) => `/admin/events/${id}/restore`,
    /** 草稿 → 报名中：发布后前台可见、窗口内可报名 */
    eventPublish: (id: string) => `/admin/events/${id}/publish`,
    models: '/admin/models',
    model: (id: string) => `/admin/models/${id}`,
    /** 场景库（点4）：列表 / 详情 / 增改删 + 场次表单下拉选项 */
    scenes: '/admin/scenes',
    scene: (id: string) => `/admin/scenes/${id}`,
    sceneOptions: '/admin/scenes/options',
    registrations: '/admin/registrations',
    /** 手动录入前按微信号校验账号 */
    registrationLookup: '/admin/registrations/lookup',
    /** 下拉选人选项：手动录入 / 发券共用，按关键词搜索账号 */
    registrationUserOptions: '/admin/registrations/users',
    registration: (id: string) => `/admin/registrations/${id}`,
    confirmPayment: (id: string) => `/admin/registrations/${id}/confirm-payment`,
    /** 现场批量签到 / 批量确认收款：一次提交多条，逐条校验状态机 */
    registrationBatch: '/admin/registrations/batch',
    /** 时段级回避名单：运营配置「该时段不接受某人报名」 */
    sessionAvoidRules: '/admin/avoid-rules',
    sessionAvoidRuleRevoke: (id: string) => `/admin/avoid-rules/${id}/revoke`,
    refunds: '/admin/refunds',
    refundReview: (id: string) => `/admin/refunds/${id}/review`,
    /** 线下退款实际完成：补记经办人与时间（非会员退款的对账痕迹） */
    refundSettle: (id: string) => `/admin/refunds/${id}/settle`,
    balanceAdjustments: '/admin/balance/adjustments',
    balanceTransactions: '/admin/balance/transactions',
    memberships: '/admin/memberships',
    membershipRevoke: (id: string) => `/admin/memberships/${id}/revoke`,
    /** 后台用户/会员列表 */
    users: '/admin/users',
    user: (id: string) => `/admin/users/${id}`,
    /** 重置密码（仅管理员/超管），用微信账号定位 */
    userResetPassword: '/admin/users/reset-password',
    voteCampaigns: '/admin/vote-campaigns',
    /** 草稿 → 开放投票；投票窗口内前台才可投 */
    voteOpen: (id: string) => `/admin/vote-campaigns/${id}/open`,
    votePublish: (id: string) => `/admin/vote-campaigns/${id}/publish`,
    /** 实时票数 + 投票人明细（仅后台） */
    voteLive: (id: string) => `/admin/vote-campaigns/${id}/live`,
    auditLogs: '/admin/audit-logs',
    permissionLogs: '/admin/permission-logs',
    exports: '/admin/exports',
    /** 会员批量导入：预览（multipart）/ 提交（json）/ 模板下载 */
    membersImportPreview: '/admin/members/import/preview',
    membersImportCommit: '/admin/members/import/commit',
    membersImportTemplate: '/admin/members/import/template',
    /** 图片上传（multipart，字段名 file），返回可直接用的同源 URL */
    uploads: '/admin/uploads',
    /** 场次海报配置（固定报名二维码）：GET 读取 / PUT 覆盖 */
    posterSettings: '/admin/settings/poster',
    /** 海报版式（低代码设计器）：GET 读取 / PUT 保存，独立于二维码配置 */
    posterLayout: '/admin/settings/poster/layout',
    /** 注册邀请码：批量生成 / 列表 / 作废 */
    inviteCodes: '/admin/invite-codes',
    inviteCodeRevoke: (id: string) => `/admin/invite-codes/${id}/revoke`,
    /** 优惠券：发放 / 列表 / 作废（仅未使用的券可作废） */
    coupons: '/admin/coupons',
    couponRevoke: (id: string) => `/admin/coupons/${id}/revoke`,
  },
} as const;
