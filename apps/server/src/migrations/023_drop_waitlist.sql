-- ============================================================================
-- 023 候补功能下线：删除候补相关列
--
-- 背景（2026-11-13 用户决策）：候补/递补链路整体下线，满员即拒绝，不做排队。
--   代码侧已删除 promoteNextWaitlisted / expireStaleOffers / confirmOffer 与
--   force-offer 路由，DTO 与 shared 契约不再暴露 waitSeq / offerExpireAt /
--   allowWaitlist / waitlistCount / canWaitlist。
--
-- 设计：
--   1. events.allow_waitlist 不再有写入方，也没有读取方 → 删除。
--   2. registrations.wait_seq / offer_expire_at 仅服务候补队列与递补确认窗口，
--      两处逻辑均已删除 → 删除。
--   3. registrations.status 的 ENUM **保留** WAITLISTED / OFFERED / EXPIRED：
--      历史库里仍有这些行，收窄 ENUM 会让它们变成非法值（严格模式下更新直接报错），
--      且前端仍需要把它们展示成「候补中 / 待确认递补 / 已失效」。存量行会随
--      「取消场次」被置为 EXPIRED，或被用户自行取消。
--   4. idx_queue 原本是 (event_id, status, wait_seq)，删列后会自动缩成
--      (event_id, status)，语义正好变成「按场次查活跃报名」，保留不动。
--
-- 回滚思路：
--   ALTER TABLE events
--     ADD COLUMN allow_waitlist TINYINT(1) NOT NULL DEFAULT 1 AFTER capacity_used;
--   ALTER TABLE registrations
--     ADD COLUMN wait_seq INT UNSIGNED DEFAULT NULL COMMENT '候补队列序号',
--     ADD COLUMN offer_expire_at DATETIME(3) DEFAULT NULL COMMENT '递补确认截止时间';
--   ALTER TABLE registrations DROP KEY idx_queue, ADD KEY idx_queue (event_id, status, wait_seq);
--   回滚后列结构恢复，但**队列序号与递补截止时间的历史值已丢失**（删列即删数据）；
--   如需保留历史值，请在执行本迁移前先 SELECT 备份到临时表。
-- ============================================================================

ALTER TABLE events DROP COLUMN allow_waitlist;

ALTER TABLE registrations
  DROP COLUMN wait_seq,
  DROP COLUMN offer_expire_at;
