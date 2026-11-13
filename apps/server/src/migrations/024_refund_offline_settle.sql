-- ============================================================================
-- 024 退款对账痕迹：区分「系统已退款」与「线下已实际退款」
--
-- 背景（2026-11-13 优化项 P1）：非会员（payment_status = UNPAID / PAID）走线下支付，
--   审核通过时系统只把退款单置为 REFUNDED、把报名置为 REFUNDED，但钱是运营在
--   线下退给用户的。原实现里这类退款单的 balance_txn_id 恒为 NULL，与「会员回充」
--   完全无法区分，财务对账时看不出「系统里已通过、线下其实还没退」的挂账。
--
-- 设计：
--   1. refund_orders 增加 settled_by / settled_at / settle_remark 三列：
--      · 会员（NOT_REQUIRED）审核通过时，账本 UNFREEZE 即为资金落定，
--        在同一事务内自动写入 settled_by=审核人、settled_at=now；
--      · 非会员审核通过时**不写** settled_*，此时退款单是「已批准、待线下付款」，
--        运营实际退款后再调 POST /admin/refunds/:id/settle 补记经办人与时间。
--   2. 由此得到一条可查询的对账口径：
--        SELECT * FROM refund_orders
--         WHERE status = 'REFUNDED' AND settled_at IS NULL;
--      结果就是「系统已批准、线下尚未退款」的挂账清单。
--   3. 不改 status ENUM：REFUNDED 仍表示「审核流程已完成」，settled_at 才是资金口径。
--      这样既不破坏历史数据，也不改变既有状态机与前端分支。
--
-- 回滚思路：三列均为纯留痕字段，无业务逻辑依赖，直接删除即可（会丢失已记录的
--   线下退款经办人与时间，如需留档请先备份）：
--   ALTER TABLE refund_orders
--     DROP COLUMN settled_by,
--     DROP COLUMN settled_at,
--     DROP COLUMN settle_remark;
-- ============================================================================

ALTER TABLE refund_orders
  ADD COLUMN settled_by BIGINT UNSIGNED DEFAULT NULL
    COMMENT '线下退款实际经办人；会员回充时由系统在审核事务内写入' AFTER balance_txn_id,
  ADD COLUMN settled_at DATETIME(3) DEFAULT NULL
    COMMENT '资金实际落定时间；为 NULL 且 status=REFUNDED 表示待线下退款' AFTER settled_by,
  ADD COLUMN settle_remark VARCHAR(200) DEFAULT NULL
    COMMENT '线下退款备注（转账尾号、经办渠道等）' AFTER settled_at,
  ADD KEY idx_unsettled (status, settled_at);
