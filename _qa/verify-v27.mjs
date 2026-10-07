// v2.7 双用户实测缺陷修复验证（对应 _qa/双用户实测-20261007 测试简报）。
// 覆盖：
//   P0-01 私人草稿越权读写 → 详情 404 / 改版 403
//   P0-02 旧版本确认新版本 → expectedVersion 冲突 409 / 缺失 400；隐藏草稿不阻塞共享确认
//   P0-03 退出后共同写入 → 改版/确认 403；归档只读可读
//   P1-04 后台工单自领自审 → session 返回 accountId，assignedTo 与之相等，决定可提交
//   P1-08 归档列表接口 → 已确认版本可检索
//   P1-09 Idempotency-Key 幂等 → 重复提交返回同一 diaryId
//   P1-10 业务时区 + 真实日历 → 2026-02-30 / 未来日期 400，北京时间今天可写
//   P1-11 附件魔数与字节口径 → 文本冒充 png 400、伪 jpeg 400、真实 png 200、620KB 400
// 用法：npm run dev -- -p 3107 && DEMO_URL=http://localhost:3107 node _qa/verify-v27.mjs
const base = process.env.DEMO_URL ?? "http://localhost:3107";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 400) : ""}`); }
}
async function req(method, path, { body, cookie, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: base } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空 */ }
  return { status: res.status, json };
}
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
for (const v of ["a", "b"]) cookies[v] = await login(v);
const get = async (viewer, path, headers) => req("GET", `/api/v2/${path}${path.includes("?") ? "&" : "?"}viewer=${viewer}`, { cookie: cookies[viewer], headers });
const post = async (viewer, path, body, headers) => req("POST", `/api/v2/${path}`, { body: { ...body, viewer }, cookie: cookies[viewer], headers });
const state = async viewer => (await get(viewer, "state")).json.data;

// 业务时区（北京时间）日期键 —— 与服务端同口径。
const businessToday = ms => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

await req("POST", `/api/v2/admin/reset`, { body: {}, cookie: cookies.a });

// ---------- 基础链路：成年声明 → 雷达 → 摇铃 → 回响 → 邀请 → 建立 ----------
await post("a", "declare-adult", {});
await post("b", "declare-adult", {});
const traits = [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }];
await post("a", "radar", { active: true, traits });
await post("b", "radar", { active: true, traits });
const bell = await post("a", "ring", { message: "想认识你。" });
await post("b", "respond", { bellId: bell.json.data.bellId, status: "accepted" });
await post("a", "relationships/propose", {});
const invite = (await state("b")).us.incomingInvite;
check("前置：B 收到关系邀请", !!invite);
const relId = invite.id;
await post("b", "relationships/accept", { relationshipId: relId });
check("前置：关系建立", (await state("a")).us.relationship?.id === relId);

// ---------- P1-09：Idempotency-Key 服务端幂等 ----------
const idemHeader = { "Idempotency-Key": "qa-v27-idem-1" };
const t = businessToday((await state("a")).modes.virtualNow);
const c1 = await post("a", "diaries", { kind: "diary", date: t, title: "幂等测试", body: "同键重试应返回同一条。", visibility: "draft" }, idemHeader);
const c2 = await post("a", "diaries", { kind: "diary", date: t, title: "幂等测试", body: "同键重试应返回同一条。", visibility: "draft" }, idemHeader);
check("P1-09 请求头 Idempotency-Key 重复提交返回同一 diaryId",
  c1.status === 200 && c2.status === 200 && c1.json.data.diaryId === c2.json.data.diaryId, { c1: c1.json, c2: c2.json });
const c3 = await post("a", "diaries", { kind: "diary", date: t, title: "幂等测试", body: "body 键同样幂等。", visibility: "draft", idempotencyKey: "qa-v27-idem-2" });
const c4 = await post("a", "diaries", { kind: "diary", date: t, title: "幂等测试", body: "body 键同样幂等。", visibility: "draft", idempotencyKey: "qa-v27-idem-2" });
check("P1-09 body.idempotencyKey 重复提交返回同一 diaryId",
  c3.status === 200 && c4.status === 200 && c3.json.data.diaryId === c4.json.data.diaryId);
const c5 = await post("a", "diaries", { kind: "diary", date: t, title: "幂等测试", body: "无键时正常新建。", visibility: "draft" });
check("P1-09 无幂等键时正常生成新记录", c5.status === 200 && c5.json.data.diaryId !== c1.json.data.diaryId);

// ---------- P0-01：私人草稿越权读写 ----------
const draftA = c1.json.data.diaryId; // A 的私人草稿
const listB = (await state("b")).us.timeline.map(x => x.id);
check("P0-01 B 的列表不含 A 的私人草稿", !listB.includes(draftA));
const draftRead = await get("b", `diaries/detail?id=${draftA}`);
check("P0-01 B 读取 A 私人草稿详情被拒（404 掩护）", draftRead.status === 404, draftRead.json);
const draftWrite = await post("b", "diaries/version", { diaryId: draftA, expectedVersion: 1, date: t, title: "越权改写", body: "不应该成功。", visibility: "shared" });
check("P0-01 B 改写 A 私人草稿被拒（403）", draftWrite.status === 403, draftWrite.json);

// ---------- P0-02：旧版本确认新版本 ----------
const stale = await post("a", "diaries", { kind: "diary", date: t, title: "界面旧版本确认", body: "版本一：周六一起散步。", visibility: "shared" });
const staleId = stale.json.data.diaryId;
const v1seen = await get("b", `diaries/detail?id=${staleId}`);
check("P0-02 前置：B 看到 v1 待确认", v1seen.json.data.versions.length === 1 && v1seen.json.data.versions[0].status === "awaiting");
await post("a", "diaries/version", { diaryId: staleId, expectedVersion: 1, date: t, title: "界面旧版本确认", body: "版本二：改成周日爬山。", visibility: "shared" });
const staleConfirm = await post("b", "diaries/confirm", { diaryId: staleId, expectedVersion: 1 });
check("P0-02 B 用旧版本号确认被拒（409 冲突）", staleConfirm.status === 409, staleConfirm.json);
const missingConfirm = await post("b", "diaries/confirm", { diaryId: staleId });
check("P0-02 缺少 expectedVersion 的确认被拒（400）", missingConfirm.status === 400, missingConfirm.json);
const freshConfirm = await post("b", "diaries/confirm", { diaryId: staleId, expectedVersion: 2 });
check("P0-02 B 确认当前版本成功", freshConfirm.status === 200, freshConfirm.json);
const afterConfirm = await get("b", `diaries/detail?id=${staleId}`);
check("P0-02 v2 双方确认", afterConfirm.json.data.versions[1].status === "confirmed");

// 隐藏草稿不阻塞共享确认（对方看不到的新草稿不算“新共享版本”）。
const mixed = await post("a", "diaries", { kind: "diary", date: t, title: "混合版本", body: "共享第一版。", visibility: "shared" });
const mixedId = mixed.json.data.diaryId;
await post("a", "diaries/version", { diaryId: mixedId, expectedVersion: 1, date: t, title: "混合版本", body: "尚未告诉对方的新草稿。", visibility: "draft" });
const mixedConfirm = await post("b", "diaries/confirm", { diaryId: mixedId, expectedVersion: 1 });
check("P0-02 仅被隐藏草稿超越时仍可确认共享版", mixedConfirm.status === 200, mixedConfirm.json);

// ---------- P1-10：业务时区与真实日历 ----------
const badCalendar = await post("a", "diaries", { kind: "diary", date: "2026-02-30", title: "无效日期", body: "不应入库。", visibility: "draft" });
check("P1-10 无效日历日期 2026-02-30 被拒（400）", badCalendar.status === 400, badCalendar.json);
const futureMs = (await state("a")).modes.virtualNow + 2 * 86_400_000;
const futureDate = businessToday(futureMs);
const badFuture = await post("a", "diaries", { kind: "diary", date: futureDate, title: "未来日期", body: "不应入库。", visibility: "draft" });
check("P1-10 未来日期被拒（400，北京时间口径）", badFuture.status === 400, { futureDate, res: badFuture.json });
const todayOk = await post("a", "diaries", { kind: "diary", date: t, title: "今天可写", body: "北京时间今天。", visibility: "draft" });
check("P1-10 北京时间今天可写入（凌晨不再错位）", todayOk.status === 200, todayOk.json);

// ---------- P1-11：附件魔数与字节口径 ----------
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString("base64");
const fakePng = Buffer.from("这不是一张图片，只是纯文本。", "utf8").toString("base64");
const fakeJpg = Buffer.from([0xff, 0xd0, 0xff, 0x00]).toString("base64"); // ff d8 ff 才是合法 jpeg 头
const attach = entries => post("a", "diaries", { kind: "diary", date: t, title: "附件校验", body: "附件边界。", visibility: "draft", attachments: entries });
const rFakePng = await attach([{ name: "fake.png", dataUrl: `data:image/png;base64,${fakePng}` }]);
check("P1-11 纯文本冒充 png 被拒（400）", rFakePng.status === 400, rFakePng.json);
const rFakeJpg = await attach([{ name: "fake.jpg", dataUrl: `data:image/jpeg;base64,${fakeJpg}` }]);
check("P1-11 伪 jpeg 魔数被拒（400）", rFakeJpg.status === 400, rFakeJpg.json);
const rRealPng = await attach([{ name: "real.png", dataUrl: `data:image/png;base64,${pngMagic}` }]);
check("P1-11 真实 png 魔数通过", rRealPng.status === 200, rRealPng.json);
const bigMd = Buffer.alloc(620_000, 0x61).toString("base64"); // 620KB 文本 > 600KB 上限
const rBigMd = await attach([{ name: "big.md", dataUrl: `data:text/markdown;base64,${bigMd}` }]);
check("P1-11 620KB 附件被拒（解码字节口径 ≤600KB）", rBigMd.status === 400, rBigMd.json);
const okMd = Buffer.alloc(200_000, 0x62).toString("base64");
const rOkMd = await attach([{ name: "ok.md", dataUrl: `data:text/markdown;base64,${okMd}` }]);
check("P1-11 200KB 真实文本通过", rOkMd.status === 200, rOkMd.json);

// ---------- P0-03 / P1-08：退出后只读 + 归档 ----------
const awaiting = await post("a", "diaries", { kind: "diary", date: t, title: "退出前待确认", body: "退出后不能确认。", visibility: "shared" });
const awaitingId = awaiting.json.data.diaryId;
await post("a", "relationships/end", { relationshipId: relId, reason: "回归测试：验证退出后只读" });
check("P0-03 前置：关系已结束", (await state("b")).us.relationship === null);
const postExitWrite = await post("b", "diaries/version", { diaryId: staleId, expectedVersion: 2, date: t, title: "退出后改写", body: "不应该成功。", visibility: "shared" });
check("P0-03 退出后改版被拒（403）", postExitWrite.status === 403, postExitWrite.json);
const postExitConfirm = await post("b", "diaries/confirm", { diaryId: awaitingId, expectedVersion: 1 });
check("P0-03 退出后确认被拒（403）", postExitConfirm.status === 403, postExitConfirm.json);
const archive = await get("b", `diaries/archive?relationshipId=${relId}`);
check("P1-08 归档列表可读且包含已确认记录",
  archive.status === 200 && archive.json.data.items.some(i => i.id === staleId), archive.json?.data);
check("P1-08 归档不含未共同确认的记录",
  archive.status === 200 && !archive.json.data.items.some(i => i.id === awaitingId));
const archiveDetail = await get("b", `diaries/detail?id=${staleId}`);
check("P1-08 归档详情仍可读（仅确认版本）", archiveDetail.status === 200, archiveDetail.json);

// ---------- P1-04：后台工单自领自审（UI 闭环） ----------
await post("a", "relationships/propose", {});
const invite2 = (await state("b")).us.incomingInvite;
await post("b", "relationships/accept", { relationshipId: invite2.id });
const plan = await post("a", "plans", { targetType: "anniversary", rewardChoice: "A" });
const planId = plan.json.data.planId;
await post("b", "plans/accept", { planId, expectedRevision: 1, termsConfirmed: true });
await req("POST", `/api/v2/admin/advance-time`, { body: { ms: 25 * 3_600_000 }, cookie: cookies.a });
const nowVirtual = (await state("a")).modes.virtualNow;
await post("a", "plans/claims", { planId, targetOccurredAt: nowVirtual - 3_600_000, evidenceNote: "演示材料（非真实证件）" });
const ownerLogin = await ops("POST", "login", { username: "owner", password: "heartbell-owner" });
const ownerCookie = (ownerLogin.setCookie ?? "").split(";")[0];
const session = await ops("GET", "session", undefined, ownerCookie);
check("P1-04 session 返回 accountId", session.status === 200 && typeof session.json.data.accountId === "string", session.json);
const accountId = session.json.data.accountId;
const claimsList = await ops("GET", "claims?status=submitted", undefined, ownerCookie);
const claimId = claimsList.json.data.items[0]?.id;
check("P1-04 前置：待审核工单存在", !!claimId, claimsList.json);
const assign = await ops("POST", `claims/${claimId}/assign`, { assigneeId: "me" }, ownerCookie);
check("P1-04 领取工单成功", assign.status === 200, assign.json);
const claimDetail = await ops("GET", `claims/${claimId}`, undefined, ownerCookie);
check("P1-04 assignedTo === 当前管理员 accountId（页面解锁判定）",
  claimDetail.json.data.assignedTo === accountId, { assignedTo: claimDetail.json.data.assignedTo, accountId });
const decision = await ops("POST", `claims/${claimId}/decision`, {
  decision: "approve", reasonCode: "MATERIAL_COMPLETE", note: "演示通过",
  expectedClaimRevision: claimDetail.json.data.revision,
  expectedPlanRevision: claimDetail.json.data.plan.revision,
}, ownerCookie);
check("P1-04 自领后可经接口提交决定（UI 闭环恢复）", decision.status === 200, decision.json);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
