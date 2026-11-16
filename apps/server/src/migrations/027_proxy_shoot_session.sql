-- ============================================================================
-- 027：代拍（独立于常规时段的报名项）
--
-- 业务背景：
--   摄影活动支持「代拍」——由摄影师代替会员拍摄，会员不必亲自到场。
--   代拍**不占用任何常规时段**，但每个场次都应默认提供一场，价格与正常报名一致。
--
-- 为什么复用 event_sessions 而不是新建表：
--   报名链路（容量扣减、积分冻结、优惠券核销、票根、签到、回避名单）全部围绕
--   registrations.session_id 构建。给代拍一个 kind='PROXY' 的时段行，
--   这些机制**无需改动**即可复用，也避免了第二套报名流程。
--
-- 回滚：
--   ALTER TABLE event_sessions DROP COLUMN kind;
--   （代拍行随列删除一起消失，不影响常规时段）
-- ============================================================================

SET @db := DATABASE();

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = @db AND table_name = 'event_sessions' AND column_name = 'kind'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE event_sessions ADD COLUMN kind ENUM(''NORMAL'',''PROXY'') NOT NULL DEFAULT ''NORMAL'' COMMENT ''NORMAL=常规时段；PROXY=代拍（独立于时段，每场一个）'' AFTER event_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 同一场次最多一个代拍行：用生成列 + 唯一索引兜底，防止并发下建出两个
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = @db AND table_name = 'event_sessions' AND index_name = 'uk_event_proxy'
);
SET @sql2 := IF(@has_idx = 0,
  'ALTER TABLE event_sessions ADD COLUMN proxy_guard TINYINT GENERATED ALWAYS AS (IF(kind = ''PROXY'', 1, NULL)) STORED, ADD UNIQUE KEY uk_event_proxy (event_id, proxy_guard)',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.columns
 WHERE table_schema = @db AND table_name = 'event_sessions' AND COLUMN_NAME IN ('kind','proxy_guard');
