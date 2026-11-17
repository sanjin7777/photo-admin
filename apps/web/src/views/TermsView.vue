<script setup lang="ts">
import { LEGAL_VERSION } from '@photo/shared';
</script>

<template>
  <section class="mx-auto max-w-3xl px-5 py-8">
    <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-900">← 返回</RouterLink>
    <h1 class="mt-3 text-2xl font-semibold text-slate-900">用户协议</h1>
    <p class="mt-1 text-xs text-slate-500">生效日期：{{ LEGAL_VERSION }}</p>

    <div class="mt-6 space-y-5 text-sm leading-relaxed text-slate-600">
      <div>
        <h2 class="text-base font-semibold text-slate-900">一、服务说明</h2>
        <p class="mt-1">
          本站为猫爪社摄影会（下称「本会」）的会员内部活动管理系统，仅限受邀会员使用，
          用于发布摄影活动场次、受理活动登记、记录积分与权益券，全程不进行任何在线交易与收款，不面向不特定公众提供经营性信息服务。
          注册需持有效邀请码，邀请码一码一次。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">二、账号</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>微信号是唯一登录标识，一人一号，不得转借、出租或买卖。</li>
          <li>请妥善保管密码；因自行泄露导致的损失由账号持有人承担。</li>
          <li>发现账号异常请立即联系客服，本会可对异常账号采取临时冻结措施。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">三、积分规则</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>积分是本会内部的活动权益单位，仅面向 VIP / SVIP 会员开放，用于登记时结算活动参与额度。</li>
          <li>积分由本会运营按会员等级、参与记录或活动奖励直接发放，会员无需支付任何费用即可获得。</li>
          <li>积分不可购买、不可提现、不可转让、不可兑换现金或任何财物，也不可在本会活动之外使用。</li>
          <li>积分不设退还机制；会员退出会籍时，账户内积分随之失效。</li>
          <li>登记时系统按会员等级与可用权益券计算本次消耗的积分并即时扣减；取消登记按本协议第五条处理。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">四、活动登记</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>本会活动通过本站「登记」形式预约席位，涉及的费用与结算由本会在线下另行安排，本站不进行任何在线收款。</li>
          <li>会员登记按所属等级结算积分；普通用户登记后由运营核对身份并确认名额。</li>
          <li>登记完成后生成电子票根，凭票根编号到场核销。</li>
          <li>每个名额最多使用一张权益券，券在取消登记后自动退回，未过期可再次使用。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">五、取消与退回</h2>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li>场次页会展示该场的免费取消时限，在该时限前取消不扣除积分。</li>
          <li>逾期取消按场次规则扣减相应积分，扣减比例以登记时的规则快照为准。</li>
          <li>取消登记后，已扣积分按规则退回积分账户，名额同时释放。</li>
          <li>线下付款的登记，取消后请联系客服处理退款事宜，不走积分退回。</li>
          <li>因本会原因取消场次，已扣积分全额退回；线下付款由客服安排退款。</li>
        </ul>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">六、肖像与作品</h2>
        <p class="mt-1">
          本会活动会有摄影环节。登记即表示同意本会在活动记录与宣传渠道中使用含本人形象的影像；
          如不同意，请在登记前书面告知客服，本会将作特别安排。模特肖像授权以单独签署的授权书为准。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">七、行为规范</h2>
        <p class="mt-1">
          不得利用本站发布违法违规信息、干扰系统运行、批量注册或冒用他人身份。
          违反的，本会可限制功能、冻结或注销账号，并保留追究法律责任的权利。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">八、免责与责任限制</h2>
        <p class="mt-1">
          本会尽力保障系统稳定与数据准确，但因网络故障、不可抗力或第三方原因导致的中断，
          本会在合理范围内协助恢复，不承担由此产生的间接损失。积分与账目以站内流水记录为准。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">九、协议变更</h2>
        <p class="mt-1">
          本协议更新时会在站内公示新版本并重新征求同意；不同意新版的可停止使用并申请退还剩余积分。
        </p>
      </div>

      <div>
        <h2 class="text-base font-semibold text-slate-900">十、争议解决与联系方式</h2>
        <p class="mt-1">
          因本协议产生的争议，双方应友好协商；协商不成的，提交本会所在地有管辖权的人民法院处理。
          如有疑问，请通过站内「联系客服」与我们联系。
        </p>
      </div>
    </div>

    <div class="mt-8 border-t border-slate-200 pt-4 text-center text-xs text-slate-500">
      <p>猫爪社摄影会 · 湘ICP备2026012181号-2</p>
      <p class="mt-1"><RouterLink to="/privacy" class="hover:text-slate-700">查看《隐私政策》</RouterLink></p>
    </div>
  </section>
</template>
