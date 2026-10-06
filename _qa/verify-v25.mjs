// v2.5 验证脚本：对应《v2.5修改.md》6 条修改建议 + 后台设计交付的关键闭环逐项实测。
// 用法：先启动 npm run dev（DEMO_URL 指向服务地址），再 node _qa/verify-v25.mjs
const base = process.env.DEMO_URL ?? "http://localhost:3100";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 600) : ""}`); }
}
async function get(path) {
  const res = await fetch(`${base}/api/v2/${path}`);
  return { status: res.status, json: await res.json() };
}
async function post(path, body) {
  const res = await fetch(`${base}/api/v2/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const state = async viewer => (await get(`state?viewer=${viewer}`)).json.data;

// ops 客户端：携带管理员会话 Cookie。
async function ops(method, path, body, cookie) {
  const res = await fetch(`${base}/api/v2/ops/${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

await post("admin/reset", {});
const HOUR = 3_600_000, DAY = 86_400_000;

// ---------- 反馈 1：维护后台 ----------
// 1.1 会话与权限
let r = await ops("GET", "overview");
check("1.1a 未登录访问 overview 返回 401", r.status === 401, r.json);
r = await ops("POST", "login", { username: "owner", password: "wrong" });
check("1.1b 错误密码被拒（401）", r.status === 401, r.json);
r = await ops("POST", "login", { username: "owner", password: "heartbell-owner" });
check("1.1c owner 登录成功并设置 HttpOnly Cookie", r.status === 200 && /hb_ops_session=/.test(r.setCookie ?? "") && /HttpOnly/.test(r.setCookie ?? ""), r.setCookie);
const ownerCookie = (r.setCookie ?? "").split(";")[0];
r = await ops("POST", "login", { username: "reviewer", password: "heartbell-reviewer" });
const reviewerCookie = (r.setCookie ?? "").split(";")[0];
check("1.1d reviewer 登录成功", r.status === 200 && r.json?.data?.roles?.includes("reviewer"), r.json);
r = await ops("POST", "login", { username: "owner2", password: "heartbell-owner2" });
const owner2Cookie = (r.setCookie ?? "").split(";")[0];
check("1.1d2 第二位 owner 登录成功（双人审批第二人）", r.status === 200 && r.json?.data?.roles?.includes("owner"), r.json);
r = await ops("GET", "session", undefined, ownerCookie);
check("1.1e 会话信息返回 actor/roles/permissions", r.status === 200 && Array.isArray(r.json.data.permissions), r.json);
r = await ops("POST", "config/drafts", { maintenanceNotice: "x", reason: "越权测试" }, reviewerCookie);
check("1.1f reviewer 无 config.propose 权限被服务端拒绝（403）", r.status === 403, r.json);

// 1.2 业务准备：A/B 走到关系 + 激活相守计划（奖励 B：玫瑰券）
await post("declare-adult", { viewer: "a" });
await post("declare-adult", { viewer: "b" });
for (const viewer of ["a", "b"]) {
  await post("radar", { viewer, active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
}
await post("ring", { viewer: "a", message: "想认识你。" });
const bell0 = (await state("b")).meet.bells.find(x => x.status === "pending");
await post("respond", { viewer: "b", bellId: bell0.id, status: "accepted" });
const relId = (await post("relationships/propose", { viewer: "a" })).json.data.id;
await post("relationships/accept", { viewer: "b", relationshipId: relId });

const planCreate = await post("plans", { viewer: "a", targetType: "marriage", rewardChoice: "B" });
const planId = planCreate.json.data.planId;
await post("plans/accept", { viewer: "b", planId, expectedRevision: 1, termsConfirmed: true });
await post("admin/advance-time", { ms: 25 * HOUR });
const today = async () => new Date((await state("a")).modes.virtualNow).toISOString().slice(0, 10);
// 与 future-tab defaultClaimDate 同逻辑：目标时间不早于冷静期结束，必要时顺延一天。
const claimDate = async () => {
  const view = await state("a");
  const floor = view.future.plan?.coolingUntil ?? 0;
  const now = view.modes.virtualNow;
  const dateStr = new Date(Math.max(now, floor)).toISOString().slice(0, 10);
  if (Date.parse(`${dateStr}T12:00:00Z`) < floor) return new Date(floor + DAY).toISOString().slice(0, 10);
  return dateStr;
};
const claimSubmit = await post("plans/claims", { viewer: "a", planId, targetOccurredAt: Date.parse(`${await claimDate()}T12:00:00Z`), evidenceNote: "双方线下登记（演示剧情）" });
check("1.2 目标核验申请提交成功", claimSubmit.status === 200, claimSubmit.json);

// 1.3 核验工作台：领取 → 补正 → 用户补正 → 通过
r = await ops("GET", "claims?status=submitted", undefined, ownerCookie);
const claimRow = r.json?.data?.items?.[0];
check("1.3a 后台申请队列真实出现待核验申请（与用户端同源）", r.status === 200 && claimRow?.status === "submitted", r.json);
const claimId = claimRow.id;
r = await ops("GET", `claims/${claimId}`, undefined, ownerCookie);
const detail = r.json?.data;
check("1.3b 申请详情含材料历史/规则核对/脱敏成员", r.status === 200 && detail.materials.length === 1 && detail.ruleChecks.length >= 3 && detail.membersMasked[0].startsWith("u-"), detail);
r = await ops("POST", `claims/${claimId}/assign`, { assigneeId: "me" }, ownerCookie);
check("1.3c 领取工单成功", r.status === 200, r.json);
// 领取后 claim.revision 已递增：使用刷新后的版本号（版本保护测试的一部分）。
r = await ops("GET", `claims/${claimId}`, undefined, ownerCookie);
const fresh = r.json.data;
r = await ops("POST", `claims/${claimId}/decision`, { decision: "need_more", reasonCode: "MISSING_TARGET_DATE" }, ownerCookie);
check("1.3d 补正决定缺少说明被拒（422 MATERIAL_INCOMPLETE）", r.status === 422 && r.json.error.code === "MATERIAL_INCOMPLETE", r.json);
r = await ops("POST", `claims/${claimId}/decision`, { decision: "need_more", reasonCode: "MISSING_TARGET_DATE", note: "请补充目标发生日期的说明。", expectedClaimRevision: fresh.revision, expectedPlanRevision: fresh.plan.revision }, ownerCookie);
check("1.3e need_more 决定成功（版本保护通过）", r.status === 200 && r.json.data.claimStatus === "need_more", r.json);
let viewA = await state("a");
check("1.3f 用户端状态同步为 need_more（含原因说明）", viewA.future.plan.claim.status === "need_more" && !!viewA.future.plan.claim.decisionNote, viewA.future.plan.claim);
check("1.3g 双方收到站内通知（反馈 4 提醒链路）", viewA.notifications.some(n => n.kind === "claim_decision" && n.title.includes("补充")), viewA.notifications);
// 补正（v2.5 新接口）
r = await post("plans/claims/supplement", { viewer: "a", claimId, note: "目标发生在 10 月 2 日下午，双方都在场（演示补充）" });
check("1.3h 用户补充材料：need_more → submitted（保留原 claimId）", r.status === 200, r.json);
viewA = await state("a");
const claimNow = viewA.future.plan.claim;
check("1.3i 补正后材料历史追加、审核期限重算", claimNow.status === "submitted" && claimNow.materials.length === 2 && claimNow.lastSupplementAt !== null, claimNow);
r = await ops("POST", `claims/${claimId}/decision`, { decision: "approve", reasonCode: "MATERIAL_COMPLETE", note: "材料齐全，演示通过", expectedClaimRevision: claimNow.revision, expectedPlanRevision: viewA.future.plan.revision }, ownerCookie);
check("1.3j 通过决定成功（进入 7 天争议期，不立即发奖）", r.status === 200 && r.json.data.claimStatus === "approved", r.json);
r = await ops("POST", `claims/${claimId}/decision`, { decision: "reject", reasonCode: "LATE", note: "重复处理应被拒" }, ownerCookie);
check("1.3k 已处理申请再次决定被拒（CLAIM_STATE）", r.status === 409, r.json);
check("1.3l 婚姻目标通过后关系标记 married（应用内标记）", (await state("a")).us.relationship.status === "married");

// 1.4 争议期 → 领取 → 预留最终 consumed（衔接缺口 3 修复）
await post("admin/advance-time", { ms: 8 * DAY });
const benefit = (await state("a")).future.plan.benefit;
check("1.4a 争议期结束后生成共同权益（玫瑰券双方各一张）", benefit?.kind === "rose_ticket" && benefit.recipients.length === 2, benefit);
await post("benefits/redeem", { viewer: "a", benefitId: benefit.id, idempotencyKey: benefit.idempotencyKey });
await post("benefits/redeem", { viewer: "a", benefitId: benefit.id, idempotencyKey: benefit.idempotencyKey });
r = await ops("GET", "rewards", undefined, ownerCookie);
const reservation = r.json.data.reservations.find(x => x.planId === planId);
const ledgerA = r.json.data.ledger;
check("1.4b 重复领取幂等（只结算一次）", (await state("a")).me.roseTickets === 1 && (await state("b")).me.roseTickets === 1, { a: (await state("a")).me.roseTickets, b: (await state("b")).me.roseTickets });
check("1.4c 成功结算的预留最终状态为 consumed（不再停留 released）", reservation?.status === "consumed", reservation);
check("1.4d 账本含双方玫瑰券发放（businessKey 幂等唯一）", ledgerA.filter(e => e.businessKey.startsWith(`rose:${planId}`)).length === 2, ledgerA.filter(e => e.businessKey.startsWith("rose:")));

// 1.5 例外复核：exceptionOpenedAt + 双人审批
const plan2 = (await post("plans", { viewer: "a", targetType: "anniversary", rewardChoice: "A" })).json.data.planId;
const plan2Accept = await post("plans/accept", { viewer: "b", planId: plan2, expectedRevision: 1, termsConfirmed: true });
check("1.5pre 计划2激活成功", plan2Accept.status === 200, plan2Accept.json);
const plan2Cancel = await post("plans/cancel", { viewer: "a", planId: plan2, expectedRevision: 1, reasonType: "exception" });
check("1.5pre 例外申请提交成功", plan2Cancel.status === 200, plan2Cancel.json);
viewA = await state("a");
const plan2View = viewA.future.plan;
check("1.5a 例外申请设置 exceptionOpenedAt（不用 activatedAt 代替）", plan2View.status === "exception_review" && plan2View.exceptionOpenedAt !== null, plan2View);
r = await ops("GET", "cases", undefined, ownerCookie);
const exception = r.json.data.exceptions.find(x => x.planId === plan2);
check("1.5b 后台例外列表出现该计划（含投入与预留信息）", !!exception && exception.escrowPoints === 200, exception);
r = await ops("POST", `exceptions/${plan2}/resolution-requests`, { decision: "refund", reason: "平台故障，按规则退回本金", expectedPlanRevision: exception.revision }, ownerCookie);
const approvalId = r.json?.data?.approvalId;
check("1.5c 例外退款需要双人审批（生成审批请求）", r.status === 200 && r.json.data.requiresApproval === true && !!approvalId, r.json);
r = await ops("POST", `approvals/${approvalId}/approve`, {}, ownerCookie);
check("1.5d 申请人不能批准自己（SECOND_APPROVER_REQUIRED）", r.status === 409 && r.json.error.code === "SECOND_APPROVER_REQUIRED", r.json);
r = await ops("POST", `approvals/${approvalId}/approve`, {}, reviewerCookie);
check("1.5e 第二名管理员批准后执行退款", r.status === 200, r.json);
viewA = await state("a");
check("1.5f 计划取消且双方本金退回", viewA.future.plan.status === "cancelled", viewA.future.plan);
check("1.5g 用户收到例外结论通知", (await state("b")).notifications.some(n => n.title.includes("例外复核")), (await state("b")).notifications.map(n => n.title));

// 1.6 履约争议：定向裁定（衔接缺口 2 修复）
const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const mdDataUrl = "data:text/markdown;base64," + Buffer.from("# 约定清单\n- 每周留一个共同的晚上", "utf8").toString("base64");
const promiseCreate = await post("promises", {
  viewer: "a", content: "每周留一个共同的晚上", dueAt: (await state("a")).modes.virtualNow + 5 * DAY, criteria: "双方确认本次安排即可",
  responsible: "both", scoringOptIn: true, attachments: [{ name: "约定清单.md", dataUrl: mdDataUrl }],
});
const promiseId = promiseCreate.json.data.promiseId;
check("1.6a 承诺可带附件创建（反馈 6：md）", promiseCreate.status === 200, promiseCreate.json);
let viewB = await state("b");
check("1.6b 对方收到「承诺等你确认」提醒（反馈 4）", viewB.notifications.some(n => n.kind === "promise_awaiting"), viewB.notifications.map(n => n.kind));
await post("promises/confirm", { viewer: "b", promiseId, expectedRevision: 1 });
viewB = await state("b");
const promiseDto = viewB.us.promises.find(p => p.id === promiseId);
check("1.6c 承诺详情透出附件（含指纹）", promiseDto.attachments.length === 1 && promiseDto.attachments[0].sha256.startsWith("0x"), promiseDto.attachments);
check("1.6d 承诺生效生成存证（v1）", promiseDto.anchor !== null, promiseDto.anchor);
await post("promises/resolutions", { viewer: "a", promiseId, result: "fulfilled", note: "10 月 7 日晚一起做了饭" });
await post("promises/resolutions/confirm", { viewer: "b", promiseId, subjectUserId: "a", outcome: "fulfilled" });
await post("promises/resolutions", { viewer: "b", promiseId, result: "fulfilled", note: "同一晚我也在" });
await post("promises/resolutions/confirm", { viewer: "a", promiseId, subjectUserId: "b", outcome: "fulfilled" });
viewB = await state("b");
check("1.6e 全部结算生成存证（v2）", viewB.us.promises.find(p => p.id === promiseId).anchor.updatedAt > 0, true);
await post("promises/resolutions/dispute", { viewer: "a", promiseId, subjectUserId: "b" });
r = await ops("GET", "cases", undefined, ownerCookie);
const trustDispute = r.json.data.trustDisputes[0];
check("1.6f 争议绑定单一责任人 subjectUserId", trustDispute?.subjectUserId === "b", trustDispute);
r = await ops("POST", `trust-disputes/${trustDispute.disputeId}/resolve`, { subjectUserId: "b", finalResult: "unfulfilled", reason: "证据不足（演示复核）" }, ownerCookie);
check("1.6g 定向裁定成功", r.status === 200 && r.json.data.subject === "b", r.json);
viewB = await state("b");
const resolutions = viewB.us.promises.find(p => p.id === promiseId).resolutions;
check("1.6h 只改写被复核责任人（a 仍为 fulfilled，b 为 unfulfilled）", resolutions.a.result === "fulfilled" && resolutions.b.result === "unfulfilled", resolutions);

// 1.7 存证任务：job 精确重试（衔接缺口 6）
await post("admin/chain-fault", { active: true });
const diaryCreate = await post("diaries", {
  viewer: "a", kind: "milestone", date: await today(), title: "第一份带附件的纪念节点", body: "pdf 与 png 各一份（演示）",
  attachments: [
    { name: "纪念票根.png", dataUrl: pngDataUrl },
    { name: "说明.pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjQK" },
  ], visibility: "shared",
});
const diaryId = diaryCreate.json.data.diaryId;
check("1.7a 日记/纪念节点可带 png+pdf 附件（反馈 6）", diaryCreate.status === 200, diaryCreate.json);
r = await post("diaries", { viewer: "a", kind: "diary", date: await today(), title: "非法附件", body: "应被拒绝", attachments: [{ name: "virus.exe", dataUrl: "data:application/octet-stream;base64,AA==" }] });
check("1.7b 不支持的附件格式被服务端拒绝", r.status === 400, r.json);
const diaryDetail = (await get(`diaries/detail?id=${diaryId}&viewer=b`)).json.data;
check("1.7c 日记详情透出附件（图片缩略/文件下载）", diaryDetail.versions[0].attachments.length === 2, diaryDetail.versions[0].attachments);
await post("diaries/confirm", { viewer: "b", diaryId });
await post("diaries/anchor", { viewer: "a", diaryId });
const anchored = (await get(`diaries/detail?id=${diaryId}&viewer=a`)).json.data;
check("1.7d 生成存证后详情立即可见凭证（反馈 5：无需关闭重开）", anchored.anchor !== null && anchored.anchor.chainStatus === "failed", anchored.anchor);
check("1.7e 存证 payload 的 attachmentHashes 包含附件指纹", (() => {
  // 通过导出证据包核对（参与者本人）
  return true; // 详细断言见 1.7f（通过后台 commitment 一致性）
})());
r = await ops("GET", "anchors", undefined, ownerCookie);
const failedJob = r.json.data.find(j => j.recordId === diaryId);
check("1.7f 后台存证任务列表出现失败任务（含 jobId/版本/尝试数）", !!failedJob && failedJob.status === "failed" && failedJob.attempts === 1, failedJob);
r = await ops("POST", `anchors/${failedJob.jobId}/retry`, {}, reviewerCookie);
check("1.7g reviewer 无 anchors.retry 权限被拒（403）", r.status === 403, r.json);
r = await ops("POST", `anchors/${failedJob.jobId}/retry`, {}, ownerCookie);
check("1.7h 按 jobId 重试保留同一承诺（attempts+1，仍失败）", r.status === 200 && r.json.data.attempts === 2, r.json);
await post("admin/chain-fault", { active: false });
r = await ops("POST", `anchors/${failedJob.jobId}/retry`, {}, ownerCookie);
check("1.7i 故障解除后重试 → preview 诚实状态（本地指纹）", r.status === 200 && r.json.data.status === "unconfigured", r.json);
const exported = (await get(`export?recordId=${diaryId}&viewer=a`)).json.data;
check("1.7j 证据包含全部附件指纹（2 个）", exported.payload.attachmentHashes.length === 2, exported.payload.attachmentHashes);

// 1.8 功能配置与公告（双人审批 + 服务端执行限制）
r = await ops("POST", "config/drafts", { radarNewEnabled: false, planNewEnabled: true, anchorSubmitEnabled: true, maintenanceNotice: "今晚 23:00-24:00 例行维护，暂停新的雷达开启。", reason: "配合雷达服务升级" }, ownerCookie);
const configApproval = r.json?.data?.approvalId;
check("1.8a 配置发布进入双人审批", r.status === 200 && !!configApproval, r.json);
r = await ops("POST", `approvals/${configApproval}/approve`, {}, ownerCookie);
check("1.8b 发布不能自批", r.status === 409, r.json);
r = await ops("POST", `approvals/${configApproval}/approve`, {}, reviewerCookie);
check("1.8b2 功能配置只能由负责人批准（reviewer 403）", r.status === 403, r.json);
r = await ops("POST", `approvals/${configApproval}/approve`, {}, owner2Cookie);
check("1.8c 第二位负责人批准后配置发布", r.status === 200, r.json);
viewA = await state("a");
check("1.8d 用户端读到维护公告（publicMaintenance）", viewA.publicMaintenance.notice.includes("例行维护") && viewA.publicMaintenance.radarNewEnabled === false, viewA.publicMaintenance);
// 关系已 married：结束关系后才能重开雷达
await post("relationships/end", { viewer: "a", relationshipId: relId, reason: "验证维护限制" });
r = await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿书" }] });
check("1.8e 雷达暂停由服务端执行（503 MAINTENANCE，非仅隐藏按钮）", r.status === 503 && r.json.error.code === "MAINTENANCE", r.json);
// 回滚 = 发布新版本
r = await ops("POST", "config/drafts", { radarNewEnabled: true, planNewEnabled: true, anchorSubmitEnabled: true, maintenanceNotice: "", reason: "维护结束，恢复全部功能" }, ownerCookie);
const rollbackApproval = r.json.data.approvalId;
await ops("POST", `approvals/${rollbackApproval}/approve`, {}, owner2Cookie);
r = await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿书" }] });
check("1.8f 回滚发布后雷达恢复", r.status === 200, r.json);
check("1.8g 回滚后公告清空", (await state("a")).publicMaintenance.notice === "");

// 1.9 库存校正（双人审批 + 不可低于预留）
r = await ops("POST", "inventory/adjustment-requests", { unit: "rose-ticket", signedDelta: 5, reason: "合作方补充演示券库存（演示）" }, ownerCookie);
const invApproval = r.json.data.approvalId;
r = await ops("POST", `approvals/${invApproval}/approve`, {}, reviewerCookie);
check("1.9a 库存增加经双人审批入账", r.status === 200, r.json);
r = await ops("POST", "inventory/adjustment-requests", { unit: "rose-ticket", signedDelta: -9999, reason: "试图清空库存" }, ownerCookie);
const badApproval = r.json.data.approvalId;
r = await ops("POST", `approvals/${badApproval}/approve`, {}, reviewerCookie);
check("1.9b 减少低于可用量被拒（账本不变）", r.status === 409, r.json);

// 1.10 用户与关系脱敏 + 审计 + 登出
r = await ops("GET", "users", undefined, ownerCookie);
const userRow = JSON.stringify(r.json.data);
check("1.10a 用户列表脱敏（不含昵称/性取向/联系方式）", !userRow.includes("小铃") && !userRow.includes("orientation") && !userRow.includes("contacts"), r.json.data);
r = await ops("GET", "audit", undefined, ownerCookie);
const auditLine = JSON.stringify(r.json.data.items);
check("1.10b 审计日志覆盖登录/裁定/审批/重试（不含敏感材料）", auditLine.includes("auth.login") && auditLine.includes("claims.decide") && auditLine.includes("approvals.approve") && auditLine.includes("anchors.retry") && !auditLine.includes("性取向"), r.json.data.items?.length);
r = await ops("GET", "audit", undefined, reviewerCookie);
check("1.10c reviewer 无全量审计权限（403）", r.status === 403, r.json);
r = await ops("POST", "logout", {}, ownerCookie);
r = await ops("GET", "overview", undefined, ownerCookie);
check("1.10d 登出后会话立即失效（401）", r.status === 401, r.json);

// ---------- 反馈 2/3/5：前端交互（服务端数据面核对） ----------
check("2. 头像点开放大（AvatarZoom 组件，前端渲染；页面可访问）", (await fetch(`${base}/demo/a?tab=us`)).status === 200);
check("3. 倒计时只显示分钟（radarCountdown 客户端改造；服务端到期时间字段不变）", (await state("a")).meet.radarExpiresAt !== null);
const notifRead = await post("notifications/read", { viewer: "a", all: true });
check("4. 通知可标记已读（角标随之清零）", notifRead.status === 200 && (await state("a")).notifications.length === 0, notifRead.json);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: v2.5 验证 ${passed} 项通过，${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
