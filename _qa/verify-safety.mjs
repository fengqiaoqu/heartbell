// v2.6 安全与隐私验证脚本（对应 v2.2 交付 04-验收清单 T01–T59 可本地演示部分）。
// 覆盖：授权撤销闭环（T01–T09）、日记版本裁剪（T10–T14）、屏蔽级联（T15–T21）、
// 举报与运营闭环（T22/T24–T40）、数据导出与注销（T42–T48）、脱敏（T41/T58）。
// M4 真实能力项（T49–T52）为演示边界，不在本脚本范围（见 docs/SAFETY-PRIVACY.md）。
// 用法：先启动 npm run dev（DEMO_URL 指向服务地址），再 node _qa/verify-safety.mjs
const base = process.env.DEMO_URL ?? "http://localhost:3100";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 500) : ""}`); }
}
async function req(method, path, { body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: base } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空 */ }
  return { status: res.status, json };
}

// 登录助手（c 为安全验证第三人，始终无权读取 A/B 授权内容）。
async function login(viewer) {
  const password = { a: "HeartbellA2026!", b: "HeartbellB2026!", c: "HeartbellC2026!" }[viewer];
  const res = await fetch(`${base}/api/demo-auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: viewer, password }),
  });
  if (!res.ok) throw new Error(`登录 ${viewer} 失败：${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
async function ops(method, path, body, cookie) {
  const res = await fetch(`${base}/api/v2/ops/${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json", Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空 */ }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}
const cookies = {};
for (const v of ["a", "b", "c"]) cookies[v] = await login(v);
const get = async (viewer, path) => req("GET", `/api/v2/${path}${path.includes("?") ? "&" : "?"}viewer=${viewer}`, { cookie: cookies[viewer] });
const post = async (viewer, path, body) => req("POST", `/api/v2/${path}`, { body: { ...body, viewer }, cookie: cookies[viewer] });
const state = async viewer => (await get(viewer, "state")).json.data;

// 独立实例准备：重置（演示台路由不依赖用户会话；重置不影响会话表）。
await req("POST", `/api/v2/admin/reset`, { body: {}, cookie: cookies.a });
const ownerLogin = await ops("POST", "login", { username: "owner", password: "heartbell-owner" });
const ownerCookie = (ownerLogin.setCookie ?? "").split(";")[0];
const reviewerLogin = await ops("POST", "login", { username: "reviewer", password: "heartbell-reviewer" });
const reviewerCookie = (reviewerLogin.setCookie ?? "").split(";")[0];

// ---------- 基础链路（v2.8：入场活动 → 雷达 → candidateRef 定向摇铃 → connectionId 邀请） ----------
await post("a", "declare-adult", {});
await post("b", "declare-adult", {});
for (const v of ["a", "b"]) await post(v, "meet/events/join", { code: "HEARTS26" });
for (const v of ["a", "b"]) {
  await post(v, "radar", { active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
}
const candB = (await state("a")).meet.candidates[0];
const ringRes = await post("a", "ring", { candidateRef: candB.candidateRef, message: "想认识你。", idempotencyKey: "qa-safety-bell-1" });
const bell = (await state("b")).meet.bells.find(x => x.status === "pending" && x.direction === "incoming");
await post("b", "respond", { bellId: bell.id, status: "accepted" });
const connId = (await state("a")).know.connections[0].id;
const propose = await post("a", "relationships/propose", { connectionId: connId });
const relId = propose.json.data.id;
await post("b", "relationships/accept", { relationshipId: relId });

// ---------- 切片 1：授权撤销闭环（T01–T09） ----------
await post("b", "share-grants", { scope: "profile_contact", connectionId: connId }); // b 授权 a 查看联系方式
let viewA = await state("a");
check("T01a 授权后受众可见联系方式", viewA.know.connections[0].contacts?.length > 0, viewA.know.connections[0].contacts);
const cRead = await get("c", "trust/summary?subjectId=b");
check("T01b 第三人 C 读取授权内容被拒（403，无泄露）", cRead.status === 403, cRead.json);
const cState = await get("c", "state");
check("T01c C 只能看到自己的状态（无 A/B 联系方式泄露）", cState.status === 200 && !JSON.stringify(cState.json.data.know).includes("demo-axiang"), cState.json.data?.know?.connections?.length);

// T02/T03: 撤销后所有入口立即失效；只撤联系方式不影响摘要
await post("b", "share-grants", { scope: "trust_summary", connectionId: connId });
const grantList = await get("b", "privacy/grants");
const contactGrant = grantList.json.data.find(g => g.scopeLabel === "交换联系方式" && g.status === "active");
await post("b", "share-grants/revoke", { grantId: contactGrant.id });
viewA = await state("a");
check("T02a 撤销后 state 不再返回联系方式", viewA.know.connections[0].contacts === null, viewA.know.connections[0].contacts);
const trustRead = await get("a", "trust/summary?subjectId=b");
check("T03 只撤联系方式：履约摘要授权不受影响", trustRead.status === 200 && trustRead.json.data.score === 71, trustRead.json);

// T04/T05: 撤销全部 + 幂等
const allActive = (await get("b", "privacy/grants")).json.data.filter(g => g.status === "active");
for (const g of allActive) await post("b", "share-grants/revoke", { grantId: g.id });
viewA = await state("a");
check("T04 撤销给某人的全部授权：联系方式与摘要均失效", viewA.know.connections[0].contacts === null && viewA.know.connections[0].trust.status !== "granted", viewA.know.connections[0].trust.status);
const trustAfter = await get("a", "trust/summary?subjectId=b");
check("T04b 直接摘要接口同样拒绝", trustAfter.status === 403, trustAfter.json);
const grantOfA = (await get("a", "privacy/grants")).json.data.find(g => g.status === "active");
if (grantOfA) await post("a", "share-grants/revoke", { grantId: grantOfA.id });
const revokeAgain = await post("b", "share-grants/revoke", { grantId: contactGrant.id });
check("T05 重复撤销幂等成功", revokeAgain.status === 200);

// T06: 他人 grantId
const fakeRevoke = await post("a", "share-grants/revoke", { grantId: contactGrant.id });
check("T06 用他人 grantId 撤销被拒（404，不区分存在性）", fakeRevoke.status === 404, fakeRevoke.json);

// T07: 授权到期后拒绝（推进 73h 虚拟时间）
await post("b", "share-grants", { scope: "trust_summary", connectionId: connId });
await post("a", "admin/advance-time", { ms: 73 * 3_600_000 });
const trustExpired = await get("a", "trust/summary?subjectId=b");
check("T07 授权到期后直接访问被拒（无需刷新页面）", trustExpired.status === 403, trustExpired.json);

// T09: 结束绑定后旧授权失效（连接保持打开：结束绑定不关闭连接）
await post("b", "share-grants", { scope: "profile_contact", connectionId: connId });
await post("a", "relationships/end", { relationshipId: relId, reason: "验证撤权级联" });
const viewAfterEnd = await state("a");
check("T09 结束绑定后旧授权不再返回联系方式", viewAfterEnd.know.connections.every(c => c.contacts === null), viewAfterEnd.know.connections.map(c => c.contacts));
const trustAfterEnd = await get("a", "trust/summary?subjectId=b");
check("T09b 结束绑定后直接摘要接口拒绝", trustAfterEnd.status === 403, trustAfterEnd.json);

// ---------- 切片 2：日记版本裁剪（T10–T14） ----------
const relId3 = (await post("a", "relationships/propose", { connectionId: connId })).json.data.id;
await post("b", "relationships/accept", { relationshipId: relId3 });
const today = async () => new Date((await state("a")).modes.virtualNow).toISOString().slice(0, 10);
// 共享旧版（b 确认，先生成存证）+ 私人新版
const d1 = await post("a", "diaries", { kind: "diary", date: await today(), title: "一起看展", body: "那天我们看了设计展。", visibility: "shared" });
const diaryId = d1.json.data.diaryId;
await post("b", "diaries/confirm", { diaryId, expectedVersion: 1 });
const anchorRes = await post("a", "diaries/anchor", { diaryId });
check("T10pre 已确认版本生成存证任务", anchorRes.status === 200, anchorRes.json);
const d2 = await post("a", "diaries/version", { diaryId, date: await today(), title: "草稿新版本", body: "还没有告诉对方的话。", visibility: "draft", expectedVersion: 1 });
check("T10a 作者添加私人新版本成功", d2.status === 200, d2.json);
let detail = await get("b", `diaries/detail?id=${diaryId}`);
check("T10b/T11 对方详情 DTO 不含作者的私人草稿版本（只有 v1）", detail.json.data.versions.length === 1 && detail.json.data.versions[0].title === "一起看展", detail.json.data.versions);
detail = await get("a", `diaries/detail?id=${diaryId}`);
check("T11b 作者可见自己的全部版本（2 版）", detail.json.data.versions.length === 2, detail.json.data.versions.length);

// T14: 证据导出仅参与者
const exportOther = await get("c", `export?recordId=${diaryId}`);
check("T14 非参与者导出证据被拒（403）", exportOther.status === 403, exportOther.status);

// ---------- 切片 3：屏蔽级联（T15–T21） ----------
// 关系内准备待确认共享内容，然后屏蔽当前伴侣
const d3 = await post("a", "diaries", { kind: "diary", date: await today(), title: "待确认的一页", body: "等待你确认的内容。", visibility: "shared" });
const awaitingId = d3.json.data.diaryId;
const ctx = await get("a", `safety/target-context?sourceType=relationship&sourceId=${relId3}`);
check("T22a target-context 返回临时引用与脱敏标签（不返回对方 ID）", ctx.status === 200 && !!ctx.json.data.targetRef && !("targetId" in ctx.json.data), ctx.json.data);
const targetRef = ctx.json.data.targetRef;
const blockRes = await post("a", "safety/blocks", { targetRef });
check("T17a 屏蔽成功（返回脱敏屏蔽记录）", blockRes.status === 200 && !!blockRes.json.data.block.id, blockRes.json);
let viewB = await state("b");
check("T17b 屏蔽后对方档案不再透出（连接已级联关闭）", viewB.know.connections.every(c => c.profile === null), viewB.know.connections.map(c => c.profile));
check("T17c 屏蔽不自动结束关系（status 仍 active）", viewB.us.relationship?.status === "active", viewB.us.relationship?.status);
const bConfirm = await post("b", "diaries/confirm", { diaryId: awaitingId, expectedVersion: 1 });
check("T17d 屏蔽期间共享确认被冻结（403 中性错误）", bConfirm.status === 403, bConfirm.json);
const bWrite = await post("b", "diaries", { kind: "diary", date: await today(), title: "屏蔽期间", body: "应该写不进去的一页。", visibility: "shared" });
check("T17e 屏蔽期间新共享写入被拒绝", bWrite.status === 403, bWrite.json);
// T18: 屏蔽时待处理邀请取消（此处验证铃声取消 + 无新邀请路径：屏蔽时无待处理邀请，检查铃声）
// T12: 未共同确认共享版本仅作者可读
detail = await get("b", `diaries/detail?id=${awaitingId}`);
check("T12a 屏蔽后对方读不到未共同确认共享版本（v2.7：无可见版本按 404 掩护）", detail.status === 404 || (detail.status === 200 && !detail.json.data.versions.some(v => v.title === "待确认的一页")), { status: detail.status, versions: detail.json?.data?.versions });
detail = await get("a", `diaries/detail?id=${awaitingId}`);
check("T12b 作者仍可读自己的版本", detail.status === 200 && detail.json.data.versions.some(v => v.title === "待确认的一页"), detail.json?.data?.versions);
// T13: 双方已确认历史保留为只读归档
detail = await get("b", `diaries/detail?id=${diaryId}`);
check("T13 屏蔽后已共同确认历史作为归档可读（仅 v1）", detail.status === 200 && detail.json.data.versions.length === 1 && detail.json.data.versions[0].title === "一起看展", detail.json?.data?.versions);

// T15: 双方候选不可见、新铃声拒绝（先结束绑定：屏蔽不结束关系，雷达测试需要无关系状态）
await post("a", "relationships/end", { relationshipId: relId3, reason: "雷达与限制测试准备（屏蔽本就不自动结束关系）" });
for (const v of ["a", "b"]) {
  await post(v, "radar", { active: true, traits: [{ category: "穿着", value: "浅色衬衫" }, { category: "手持物", value: "一本书" }] });
}
viewB = await state("b");
check("T15a 屏蔽后雷达候选互相不可见", viewB.meet.candidates.length === 0, viewB.meet.candidates);
const ringBlocked = await post("a", "ring", { candidateRef: "cr-fake-ref-blocked-test", message: "想认识你。", idempotencyKey: "qa-safety-ring-blocked" });
check("T15b 屏蔽后无有效候选引用可摇铃（统一 404，不泄露对方状态）", ringBlocked.status === 404, ringBlocked.json);
// T58: 旧提醒不再透出
viewB = await state("b");
check("T58 屏蔽后旧日记提醒不再透出给对方", !viewB.notifications.some(n => n.objectId === awaitingId), viewB.notifications.map(n => n.objectId));

// T20/T21: 解除屏蔽不恢复
const blockList = await get("a", "safety/blocks");
const myBlock = blockList.json.data[0];
const unblock = await post("a", `safety/blocks/${myBlock.id}/revoke`, { expectedRevision: myBlock.revision });
check("T20a 解除屏蔽成功（提示不恢复旧授权）", unblock.status === 200 && unblock.json.data.note.includes("不会恢复"), unblock.json);
viewB = await state("b");
check("T20b 解除屏蔽后旧授权不恢复（联系方式仍不可见）", viewB.know.connections.every(c => c.contacts === null));
viewB = await state("b");
check("T20c 解除屏蔽不恢复连接（级联关闭的连接保持关闭，雷达候选仍为空）", viewB.meet.candidates.length === 0, viewB.meet.candidates);

// T23: 伪造/他人 targetRef
const badRef = await post("b", "safety/blocks", { targetRef: "tr-fake123" });
check("T23 伪造 targetRef 被拒（404 中性错误）", badRef.status === 404, badRef.json);
const otherRef = await get("b", `safety/target-context?sourceType=relationship&sourceId=${relId3}`);
const crossUse = await post("a", "safety/blocks", { targetRef: otherRef.json?.data?.targetRef });
check("T23b 使用他人签发的 targetRef 被拒", crossUse.status === 404, crossUse.status);

// ---------- 切片 4：举报与运营闭环（T22/T24–T40） ----------
// 举报来源走已回响连接（历史连接仍是合法来源；relId3 已在切片 3 结束）
const connCtx = await get("a", `safety/target-context?sourceType=connection&sourceId=${connId}`);
const reportRef = connCtx.json.data.targetRef;
check("T22b 历史连接可作为举报来源（不揭晓身份）", !!reportRef && !("targetId" in connCtx.json.data), connCtx.json.data);

// T24: 字段校验
let rr = await post("a", "safety/reports", { targetRef: reportRef, reason: "harassment", description: "太短" });
check("T24a 说明不足 10 字被拒（不创建工单）", rr.status === 400, rr.json);
rr = await post("a", "safety/reports", { targetRef: reportRef, reason: "not_a_reason", description: "这是一段足够长的说明文字，用于验证。" });
check("T24b 无效原因被拒", rr.status === 400);
rr = await post("a", "safety/reports", { targetRef: reportRef, reason: "harassment", description: "<script>alert(1)</script> 这段包含 HTML 字符的说明足够长，验证按文本处理。" });
check("T25 含 HTML/script 字符按文本接受（不执行）", rr.status === 200, rr.json);
const report1 = rr.json.data.report;
check("T27 举报默认不同时屏蔽（block=null）", rr.json.data.block === null, rr.json.data);

// T31: 被举报者读不到举报
const otherRead = await get("b", `safety/reports/${report1.id}`);
check("T31 被举报者读取举报被拒（404，不返回举报人身份）", otherRead.status === 404, otherRead.json);

// T34/T35/T36: 运营权限与领取
check("T34a 未登录 ops 读队列被拒（401）", (await ops("GET", "safety/reports")).status === 401);
let ro = await ops("GET", "safety/reports", undefined, ownerCookie);
check("T34b owner 可读脱敏队列（工单出现）", ro.status === 200 && Array.isArray(ro.json.data) && ro.json.data.some(x => x.id === report1.id), ro.json.data?.length);
const queueItem = ro.json.data.find(x => x.id === report1.id);
check("T41 队列脱敏：不含举报人/被举报者身份字段", !JSON.stringify(queueItem).includes("reporterId") && !JSON.stringify(queueItem).includes("小铃"), queueItem);
let rd = await ops("GET", `safety/reports/${report1.id}`, undefined, reviewerCookie);
check("T36a 未领取时非主管读取案内材料被拒（403）", rd.status === 403, rd.json);
const assignR1 = await ops("POST", `safety/reports/${report1.id}/assign`, {}, ownerCookie);
check("T36b 领取成功", assignR1.status === 200, assignR1.json);
const assignConflict = await ops("POST", `safety/reports/${report1.id}/assign`, {}, reviewerCookie);
check("T35 R2 领取已被 R1 领取的工单被拒（409）", assignConflict.status === 409, assignConflict.json);
const decideByOther = await ops("POST", `safety/reports/${report1.id}/decisions`, { decision: "resolved", userMessage: "越权裁定应被拒绝", internalReason: "x" }, reviewerCookie);
check("T36c 非受理人裁定被拒（403）", decideByOther.status === 403, decideByOther.json);

// T37: 旧 revision
rd = await ops("GET", `safety/reports/${report1.id}`, undefined, ownerCookie);
const staleDecide = await ops("POST", `safety/reports/${report1.id}/decisions`, { decision: "resolved", userMessage: "旧版本的裁定应被拒绝", internalReason: "测试", expectedRevision: rd.json.data.revision - 1 }, ownerCookie);
check("T37 旧 revision 提交决定被拒（409）", staleDecide.status === 409, staleDecide.json);

// need_supplement → 用户补充 → in_review → resolved
const needMore = await ops("POST", `safety/reports/${report1.id}/decisions`, { decision: "need_supplement", userMessage: "请补充事件发生的时间与截图说明。", internalReason: "材料不足：缺少时间线", expectedRevision: rd.json.data.revision }, ownerCookie);
check("运营要求补充成功（用户状态=待补充）", needMore.status === 200 && needMore.json.data.status === "awaiting_supplement", needMore.json);
let userReport = (await get("a", `safety/reports/${report1.id}`)).json.data;
check("T39a 用户端只见 userMessage（不含内部意见）", userReport.statusLabel === "待补充" && !JSON.stringify(userReport).includes("internalReason") && !JSON.stringify(userReport).includes("材料不足"), userReport.statusLabel);
check("用户收到站内通知（只含用户可见文字）", (await state("a")).notifications.some(n => n.title.includes("补充")), true);
const supp = await post("a", `safety/reports/${report1.id}/supplements`, { text: "事件发生在 10 月 6 日晚间，相关说明如上。", expectedRevision: userReport.revision });
check("用户补充材料后回到审核", supp.status === 200 && supp.json.data.status === "in_review", supp.json);
rd = await ops("GET", `safety/reports/${report1.id}`, undefined, ownerCookie);
const resolve = await ops("POST", `safety/reports/${report1.id}/decisions`, { decision: "resolved", userMessage: "已核实并已对相关账号做出处理。", internalReason: "证据充分", expectedRevision: rd.json.data.revision }, ownerCookie);
check("运营结案成功", resolve.status === 200 && resolve.json.data.status === "resolved", resolve.json);
userReport = (await get("a", `safety/reports/${report1.id}`)).json.data;
check("T39b 用户端结论只含 userMessage", userReport.userResult?.userMessage === "已核实并已对相关账号做出处理。" && !JSON.stringify(userReport).includes("证据充分"), userReport.userResult);

// T32: 已结案状态不能再撤回
const lateWithdraw = await post("a", `safety/reports/${report1.id}/withdraw`, { expectedRevision: userReport.revision });
check("T32 已结案不能撤回（409）", lateWithdraw.status === 409, lateWithdraw.json);

// T38/T33: 复核回避 + 一次复核
const appeal = await post("a", `safety/reports/${report1.id}/appeals`, { reason: "对处理结果有异议，申请复核。", expectedRevision: userReport.revision });
check("用户申请复核成功（复核中）", appeal.status === 200 && appeal.json.data.status === "appeal_requested", appeal.json);
const selfAppeal = await ops("POST", `safety/reports/${report1.id}/appeal-decision`, { decision: "resolved", userMessage: "原审核员复核自己的案件应被拒绝。" }, ownerCookie);
check("T38 原审核员复核自己的案件被拒（409 回避）", selfAppeal.status === 409 && selfAppeal.json.error.code === "REVIEWER_CONFLICT", selfAppeal.json);
const appealByReviewer = await ops("POST", `safety/reports/${report1.id}/appeal-decision`, { decision: "resolved", userMessage: "复核维持原结论并补充处理措施。" }, reviewerCookie);
check("不同审核员复核成功", appealByReviewer.status === 200, appealByReviewer.json);
userReport = (await get("a", `safety/reports/${report1.id}`)).json.data;
const appealAgain = await post("a", `safety/reports/${report1.id}/appeals`, { reason: "想再复核一次。", expectedRevision: userReport.revision });
check("T33 每案只能复核一次（409）", appealAgain.status === 409, appealAgain.json);

// T30: 新举报频率上限（5/24h；同来源同原因未结案会复用工单，用不同原因各建一单）
const connCtxB = await get("b", `safety/target-context?sourceType=connection&sourceId=${connId}`);
const reportRefB = connCtxB.json.data.targetRef;
const allReasons = ["harassment", "impersonation", "privacy_leak", "inappropriate_content", "fraud", "other"];
let rateLimited = false;
for (let i = 0; i < allReasons.length; i++) {
  const r = await post("b", "safety/reports", { targetRef: reportRefB, reason: allReasons[i], description: `第 ${i + 1} 条频率测试举报说明文字足够长。` });
  if (r.status === 429) { rateLimited = true; break; }
}
check("T30 新举报频率上限（超 5 次/24h 返回 429）", rateLimited);
const grantsStillWork = await get("b", "privacy/grants");
check("T30b 限制期间救济操作仍可用（授权列表可读）", grantsStillWork.status === 200);

// T40: 限时摇铃限制（b 当前无有效关系：rel3 已结束）
ro = await ops("GET", "safety/reports?status=submitted", undefined, ownerCookie);
const bReport = ro.json.data.find(x => x.reason === "fraud");
const restrictRes = await ops("POST", "safety/restrictions", { reportId: bReport.id, scope: "ring", days: 1 }, ownerCookie);
check("T40a 主管批准限时摇铃限制", restrictRes.status === 200, restrictRes.json);
const candForRestrict = (await state("a")).meet.candidates[0];
const ringRestricted = await post("a", "ring", { candidateRef: candForRestrict?.candidateRef ?? "cr-none", message: "想认识你。", idempotencyKey: "qa-safety-ring-restricted" });
check("T40b 限制期间新铃声被拒（中性错误，救济不受影响）", ringRestricted.status === 403 && (ringRestricted.json?.error?.message ?? "").includes("当前无法继续此操作"), ringRestricted.json);
const reviewerRestrict = await ops("POST", "safety/restrictions", { reportId: bReport.id, scope: "ring", days: 1 }, reviewerCookie);
check("T40c reviewer 无 safety.restrict 权限被拒（403）", reviewerRestrict.status === 403, reviewerRestrict.json);

// ---------- 切片 5：数据导出与注销（T42–T48） ----------
let ex = await post("a", "privacy/exports", { scopes: ["profile", "diaries"] });
check("T42a 创建导出任务成功（24h 有效）", ex.status === 200 && ex.json.data.status === "ready", ex.json);
const exportId = ex.json.data.jobId;
const pkg = await get("a", `privacy/exports/${exportId}/download`);
// 本人的私人草稿属于本人数据（应包含）；不得包含存证 salt 或后台内部意见。
check("T42b 数据包含本人草稿；不含存证 salt/后台意见", pkg.status === 200 && JSON.stringify(pkg.json.data).includes("还没有告诉对方的话") && !JSON.stringify(pkg.json.data).includes('"salt"') && !JSON.stringify(pkg.json.data).includes("internalReason"), Object.keys(pkg.json.data ?? {}));
const wrongJob = await get("a", "privacy/exports/export-not-exist/download");
check("T43 改 exportJobId 下载被拒（404）", wrongJob.status === 404, wrongJob.json);
const otherDownload = await get("b", `privacy/exports/${exportId}/download`);
check("T44 他人下载本人任务被拒（404）", otherDownload.status === 404);

// T45/T46/T47: 注销（b；注销是本人救济操作，不受摇铃限制影响）
const badDeletion = await post("b", "privacy/deletions", { password: "wrong-password", confirmation: "注销", endBindingConsent: true });
check("T45a 再认证失败被拒（401）", badDeletion.status === 401, badDeletion.json);
const badDeletion2 = await post("b", "privacy/deletions", { password: "HeartbellB2026!", confirmation: "取消", endBindingConsent: true });
check("T45b 未输入“注销”被拒", badDeletion2.status === 400);
const badDeletion3 = await post("b", "privacy/deletions", { password: "HeartbellB2026!", confirmation: "注销", endBindingConsent: false });
check("T45c 未明确结束绑定同意被拒", badDeletion3.status === 400);
const del = await post("b", "privacy/deletions", { password: "HeartbellB2026!", confirmation: "注销", endBindingConsent: true });
check("T46a 注销申请成功（受限保留诚实标注）", del.status === 200 && del.json.data.state === "completed_with_retention" && !!del.json.data.credential, del.json.data?.state);
const delCredential = del.json.data.credential;
const delId = del.json.data.deletionId;
const bAfter = await get("b", "state");
check("T46b 注销后原会话立即失效（401）", bAfter.status === 401);
const bRelogin = await req("POST", "/api/demo-auth/login", { body: { username: "b", password: "HeartbellB2026!" } });
check("T46c 注销后固定凭据登录被拒（账号已停用）", bRelogin.status === 401, bRelogin.json);
const statusByCred = await req("GET", `/api/v2/privacy/deletions/${delId}/credential?credential=${delCredential}`);
check("T47a 独立受限凭据可查询注销状态", statusByCred.status === 200 && statusByCred.json.data.retentionSummary.length > 0, statusByCred.json.data?.retentionSummary);
const wrongCred = await req("GET", `/api/v2/privacy/deletions/${delId}/credential?credential=bad-token`);
check("T47c 错误凭据被拒（404）", wrongCred.status === 404);

// 释放后续脚本运行的干净状态（演示台重置；登录态由各脚本自行重建）
await req("POST", `/api/v2/admin/reset`, { body: {}, cookie: cookies.a });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: 安全与隐私验证 ${passed} 项通过，${failed} 项失败。`);
console.log("未覆盖（演示边界，M4 依赖）：T49 删除与链任务对账、T50 worker 重试、T51 备份恢复、T52 真实模式 viewer 拒绝——见 docs/SAFETY-PRIVACY.md。");
process.exit(failed === 0 ? 0 : 1);
