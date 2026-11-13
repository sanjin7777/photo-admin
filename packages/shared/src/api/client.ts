/**
 * 按域组织的 API 函数。前端只调用这里，不直接拼 URL / 解包响应。
 * 请求体类型全部来自 z.infer，响应类型全部来自 types/domain.ts。
 */
import type { HttpClient } from './http';
import { ENDPOINTS } from './endpoints';
import { API_BASE_PATH, IDEMPOTENCY_KEY_HEADER } from '../constants';
import type {
  AdminBalanceTxnListQuery,
  AdminCouponDto,
  AdminCouponListQuery,
  AdminEventListQuery,
  AdminRefundListQuery,
  AdminRefundOrderPage,
  AdminRegistrationListQuery,
  AdminRegistrationLookupDto,
  AdminRegistrationPage,
  AdminUserListItemDto,
  AdminUserListPage,
  AdminUserOptionDto,
  AdminUserOptionsQuery,
  AdminVoteCampaignDto,
  CouponDto,
  CouponIssueResultDto,
} from '../types/domain';
import type { PageQuery } from '../types/common';
import type { ConsentStatusDto } from '../legal';
import type {
  AuditLogDto,
  AuditLogPage,
  BalanceViewDto,
  BalanceTransactionPage,
  CapabilitiesDto,
  EventAvailabilityDto,
  EventDto,
  EventPage,
  InviteCodeCreateResultDto,
  InviteCodePage,
  LoginResultDto,
  MembershipDto,
  ModelProfileDto,
  PermissionLogDto,
  PosterSettingsDto,
  PublicSettingsDto,
  RefreshResultDto,
  RefundOrderDto,
  RefundOrderPage,
  RegistrationBatchDto,
  RegistrationDto,
  RegistrationPage,
  SceneDto,
  ScenePage,
  UserDto,
  VoteCampaignDto,
  VoteCampaignSummaryDto,
  VoteLiveDto,
  VoteResultDto,
} from '../types/domain';
import type {
  MemberImportCommitPayload,
  MemberImportPreviewDto,
  MemberImportResultDto,
  UploadResultDto,
} from '../types/imports';
import type {
  AdminCouponIssuePayload,
  AdminCouponListQueryInput,
  AdminCreateUserPayload,
  AdminRegistrationActionPayload,
  AdminRegistrationBatchPayload,
  AdminRegistrationBatchResult,
  AdminRegistrationCreatePayload,
  AdminResetPasswordPayload,
  AdminUpdateUserPayload,
  BalanceAdjustmentPayload,
  ChangePasswordPayload,
  EventCreatePayload,
  EventPatchPayload,
  InviteCodeCreatePayload,
  InviteCodeListQueryInput,
  LoginPayload,
  MembershipGrantPayload,
  MembershipRevokePayload,
  ModelProfileUpsertPayload,
  PosterSettingsUpdatePayload,
  RefundReviewPayload,
  RefundSettlePayload,
  RegisterPayload,
  RegistrationCancelPayload,
  RegistrationCreatePayload,
  SceneUpsertPayload,
  VoteCampaignCreatePayload,
  VoteCampaignPatchPayload,
  VoteCastPayload,
} from '../schemas';

export function createApiClient(http: HttpClient) {
  return {
    auth: {
      register: (payload: RegisterPayload) => http.post<UserDto>(ENDPOINTS.auth.register, payload),
      login: (payload: LoginPayload) => http.post<LoginResultDto>(ENDPOINTS.auth.login, payload),
      refresh: () => http.post<RefreshResultDto>(ENDPOINTS.auth.refresh),
      logout: () => http.post<null>(ENDPOINTS.auth.logout),
      me: () => http.get<UserDto>(ENDPOINTS.auth.me),
      capabilities: () => http.get<CapabilitiesDto>(ENDPOINTS.auth.capabilities),
      /** 本人改密：返回更新后的用户信息（mustChangePassword 已清零） */
      changePassword: (payload: ChangePasswordPayload) =>
        http.post<UserDto>(ENDPOINTS.auth.password, payload),
    },

    events: {
      list: (query: PageQuery = {}) => http.get<EventPage>(ENDPOINTS.events.list, { params: query }),
      detail: (id: string) => http.get<EventDto>(ENDPOINTS.events.detail(id)),
      availability: (id: string) =>
        http.get<EventAvailabilityDto>(ENDPOINTS.events.availability(id)),
    },

    registrations: {
      /**
       * 一次可同时报名多个名额（seats）。
       * 传入稳定的 idempotencyKey 可保证「网络重试 / 用户连点」只创建一批记录；
       * 不传则由 HTTP 客户端自动生成（每次请求都不同）。
       */
      create: (payload: RegistrationCreatePayload, idempotencyKey?: string) =>
        http.post<RegistrationBatchDto>(
          ENDPOINTS.registrations.create,
          payload,
          idempotencyKey ? { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } } : undefined,
        ),
      mine: (query: PageQuery = {}) =>
        http.get<RegistrationPage>(ENDPOINTS.registrations.mine, { params: query }),
      detail: (id: string) => http.get<RegistrationDto>(ENDPOINTS.registrations.detail(id)),
      cancel: (id: string, payload: RegistrationCancelPayload) =>
        http.post<RegistrationDto>(ENDPOINTS.registrations.cancel(id), payload),
    },

    refunds: {
      mine: (query: PageQuery = {}) =>
        http.get<RefundOrderPage>(ENDPOINTS.refunds.mine, { params: query }),
      detail: (id: string) => http.get<RefundOrderDto>(ENDPOINTS.refunds.detail(id)),
    },

    balance: {
      /** 仅 VIP/SVIP 有余额账户；applicable=false 时前端不展示余额区块 */
      account: () => http.get<BalanceViewDto>(ENDPOINTS.balance.account),
      transactions: (query: PageQuery = {}) =>
        http.get<BalanceTransactionPage>(ENDPOINTS.balance.transactions, { params: query }),
    },

    /** 我的券包：未使用 / 已使用 / 已过期（按 expiresAt 动态判定）/ 已作废 */
    coupons: {
      mine: () => http.get<CouponDto[]>(ENDPOINTS.coupons.mine),
    },

    /** 用户协议 / 隐私政策的同意状态与留痕 */
    consents: {
      mine: () => http.get<ConsentStatusDto>(ENDPOINTS.consents.mine),
      accept: () => http.post<ConsentStatusDto>(ENDPOINTS.consents.accept, { agreed: true }),
    },

    memberships: {
      mine: () => http.get<MembershipDto[]>(ENDPOINTS.memberships.mine),
      privileges: () => http.get<CapabilitiesDto>(ENDPOINTS.memberships.privileges),
    },

    models: {
      list: (query: PageQuery = {}) =>
        http.get<{ list: ModelProfileDto[]; total: number; page: number; pageSize: number }>(
          ENDPOINTS.models.list,
          { params: query },
        ),
      detail: (id: string) => http.get<ModelProfileDto>(ENDPOINTS.models.detail(id)),
      events: (id: string) => http.get<EventPage>(ENDPOINTS.models.events(id)),
    },

    votes: {
      list: () => http.get<VoteCampaignSummaryDto[]>(ENDPOINTS.votes.list),
      campaign: (id: string) => http.get<VoteCampaignDto>(ENDPOINTS.votes.campaign(id)),
      cast: (payload: VoteCastPayload) => http.post<VoteCampaignDto>(ENDPOINTS.votes.cast, payload),
      result: (id: string) => http.get<VoteResultDto>(ENDPOINTS.votes.result(id)),
    },

    settings: {
      /** 前台公开设置（无需登录）：客服二维码等 */
      public: () => http.get<PublicSettingsDto>(ENDPOINTS.settings.public),
    },

    admin: {
      events: {
        list: (query: AdminEventListQuery = {}) =>
          http.get<EventPage>(ENDPOINTS.admin.events, { params: query }),
        create: (payload: EventCreatePayload) =>
          http.post<EventDto>(ENDPOINTS.admin.events, payload),
        update: (id: string, payload: EventPatchPayload) =>
          http.patch<EventDto>(ENDPOINTS.admin.event(id), payload),
        cancel: (id: string, payload: { reason: string }) =>
          http.post<EventDto>(ENDPOINTS.admin.eventCancel(id), payload),
        /** 恢复已取消的场次：服务端按报名窗口决定回到「报名中」还是「已发布」 */
        restore: (id: string) =>
          http.post<EventDto>(ENDPOINTS.admin.eventRestore(id)),
        /** 草稿 → 报名中：发布后才在前台可见并可报名 */
        publish: (id: string) =>
          http.post<EventDto>(ENDPOINTS.admin.eventPublish(id)),
      },
      models: {
        list: (query: PageQuery = {}) =>
          http.get<{ list: ModelProfileDto[]; total: number; page: number; pageSize: number }>(
            ENDPOINTS.admin.models,
            { params: query },
          ),
        upsert: (id: string | null, payload: ModelProfileUpsertPayload) =>
          id
            ? http.patch<ModelProfileDto>(ENDPOINTS.admin.model(id), payload)
            : http.post<ModelProfileDto>(ENDPOINTS.admin.models, payload),
      },
      /** 场景库（点4）：管理列表 / 下拉选项 / 增改删 */
      scenes: {
        list: (query: PageQuery = {}) =>
          http.get<ScenePage>(ENDPOINTS.admin.scenes, { params: query }),
        /** 场次表单下拉：一次带出全部在用场景（含照片/简介，供自动填充） */
        options: () => http.get<SceneDto[]>(ENDPOINTS.admin.sceneOptions),
        upsert: (id: string | null, payload: SceneUpsertPayload) =>
          id
            ? http.patch<{ id: string }>(ENDPOINTS.admin.scene(id), payload)
            : http.post<{ id: string }>(ENDPOINTS.admin.scenes, payload),
        remove: (id: string) => http.delete<{ id: string }>(ENDPOINTS.admin.scene(id)),
      },
      registrations: {
        list: (query: AdminRegistrationListQuery = {}) =>
          http.get<AdminRegistrationPage>(ENDPOINTS.admin.registrations, { params: query }),
        /** 手动录入线下报名：不扣积分，收款状态由运营选择 */
        create: (payload: AdminRegistrationCreatePayload) =>
          http.post<RegistrationDto>(ENDPOINTS.admin.registrations, payload),
        /** 按微信号校验报名账号，返回昵称与有效等级 */
        lookup: (wechatId: string) =>
          http.get<AdminRegistrationLookupDto>(ENDPOINTS.admin.registrationLookup, { params: { wechatId } }),
        /** 下拉选人选项：手动录入 / 发券共用，keyword 模糊搜微信号或昵称 */
        userOptions: (query: AdminUserOptionsQuery = {}) =>
          http.get<AdminUserOptionDto[]>(ENDPOINTS.admin.registrationUserOptions, { params: query }),
        act: (id: string, payload: AdminRegistrationActionPayload) =>
          http.patch<RegistrationDto>(ENDPOINTS.admin.registration(id), payload),
        /** 非会员线下支付后，运营确认收款 */
        confirmPayment: (id: string) =>
          http.post<RegistrationDto>(ENDPOINTS.admin.confirmPayment(id)),
        /**
         * 现场批量签到 / 批量确认收款。
         * 逐条校验状态机：不合法的那几条进 skipped，不影响其余成功项。
         */
        batch: (payload: AdminRegistrationBatchPayload) =>
          http.post<AdminRegistrationBatchResult>(ENDPOINTS.admin.registrationBatch, payload),
      },
      refunds: {
        list: (query: AdminRefundListQuery = {}) =>
          http.get<AdminRefundOrderPage>(ENDPOINTS.admin.refunds, { params: query }),
        review: (id: string, payload: RefundReviewPayload) =>
          http.post<RefundOrderDto>(ENDPOINTS.admin.refundReview(id), payload),
        /** 线下退款实际完成：补记经办人与时间（非会员退款的对账痕迹） */
        settle: (id: string, payload: RefundSettlePayload = {}) =>
          http.post<RefundOrderDto>(ENDPOINTS.admin.refundSettle(id), payload),
      },
      balance: {
        /** 一步调账：提交即入账（走账本），返回调账单与入账后可用余额 */
        adjust: (payload: BalanceAdjustmentPayload) =>
          http.post<{ id: string; status: string; availableCent: number }>(ENDPOINTS.admin.balanceAdjustments, payload),
        transactions: (query: AdminBalanceTxnListQuery = {}) =>
          http.get<BalanceTransactionPage>(ENDPOINTS.admin.balanceTransactions, { params: query }),
      },
      memberships: {
        grant: (payload: MembershipGrantPayload) =>
          http.post<MembershipDto>(ENDPOINTS.admin.memberships, payload),
        revoke: (id: string, payload: MembershipRevokePayload) =>
          http.post<MembershipDto>(ENDPOINTS.admin.membershipRevoke(id), payload),
      },
      votes: {
        list: () =>
          http.get<{ list: AdminVoteCampaignDto[]; total: number; page: number; pageSize: number }>(
            ENDPOINTS.admin.voteCampaigns,
          ),
        create: (payload: VoteCampaignCreatePayload) =>
          http.post<VoteCampaignDto>(ENDPOINTS.admin.voteCampaigns, payload),
        update: (id: string, payload: VoteCampaignPatchPayload) =>
          http.patch<VoteCampaignDto>(`${ENDPOINTS.admin.voteCampaigns}/${id}`, payload),
        /** 草稿 → 开放投票 */
        open: (id: string) =>
          http.post<VoteCampaignDto>(ENDPOINTS.admin.voteOpen(id)),
        publish: (id: string) =>
          http.post<VoteCampaignDto>(ENDPOINTS.admin.votePublish(id)),
        /** 实时票数 + 投票人明细 */
        live: (id: string) =>
          http.get<VoteLiveDto>(ENDPOINTS.admin.voteLive(id)),
      },
      audit: {
        logs: (query: PageQuery & { action?: string; keyword?: string } = {}) =>
          http.get<AuditLogPage>(ENDPOINTS.admin.auditLogs, { params: query }),
        permissions: (query: PageQuery & { action?: string; keyword?: string } = {}) =>
          http.get<{ list: PermissionLogDto[]; total: number; page: number; pageSize: number }>(
            ENDPOINTS.admin.permissionLogs,
            { params: query },
          ),
      },
      exports: (payload: { target: string; filters?: Record<string, unknown> }) =>
        http.post<{ url: string; traceId: string }>(ENDPOINTS.admin.exports, payload),

      /**
       * 会员批量导入。
       * preview 用 FormData（multipart），由 http 的 axios 实例直接发送；
       * commit 走普通 JSON，服务端会重新校验每一行。
       */
      membersImport: {
        preview: (file: File) => {
          const form = new FormData();
          form.append('file', file);
          return http.post<MemberImportPreviewDto>(ENDPOINTS.admin.membersImportPreview, form);
        },
        commit: (payload: MemberImportCommitPayload) =>
          http.post<MemberImportResultDto>(ENDPOINTS.admin.membersImportCommit, payload),
        /**
         * 模板下载是 GET，调用方负责触发保存。
         * 必须带上 API_BASE_PATH：ENDPOINTS 里的路径不含 /api/v1 前缀（那是 axios 的 baseURL 拼的），
         * 直接用 ENDPOINTS 值当链接会打开一个不存在的 SPA 路由，表现为「点下载后页面空白」。
         */
        templateUrl: `${API_BASE_PATH}${ENDPOINTS.admin.membersImportTemplate}`,
      },

      /** 图片上传：单文件 multipart，返回同源 URL */
      upload: (file: File) => {
        const form = new FormData();
        form.append('file', file);
        return http.post<UploadResultDto>(ENDPOINTS.admin.uploads, form);
      },

      /** 场次海报配置：固定报名二维码 */
      posterSettings: {
        get: () => http.get<PosterSettingsDto>(ENDPOINTS.admin.posterSettings),
        update: (payload: PosterSettingsUpdatePayload) =>
          http.put<PosterSettingsDto>(ENDPOINTS.admin.posterSettings, payload),
      },

      /** 会员管理页的用户列表 */
      members: {
        list: (query: PageQuery & { keyword?: string; level?: string } = {}) =>
          http.get<AdminUserListPage>(ENDPOINTS.admin.users, { params: query }),
        /** 后台创建用户（代注册 / 补录），不授予运维角色 */
        create: (payload: AdminCreateUserPayload) =>
          http.post<AdminUserListItemDto>(ENDPOINTS.admin.users, payload),
        /** 编辑用户：昵称/手机号/等级/有效期/角色/状态；微信号不可改 */
        update: (id: string, payload: AdminUpdateUserPayload) =>
          http.patch<{ id: string }>(ENDPOINTS.admin.user(id), payload),
        /** 重置密码（仅管理员/运维账号）：返回一次性临时口令 */
        resetPassword: (payload: AdminResetPasswordPayload) =>
          http.post<{ wechatId: string; temporaryPassword: string }>(ENDPOINTS.admin.userResetPassword, payload),
      },

      /** 注册邀请码：列表 / 批量生成 / 作废 */
      inviteCodes: {
        list: (query: Partial<InviteCodeListQueryInput> = {}) =>
          http.get<InviteCodePage>(ENDPOINTS.admin.inviteCodes, { params: query }),
        create: (payload: InviteCodeCreatePayload) =>
          http.post<InviteCodeCreateResultDto>(ENDPOINTS.admin.inviteCodes, payload),
        revoke: (id: string) =>
          http.post<{ id: string }>(ENDPOINTS.admin.inviteCodeRevoke(id)),
      },

      /** 优惠券：按微信号批量发放 / 列表 / 作废（仅未使用可作废） */
      coupons: {
        list: (query: Partial<AdminCouponListQueryInput> = {}) =>
          http.get<{ list: AdminCouponDto[]; total: number; page: number; pageSize: number }>(
            ENDPOINTS.admin.coupons,
            { params: query as AdminCouponListQuery },
          ),
        issue: (payload: AdminCouponIssuePayload) =>
          http.post<CouponIssueResultDto>(ENDPOINTS.admin.coupons, payload),
        revoke: (id: string) =>
          http.post<{ id: string }>(ENDPOINTS.admin.couponRevoke(id)),
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
