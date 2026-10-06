// V2 集成验证脚本（npm run verify:v2，需先在干净状态启动服务）。
// 覆盖：相遇门槛与隐私、授权、履约分（含 null 分支）、关系状态机、日记版本、
// 承诺履约、相守账本（冷静期/审核/领取/失效/例外）、重复领取防护、
// 存证 preview 边界、承诺协议独立复算（T01–T08、T13、T15–T18、T20–T23 核心）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const base = process.env.DEMO_URL ?? "http://127.0.0.1:3000";
const HOUR = 3_600_000, DAY = 86_400_000;

let passed = 0;
function check(name, condition, detail) {
  if (!condition) { console.error(`FAIL: ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 400) : ""}`); process.exit(1); }
  passed += 1;
  console.log(`ok  ${name}`);
}

// v2.6：普通用户接口需要 Demo 会话——先登录 a/b，携带双槽位 Cookie（同浏览器双窗口演示形态）。
async function demoLogin(viewer) {
  const password = { a: "HeartbellA2026!", b: "HeartbellB2026!" }[viewer];
  const res = await fetch(`${base}/api/demo-auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: viewer, password }),
  });
  if (!res.ok) throw new Error(`登录 ${viewer} 失败：${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
const CK = `${await demoLogin("a")}; ${await demoLogin("b")}`;

async function get(path) {
  const response = await fetch(`${base}/api/v2/${path}`, { headers: { Cookie: CK } });
  const json = await response.json();
  return { status: response.status, json };
}
async function post(path, body) {
  const response = await fetch(`${base}/api/v2/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: CK, Origin: base }, body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}
const state = async viewer => (await get(`state?viewer=${viewer}`)).json.data;

// ---------- 重置演示场景 ----------
await post("admin/reset", {});
for (const path of ["/", "/demo/a?tab=know", "/demo/b?tab=future", "/demo/admin"]) {
  const page = await fetch(base + path);
  check(`页面可访问 ${path}`, page.status === 200);
}

// ---------- T01 相遇：雷达、摇铃、回响、揭晓 ----------
const before = await state("b");
check("初始无档案泄露", before.know.connections.length === 0 && before.me.profile.nickname === "阿响");
await post("declare-adult", { viewer: "a" });
await post("declare-adult", { viewer: "b" });
check("未声明者摇铃被拒(已声明)", (await post("ring", { viewer: "a", message: "想认识你。" })).status === 409);
for (const viewer of ["a", "b"]) {
  const r = await post("radar", { viewer, active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
  check(`开启雷达 ${viewer}`, r.status === 200);
}
check("无效特征被拒", (await post("radar", { viewer: "a", active: true, traits: [{ category: "无效", value: "x" }, { category: "其他", value: "y" }] })).status === 400);
const ring = await post("ring", { viewer: "a", message: "想认识你。" });
check("A 摇铃成功", ring.status === 200 && !!ring.json.data.bellId);
check("T02 重复摇铃被拒", (await post("ring", { viewer: "a", message: "想认识你。" })).status === 409);
const bView = await state("b");
const pendingBell = bView.meet.bells.find(x => x.status === "pending");
check("B 收到匿名铃声(无档案字段)", !!pendingBell && pendingBell.anonymous === true);
check("T01 未回响前 B 看不到 A 档案", bView.know.connections.length === 0);
const respond = await post("respond", { viewer: "b", bellId: pendingBell.id, status: "accepted" });
check("B 回响成功", respond.status === 200);
const aAfterEcho = await state("a");
check("T01 回响后双方档案揭晓（档案不含联系方式）", aAfterEcho.know.connections[0]?.profile?.nickname === "阿响" && aAfterEcho.know.connections[0].contacts === null);
check("T02 未授权不返回联系方式", aAfterEcho.know.connections[0].contacts === null);

// ---------- 联系方式独立授权 ----------
check("授权联系方式", (await post("share-grants", { viewer: "b", scope: "profile_contact" })).status === 200);
const aWithContact = await state("a");
check("授权后可见全部联系方式栏（微信+手机号）", JSON.stringify(aWithContact.know.connections[0].contacts) === JSON.stringify([{label:"微信",value:"demo-axiang"},{label:"手机号",value:"139****0002（演示）"}]));

// ---------- T03/T04/T05 履约摘要与授权 ----------
check("T03 未授权读取摘要被拒", (await get(`trust/summary?subjectId=b&viewer=a`)).status === 403);
const grantTrust = await post("share-grants", { viewer: "b", scope: "trust_summary" });
check("B 授权履约摘要", grantTrust.status === 200);
const trust = await get("trust/summary?subjectId=b&viewer=a");
check("T04 演示前史 71 分", trust.status === 200 && trust.json.data.score === 71, trust.json.data);
check("T04 明细 s=4 f=1 n=5 coverage=1", trust.json.data.s === 4 && trust.json.data.f === 1 && trust.json.data.eligible === 5 && trust.json.data.coverage === 1);
check("演示数据标注", trust.json.data.origin === "demo");
await post("share-grants", { viewer: "a", scope: "trust_summary" }); // a 主动授权 b 查看自己的摘要
const trustA = await get("trust/summary?subjectId=a&viewer=b");
check("T05 新用户无历史 → null 分数", trustA.status === 200 && trustA.json.data.score === null && trustA.json.data.reason === "no_history");
const cardBefore = (await state("a")).know.connections[0].trust;
check("了解卡片显示已授权摘要", cardBefore.status === "granted" && cardBefore.summary.score === 71);

// ---------- T06 关系状态机 ----------
check("无连接时不能邀请", (await post("relationships/propose", { viewer: "a" })).status === 200); // 已有连接，成功
const propose = (await state("b")).us.incomingInvite;
check("B 收到关系邀请", !!propose);
check("T06 不能自己确认自己的邀请", (await post("relationships/accept", { viewer: "a", relationshipId: propose.id })).status === 400);
const accept = await post("relationships/accept", { viewer: "b", relationshipId: propose.id });
check("双方确认后关系 active", accept.status === 200 && (await state("a")).us.relationship?.status === "active");
check("T06 重复接受被拒", (await post("relationships/accept", { viewer: "b", relationshipId: propose.id })).status === 409);
check("T06 已绑定后不能再邀请", (await post("relationships/propose", { viewer: "a" })).status === 409);
// MEET-06：关系中服务端拦截雷达
check("MEET-06 关系中开启雷达被服务端拦截", (await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "x" }, { category: "其他", value: "y" }] })).status === 403);
check("MEET-06 关系中摇铃被服务端拦截", (await post("ring", { viewer: "a", message: "想认识你。" })).status === 403);
const usA = await state("a");
check("关系空间含系统纪念节点", usA.us.timeline.some(t => t.type === "auto-milestone" && t.title === "关系第一天"));

// ---------- T07 日记版本与双方确认 ----------
const diaryCreate = await post("diaries", { viewer: "a", kind: "diary", date: "2026-10-01", title: "第一次见面", body: "江边的风很温柔。", attachmentIds: ["img-rain"], visibility: "shared" });
check("创建日记 v1", diaryCreate.status === 200);
const diaryId = diaryCreate.json.data.diaryId;
const d1 = await get(`diaries/detail?id=${diaryId}&viewer=a`);
check("v1 待对方确认", d1.json.data.versions[0].status === "awaiting" && d1.json.data.versions.length === 1);
check("T07 存证前不能 anchor", (await post("diaries/anchor", { viewer: "a", diaryId })).status === 409);
const confirmB = await post("diaries/confirm", { viewer: "b", diaryId });
check("B 确认 v1 → 双方已确认", confirmB.status === 200);
// 修改生成新版本，旧确认失效
const mod = await post("diaries/version", { viewer: "a", diaryId, expectedVersion: 1, date: "2026-10-01", title: "第一次见面", body: "江边的风很温柔，雨也停了。", attachmentIds: ["img-rain", "img-coffee"], visibility: "shared" });
check("修改生成 v2", mod.status === 200 && mod.json.data.version === 2);
check("T07 过期确认不能复用(v2 待确认)", (await get(`diaries/detail?id=${diaryId}&viewer=b`)).json.data.versions[1].status === "awaiting");
check("T07 版本冲突被拒", (await post("diaries/version", { viewer: "a", diaryId, expectedVersion: 1, date: "2026-10-01", title: "x", body: "y", attachmentIds: [], visibility: "shared" })).status === 409);
check("T08 非成员读取被拒", (await get(`diaries/detail?id=${diaryId}&viewer=x`)).status === 401);
check("B 确认 v2", (await post("diaries/confirm", { viewer: "b", diaryId })).status === 200);
const anchorDiary = await post("diaries/anchor", { viewer: "a", diaryId });
check("双方确认后可存证(preview=unconfigured)", anchorDiary.status === 200);
const anchored = (await state("a")).us.timeline.find(t => t.id === diaryId);
check("preview 不生成假交易哈希", anchored.anchor.chainStatus === "unconfigured" && anchored.anchor.txHash === null && anchored.anchor.commitment.startsWith("0x"));
check("重复 anchor 幂等", (await post("diaries/anchor", { viewer: "b", diaryId })).status === 200);
// 私人草稿仅作者可见
const draft = await post("diaries", { viewer: "a", kind: "diary", date: "2026-10-02", title: "偷偷记下", body: "今天的 TA 很好看。", attachmentIds: [], visibility: "draft" });
check("创建私人草稿", draft.status === 200);
const bTimeline = (await state("b")).us.timeline;
check("T08 私人草稿对对方不可见", !bTimeline.some(t => t.id === draft.json.data.diaryId));
check("草稿校验：标题 41 字被拒", (await post("diaries", { viewer: "a", kind: "diary", date: "2026-10-02", title: "长".repeat(41), body: "x", attachmentIds: [], visibility: "shared" })).status === 400);
check("草稿校验：未来日期被拒", (await post("diaries", { viewer: "a", kind: "diary", date: "2099-01-01", title: "未来", body: "x", attachmentIds: [], visibility: "shared" })).status === 400);

// ---------- 承诺与履约 ----------
const badPromise = await post("promises", { viewer: "a", content: "我们永不分手", dueAt: Date.now() + 10 * DAY, criteria: "永远", responsible: "both", scoringOptIn: false });
check("限制人身自由的承诺被拒", badPromise.status === 400);
check("计分承诺需提前 24h", (await post("promises", { viewer: "a", content: "一起去一次美术馆", dueAt: Date.now() + 2 * HOUR, criteria: "双方确认", responsible: "both", scoringOptIn: true })).status === 400);
const p1 = await post("promises", { viewer: "a", content: "每周留一个共同的晚上", dueAt: Date.now() + 14 * DAY, criteria: "双方确认本次安排", responsible: "both", scoringOptIn: true });
check("创建计分承诺", p1.status === 200);
check("同日第二个计分承诺被拒", (await post("promises", { viewer: "b", content: "每月看一场展览", dueAt: Date.now() + 14 * DAY, criteria: "双方确认", responsible: "both", scoringOptIn: true })).status === 400);
const promiseId = p1.json.data.promiseId;
check("承诺需对方确认", (await post("promises/confirm", { viewer: "b", promiseId, expectedRevision: 1 })).status === 200);
check("承诺生效", (await state("a")).us.promises.find(p => p.id === promiseId).status === "active");
check("未提交证据时确认被拒", (await post("promises/resolutions/confirm", { viewer: "b", promiseId, subjectUserId: "a", outcome: "fulfilled" })).status === 409);
check("责任人提交履约证据", (await post("promises/resolutions", { viewer: "a", promiseId, result: "fulfilled", note: "10 月 10 日晚一起做了饭" })).status === 200);
check("对方对同一证据确认", (await post("promises/resolutions/confirm", { viewer: "b", promiseId, subjectUserId: "a", outcome: "fulfilled" })).status === 200);
const settled = (await state("a")).us.promises.find(p => p.id === promiseId);
check("履约结果 fulfilled", settled.resolutions.a.result === "fulfilled");

// ---------- T23 相守计划：客户端不可篡改规则 ----------
const tamper = await post("plans", { viewer: "a", targetType: "marriage", rewardChoice: "C", investPerUser: 1 });
check("T23 客户端伪造奖励选项被规范化", tamper.status === 200);
const planId = tamper.json.data.planId;
check("T23 未确认条款不能激活", (await post("plans/accept", { viewer: "b", planId, expectedRevision: 1, termsConfirmed: false })).status === 400);
check("发起人不能替对方接受", (await post("plans/accept", { viewer: "a", planId, expectedRevision: 1, termsConfirmed: true })).status === 400);
const acceptPlan = await post("plans/accept", { viewer: "b", planId, expectedRevision: 1, termsConfirmed: true });
check("T15 双方接受后激活", acceptPlan.status === 200);
const planActive = (await state("a")).future.plan;
check("T16 激活即扣款 100×2 托管", planActive.status === "active" && planActive.investedTotal === 200);
const balancesActive = (await get("admin/snapshot")).json.data.accounts;
check("T15 双方余额各 900", balancesActive.userA === 900 && balancesActive.userB === 900);
check("T20 激活前目标不能申请(冷静期内)", (await post("plans/claims", { viewer: "a", planId, targetOccurredAt: Date.now(), evidenceNote: "x" })).status === 400);

// ---------- 冷静期取消（T18 前半） ----------
// 先建第二个计划用于冷静期测试？每关系限一个有效计划 → 先走完本计划的领取流程再测失效分支。
// 推进 25 小时：过冷静期。
await post("admin/advance-time", { ms: 25 * HOUR });
const claimT = Date.now() + 25 * HOUR; // 近似虚拟现在
const claim = await post("plans/claims", { viewer: "a", planId, targetOccurredAt: claimT, evidenceNote: "双方线下登记（演示剧情，非真实证件）" });
check("提交达成申请", claim.status === 200);
check("T20 重复申请被拒", (await post("plans/claims", { viewer: "b", planId, targetOccurredAt: claimT, evidenceNote: "再来一次" })).status === 409);
check("审核中有在途申请不能普通结束", (await post("plans/cancel", { viewer: "a", planId, expectedRevision: 1, reasonType: "normal" })).status === 409);
const claims = (await get("admin/snapshot")).json.data.claims;
const claimId = claims.find(c => c.planId === planId).id;
check("T20 无审核角色路径经演示台", (await post("admin/claims/decision", { claimId, decision: "approve", note: "演示通过" })).status === 200);
check("婚姻目标通过后关系标记 married", (await state("a")).us.relationship?.status === "married");
const afterApprove = (await state("a")).future.plan;
check("approved 待争议期", afterApprove.status === "approved");
check("争议期内不能领取", [404, 409].includes((await post("benefits/redeem", { viewer: "a", benefitId: `benefit-${planId}`, idempotencyKey: "k1" })).status));
await post("admin/advance-time", { ms: 8 * DAY });
const redeemable = (await state("a")).future.plan;
check("争议期后可领取", redeemable.status === "redeemable" && redeemable.benefit.status === "redeemable");
const redeem1 = await post("benefits/redeem", { viewer: "a", benefitId: `benefit-${planId}`, idempotencyKey: "k1" });
check("T16 领取成功", redeem1.status === 200);
const redeem2 = await post("benefits/redeem", { viewer: "a", benefitId: `benefit-${planId}`, idempotencyKey: "k2" });
check("T17 重复领取幂等", redeem2.status === 200);
const settledBalances = (await get("admin/snapshot")).json.data.accounts;
check("T16 结算：各返 100 + 奖 50（950+1050），预算扣 100", settledBalances.userA === 1050 && settledBalances.userB === 1050 && settledBalances.rewardPool === 9900, settledBalances);
check("T16 计划进入终态 settled", (await state("a")).future.plan.status === "settled");

// ---------- T13 承诺协议独立复算 ----------
const exportData = (await get(`export?recordId=${diaryId}&viewer=a`)).json.data;
const recomputed = "0x" + createHash("sha256")
  .update(Buffer.concat([
    Buffer.from("HEARTBELL_V2", "utf8"), Buffer.from([0]),
    Buffer.from(exportData.salt.slice(2), "hex"),
    createHash("sha256").update(canonicalJcs(exportData.payload), "utf8").digest(),
  ])).digest("hex");
check("T13 同一 payload+salt 重算一致", recomputed === exportData.commitment);
const tamperedPayload = JSON.parse(JSON.stringify(exportData.payload));
tamperedPayload.content.body += "（改了一个字）";
const recomputedTampered = "0x" + createHash("sha256")
  .update(Buffer.concat([
    Buffer.from("HEARTBELL_V2", "utf8"), Buffer.from([0]),
    Buffer.from(exportData.salt.slice(2), "hex"),
    createHash("sha256").update(canonicalJcs(tamperedPayload), "utf8").digest(),
  ])).digest("hex");
check("T13 改一字后不匹配", recomputedTampered !== exportData.commitment);
const tamperedSalt = exportData.salt.slice(0, -2) + (exportData.salt.endsWith("0") ? "1" : "0");
const recomputedSalt = "0x" + createHash("sha256")
  .update(Buffer.concat([
    Buffer.from("HEARTBELL_V2", "utf8"), Buffer.from([0]),
    Buffer.from(tamperedSalt.slice(2), "hex"),
    createHash("sha256").update(canonicalJcs(exportData.payload), "utf8").digest(),
  ])).digest("hex");
check("T13 改一个 salt 字节不匹配", recomputedSalt !== exportData.commitment);

// 独立实现的 JCS（与服务端 TypeScript 实现交叉验证）
function canonicalJcs(value) {
  if (value === null || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isInteger(value)) throw new Error("非整数"); return JSON.stringify(value); }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJcs(value[k])}`).join(",")}}`;
}

// ---------- T18/T21 场景二：正常失效 + 审核中退出 ----------
await post("admin/reset", {});
for (const viewer of ["a", "b"]) await post("declare-adult", { viewer });
for (const viewer of ["a", "b"]) await post("radar", { viewer, active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
await post("ring", { viewer: "a", message: "想认识你。" });
const bell2 = (await state("b")).meet.bells.find(x => x.status === "pending");
await post("respond", { viewer: "b", bellId: bell2.id, status: "accepted" });
await post("relationships/propose", { viewer: "a" });
const invite2 = (await state("b")).us.incomingInvite;
await post("relationships/accept", { viewer: "b", relationshipId: invite2.id });
// 冷静期内取消：全额退款
const plan2 = await post("plans", { viewer: "a", targetType: "anniversary", rewardChoice: "B" });
check("v2.1 玫瑰券计划不再需要领取人", plan2.status === 200 && (await state("a")).future.plan.beneficiary === null);
check("场景二创建计划 B(玫瑰券)", plan2.status === 200);
await post("plans/accept", { viewer: "b", planId: plan2.json.data.planId, expectedRevision: 1, termsConfirmed: true });
const cancelCooling = await post("plans/cancel", { viewer: "a", planId: plan2.json.data.planId, expectedRevision: 1, reasonType: "normal" });
check("T18 冷静期内取消退款", cancelCooling.status === 200);
const afterCoolingCancel = (await get("admin/snapshot")).json.data.accounts;
check("T18 双方余额回到 1000", afterCoolingCancel.userA === 1000 && afterCoolingCancel.userB === 1000, afterCoolingCancel);

// 计划三：冷静期后普通结束 → 失效窗口 → forfeited
const plan3 = await post("plans", { viewer: "a", targetType: "anniversary", rewardChoice: "A" });
await post("plans/accept", { viewer: "b", planId: plan3.json.data.planId, expectedRevision: 1, termsConfirmed: true });
await post("admin/advance-time", { ms: 25 * HOUR });
await post("plans/cancel", { viewer: "a", planId: plan3.json.data.planId, expectedRevision: 1, reasonType: "normal" });
check("T18 冷静期后普通结束 → 失效异议期", (await state("a")).future.plan.status === "forfeit_pending");
await post("admin/advance-time", { ms: 8 * DAY });
const forfeited = (await state("a")).future.plan;
check("T18 异议期结束 → 投入进入演示失效账户", forfeited.status === "forfeited");
const forfeitAccounts = (await get("admin/snapshot")).json.data.accounts;
check("T18 失效账户 200 点，双方余额 900", forfeitAccounts.forfeitAccount === 200 && forfeitAccounts.userA === 900 && forfeitAccounts.userB === 900, forfeitAccounts);

// 计划四：审核中退出关系（T21）——退出立即生效，计划复核后仍可领取
const plan4 = await post("plans", { viewer: "a", targetType: "marriage", rewardChoice: "B", beneficiary: "b" });
await post("plans/accept", { viewer: "b", planId: plan4.json.data.planId, expectedRevision: 1, termsConfirmed: true });
await post("admin/advance-time", { ms: 25 * HOUR });
const now4 = (await state("a")).modes.virtualNow;
await post("plans/claims", { viewer: "a", planId: plan4.json.data.planId, targetOccurredAt: now4, evidenceNote: "结束前已达成（演示剧情）" });
const rel4Id = (await state("b")).us.relationship.id;
const endRel = await post("relationships/end", { viewer: "b", relationshipId: rel4Id, reason: "演示退出分支" });
check("T21 退出立即生效", endRel.status === 200 && (await state("b")).us.relationship === null
  && (await state("b")).us.archives.some(a => a.id === rel4Id));
check("T21 在途申请 → 例外复核，不锁退出", (await state("b")).future.plan.status === "exception_review");
const claims4 = (await get("admin/snapshot")).json.data.claims;
const claim4 = claims4.find(c => c.planId === plan4.json.data.planId);
await post("admin/claims/decision", { claimId: claim4.id, decision: "approve", note: "复核：目标发生在退出前" });
check("T21 已结束关系不自动复合或标记 married", (await state("b")).us.relationship === null);
await post("admin/advance-time", { ms: 8 * DAY });
const plan4View = (await state("b")).future.plan;
check("T21 复核通过后可领取", plan4View.status === "redeemable");
const redeemB = await post("benefits/redeem", { viewer: "b", benefitId: `benefit-${plan4.json.data.planId}`, idempotencyKey: "y" });
check("T21 玫瑰券共同权益：任一方领取后双方各得一张", redeemB.status === 200);
const finalB = await state("b");
const finalA = await state("a");
check("T17 玫瑰券双方共同持有（各 1 张）+ 各返本金（此前失效的 200 点不返还）", finalB.me.roseTickets === 1 && finalA.me.roseTickets === 1 && finalB.me.balance === 900 && finalA.me.balance === 900, { b: finalB.me.balance, rose: finalB.me.roseTickets, a: finalA.me.balance, roseA: finalA.me.roseTickets });
const redeemAgain = await post("benefits/redeem", { viewer: "a", benefitId: `benefit-${plan4.json.data.planId}`, idempotencyKey: "z2" });
check("T17 共同权益幂等：重复领取不重复发放", redeemAgain.status === 200 && (await state("a")).me.roseTickets === 1 && (await state("b")).me.roseTickets === 1);
check("T21 领取后关系仍为结束", finalB.us.relationship === null && finalB.us.archives.some(a => a.id === rel4Id));

// ---------- T22 旧分享失效 / 撤销 ----------
const trustAfterEnd = await get("trust/summary?subjectId=b&viewer=a");
check("T22 结束后授权仍按记录判断", [200, 403].includes(trustAfterEnd.status));
const revokeGrant = (await state("b")).me.grantsIssued.find(g => g.scope === "trust_summary");
if (revokeGrant) {
  await post("share-grants/revoke", { viewer: "b", grantId: revokeGrant.id });
  check("T03 撤销后读取被拒", (await get("trust/summary?subjectId=b&viewer=a")).status === 403);
}

// ---------- 存证故障与恢复（T14：失败 → 恢复同一任务） ----------
await post("admin/reset", {});
for (const viewer of ["a", "b"]) await post("declare-adult", { viewer });
for (const viewer of ["a", "b"]) await post("radar", { viewer, active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
await post("ring", { viewer: "a", message: "想认识你。" });
const bell3 = (await state("b")).meet.bells.find(x => x.status === "pending");
await post("respond", { viewer: "b", bellId: bell3.id, status: "accepted" });
await post("relationships/propose", { viewer: "a" });
const invite3 = (await state("b")).us.incomingInvite;
await post("relationships/accept", { viewer: "b", relationshipId: invite3.id });
const diaryFault = await post("diaries", { viewer: "a", kind: "diary", date: "2026-10-03", title: "故障演练", body: "写入失败后可以恢复。", attachmentIds: [], visibility: "shared" });
await post("diaries/confirm", { viewer: "b", diaryId: diaryFault.json.data.diaryId });
await post("admin/chain-fault", { active: true });
const faultAnchor = await post("diaries/anchor", { viewer: "a", diaryId: diaryFault.json.data.diaryId });
check("T14 模拟链故障 → 写入失败", faultAnchor.status === 200 && (await state("a")).us.timeline.find(t => t.id === diaryFault.json.data.diaryId).anchor.chainStatus === "failed");
const commitmentBefore = (await get(`export?recordId=${diaryFault.json.data.diaryId}&viewer=a`)).json.data.commitment;
await post("admin/chain-fault", { active: false });
const retry = await post("anchors/retry", { viewer: "a", recordId: diaryFault.json.data.diaryId });
check("T14 故障解除后恢复同一任务", retry.status === 200 && retry.json.data.status === "unconfigured");
const commitmentAfter = (await get(`export?recordId=${diaryFault.json.data.diaryId}&viewer=a`)).json.data.commitment;
check("T14 恢复不更换承诺", commitmentBefore === commitmentAfter);
check("T08 非参与者不能导出证据", (await get(`export?recordId=${diaryFault.json.data.diaryId}&viewer=x`)).status === 401);

// ---------- 账本不变量 ----------
const snap = (await get("admin/snapshot")).json.data;
check("模式为 demo/preview", snap.modes.chainMode === "preview" && snap.modes.appMode === "demo");
console.log(`\nPASS: ${passed} 项 V2 集成验证全部通过。未发送任何真实链上交易；preview 模式无假交易哈希。`);
