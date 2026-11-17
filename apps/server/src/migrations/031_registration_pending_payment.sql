-- ============================================================================
-- 031：报名新增「待支付」状态（非会员线上登记先占名额，确认收款后才算已确认）
--
-- 背景（2026-11-17 用户反馈）：
--   普通用户点「登记」后记录直接落到 CONFIRMED（已确认），但钱还没收——
--   用户以为登记成功就能到场，运营却还要线下收款，两边口径不一致。
--   现改为：非会员线上登记落 PENDING_PAYMENT（待支付），运营确认收款后才转 CONFIRMED。
--
-- 设计取舍：
--   · PENDING_PAYMENT 仍占名额（capacity_used 已累加），只是「未确认」；
--   · 待支付可直接取消：没有资金流动，不产生退款单，直接退名额、退券；
--   · 存量数据不回填：历史 CONFIRMED+UNPAID 行保持原状（确认收款只改 payment_status），
--     避免把已经线下沟通过的旧单突然变成「待支付」引起困惑。
--   · ENUM 只在尾部追加会打乱既有值的序号，这里显式列出完整集合（含历史候补状态）。
--
-- 回滚（需先确认没有 PENDING_PAYMENT 行，否则这些行会被截断成空串）：
--   UPDATE registrations SET status = 'CONFIRMED' WHERE status = 'PENDING_PAYMENT';
--   ALTER TABLE registrations MODIFY COLUMN status
--     ENUM('WAITLISTED','OFFERED','EXPIRED','CONFIRMED','REFUND_PENDING','REFUNDED','CHECKED_IN','COMPLETED','CANCELLED') NOT NULL;
-- ============================================================================

ALTER TABLE registrations
  MODIFY COLUMN status ENUM(
    'WAITLISTED','OFFERED','EXPIRED','PENDING_PAYMENT',
    'CONFIRMED','REFUND_PENDING','REFUNDED','CHECKED_IN','COMPLETED','CANCELLED'
  ) NOT NULL;

SELECT COUNT(*) AS registrations_rows FROM registrations;
