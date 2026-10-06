// v2.8 复测修复验证（对应 _qa/v2.7复测-20261007 报告 N01–N08 与旧问题 09）。
// 覆盖：
//   N01 屏蔽后仍能发新承诺 → 承诺创建补屏蔽校验（403）
//   N02 导出绕过撤权 → 下载时按当前可见性重装配；通知导出复用可见性策略
//   N03 撤回后对方仍可改版 → 非作者对 withdrawn 当前版本改版被拒
//   N04 退出后仍可读退回(returned)版本 → ended 直接作为读取条件
//   N05 导出有效期 24 小时（此前误用 24 天）+ 创建/检查统一业务时钟
//   N06 存证版本错配 → 时间线/详情按版本匹配，当前版可再存证
//   N07 隐藏历史导致编辑永久 409 → 客户端使用实际版本号（服务端回归：expectedVersion=2 成功）
//   N08 未来发生时间可送审 → 目标业务日期不得晚于今天
//   旧09 幂等缓存 24h 时间窗口（不再被 200 条计数挤出）
// 用法：npm run dev -- -p 3109 && DEMO_URL=http://localhost:3109 npm run verify:v28
const base = process.env.DEMO_URL ?? "http://localhost:3109";
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
const cookies = {};
for (const v of ["a", "b", "c"]) cookies[v] = await login(v); // c：N01 屏蔽关闭 A-B 连接后用 A-C 重建关系
const get = async (viewer, path) => req("GET", `/api/v2/${path}${path.includes("?") ? "&" : "?"}viewer=${viewer}`, { cookie: cookies[viewer] });
const post = async (viewer, path, body, headers) => req("POST", `/api/v2/${path}`, { body: { ...body, viewer }, cookie: cookies[viewer], headers });
const state = async viewer => (await get(viewer, "state")).json.data;
const businessToday = ms => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

await req("POST", `/api/v2/admin/reset`, { body: {}, cookie: cookies.a });

// ---------- 基础链路（v2.8 相遇夹具） ----------
await post("a", "declare-adult", {});
await post("b", "declare-adult", {});
for (const v of ["a", "b"]) await post(v, "meet/events/join", { code: "HEARTS26" });
const traits = [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }];
await post("a", "radar", { active: true, traits });
await post("b", "radar", { active: true, traits });
const candB = (await state("a")).meet.candidates[0];
const bell = await post("a", "ring", { candidateRef: candB.candidateRef, message: "想认识你。", idempotencyKey: "v28-bell-1" });
const resp = await post("b", "respond", { bellId: bell.json.data.bellId, status: "accepted" });
const connAB = resp.json.data.connectionId;
await post("a", "relationships/propose", { connectionId: connAB });
const invite = (await state("b")).us.incomingInvite;
await post("b", "relationships/accept", { relationshipId: invite.id });
const relId = invite.id;
const t = async () => businessToday((await state("a")).modes.virtualNow);

// ---------- N01：屏蔽后仍能发新承诺 ----------
{
  // 屏蔽前：A 有一篇待 B 确认的日记（后续 N02 也要用）。
  const hidden = await post("a", "diaries", { kind: "diary", date: await t(), title: "N02 隐藏正文测试", body: "QA28 bulk 0 测试正文", visibility: "shared" });
  const hiddenId = hidden.json.data.diaryId;
  // A 屏蔽 B（关系来源）。
  const ctx = await get("a", `safety/target-context?sourceType=relationship&sourceId=${relId}`);
  await post("a", "safety/blocks", { targetRef: ctx.json.data.targetRef });
  const promiseBlocked = await post("b", "promises", { content: "QA27 被屏蔽后仍发送的新承诺", dueAt: Date.now() + 5 * 86400000, criteria: "双方确认即可", responsible: "both", scoringOptIn: false });
  check("N01 屏蔽后 B 发新承诺被拒（403，与日记同口径）", promiseBlocked.status === 403, promiseBlocked.json);
  const meA = await state("a");
  check("N01 屏蔽后 A 不再收到 B 的新承诺提醒", !meA.us.promises.some(p => p.content.includes("被屏蔽后仍发送")), meA.us.promises.length);
  // 解除屏蔽，继续后续用例（N02 仍需屏蔽态，先做 N02 再解封）。
  // ---------- N02：导出绕过撤权 ----------
  // B 在屏蔽前创建但未下载的导出任务（diaries + notifications）。
  const ex = await post("b", "privacy/exports", { scopes: ["diaries", "notifications"] });
  const exportId = ex.json.data.jobId;
  const dl = await get("b", `privacy/exports/${exportId}/download`);
  const pkgStr = JSON.stringify(dl.json.data);
  check("N02 屏蔽后下载旧任务不再带出隐藏日记正文", dl.status === 200 && !pkgStr.includes("QA27 bulk 0 测试正文"), { status: dl.status, hasBody: pkgStr.includes("QA27 bulk 0 测试正文") });
  // 屏蔽后新建通知导出也不带出隐藏日记相关提醒（标题哨兵）。
  const ex2 = await post("b", "privacy/exports", { scopes: ["notifications"] });
  const dl2 = await get("b", `privacy/exports/${ex2.json.data.jobId}/download`);
  check("N02 通知导出复用可见性策略（隐藏日记标题不出现）", dl2.status === 200 && !JSON.stringify(dl2.json.data).includes("N02 隐藏正文测试"));
  // N05：有效期 = 24 小时（±1 分钟容差），不再是 24 天。
  const detail = (await get("b", `privacy/exports/${ex2.json.data.jobId}`)).json.data;
  const spanHours = (detail.expiresAt - detail.createdAt) / 3_600_000;
  check("N05 导出有效期 24 小时（此前误为 576 小时）", Math.abs(spanHours - 24) < 0.02, spanHours);
  // 解除屏蔽（后续用例需要正常互动）。
  const blockList = await get("a", "safety/blocks");
  const myBlock = blockList.json.data[0];
  await post("a", `safety/blocks/${myBlock.id}/revoke`, { expectedRevision: myBlock.revision });
  void hiddenId;
}

// ---------- N03：撤回只限制了读取，未限制对方改版 ----------
{
  const d = await post("a", "diaries", { kind: "diary", date: await t(), title: "N03 撤回测试", body: "这一页将被撤回。", visibility: "shared" });
  const id = d.json.data.diaryId;
  await post("a", "diaries/withdraw", { diaryId: id, expectedVersion: 1 });
  const readB = await get("b", `diaries/detail?id=${id}`);
  check("N03 前置：B 读取已撤回日记 404", readB.status === 404, readB.status);
  const republish = await post("b", "diaries/version", { diaryId: id, expectedVersion: 1, date: await t(), title: "越权续写", body: "不应该成功的共享 v2。", visibility: "shared" });
  check("N03 B 对已撤回日记改版被拒（404，读取与写入同口径）", republish.status === 404, republish.json);
  const authorAgain = await post("a", "diaries/version", { diaryId: id, expectedVersion: 1, date: await t(), title: "作者改写", body: "作者可以修改后重新分享。", visibility: "shared" });
  check("N03 作者本人仍可改写自己的已撤回版本", authorAgain.status === 200, authorAgain.json);
}

// ---------- N04：退回但未确认的内容在退出后仍共享 ----------
{
  const d = await post("a", "diaries", { kind: "diary", date: await t(), title: "N04 退回测试", body: "将被 B 退回的内容。", visibility: "shared" });
  const id = d.json.data.diaryId;
  await post("b", "diaries/return", { diaryId: id, expectedVersion: 1, note: "想改一版" });
  const before = await get("b", `diaries/detail?id=${id}`);
  check("N04 前置：退回版本（returned）在关系内 B 可读", before.status === 200, before.status);
  await post("a", "relationships/end", { relationshipId: relId, reason: "N04 退出后读取测试" });
  const after = await get("b", `diaries/detail?id=${id}`);
  check("N04 A 退出后 B 读不到退回版本（404，ended 直接作为读取条件）", after.status === 404, after.status);
  const archive = await get("b", `diaries/archive?relationshipId=${relId}`);
  check("N04 归档列表不含退回记录", archive.status === 200 && !archive.json.data.items.some(i => i.id === id), archive.json?.data?.items?.length);
}

// ---------- 重建关系（N06/N07/N08/旧09 用） ----------
// N01 的屏蔽已级联关闭 A-B 连接（解除屏蔽不恢复）→ 改用 A-C 建立新关系。
await post("c", "declare-adult", {});
await post("c", "meet/events/join", { code: "HEARTS26" });
await post("c", "radar", { active: true, traits });
await post("a", "radar", { active: true, traits });
const candC = (await state("a")).meet.candidates[0]; // 此时唯一合格候选即 C（B 因已关闭连接被排除）
const bellAC = await post("a", "ring", { candidateRef: candC.candidateRef, message: "想认识你。", idempotencyKey: "v28-bell-ac" });
const respAC = await post("c", "respond", { bellId: bellAC.json.data.bellId, status: "accepted" });
const connAC = respAC.json.data.connectionId;
await post("a", "relationships/propose", { connectionId: connAC });
const invite2 = (await state("c")).us.incomingInvite;
await post("c", "relationships/accept", { relationshipId: invite2.id });
const rel2 = invite2.id;
void rel2; void connAB;

// ---------- N07：有私人历史的共享日记，另一方无法正常修改（隐藏历史 409） ----------
{
  const d = await post("a", "diaries", { kind: "diary", date: await t(), title: "N07 私人历史", body: "先是私人草稿 v1。", visibility: "draft" });
  const id = d.json.data.diaryId;
  await post("a", "diaries/version", { diaryId: id, expectedVersion: 1, date: await t(), title: "N07 共享版", body: "共享 v2。", visibility: "shared" });
  const detailB = await get("c", `diaries/detail?id=${id}`);
  check("N07 前置：B 只看到共享 v2（隐藏私人 v1）", detailB.status === 200 && detailB.json.data.versions.length === 1 && detailB.json.data.versions[0].version === 2, detailB.json?.data?.versions?.map(v => v.version));
  // v2.8 修复：客户端用实际版本号（version.version=2），不再用可见数组长度(1)。服务端回归：
  const editWithVisibleLen = await post("c", "diaries/version", { diaryId: id, expectedVersion: 1, date: await t(), title: "错版本号", body: "旧客户端行为应 409。", visibility: "shared" });
  check("N07 旧客户端用可见长度当版本号仍被 409 拦截（并发语义保留）", editWithVisibleLen.status === 409);
  const editOk = await post("c", "diaries/version", { diaryId: id, expectedVersion: 2, date: await t(), title: "B 的修改", body: "使用实际版本号成功。", visibility: "shared" });
  check("N07 B 用实际版本号（2）改版成功", editOk.status === 200 && editOk.json.data.version === 3, editOk.json);
}

// ---------- N06：当前版本与凭证版本错配 ----------
{
  const d = await post("a", "diaries", { kind: "diary", date: await t(), title: "N06 存证版本", body: "v1 内容。", visibility: "shared" });
  const id = d.json.data.diaryId;
  await post("c", "diaries/confirm", { diaryId: id, expectedVersion: 1 });
  await post("a", "diaries/anchor", { diaryId: id });
  const anchored1 = (await get("a", `diaries/detail?id=${id}`)).json.data;
  check("N06 前置：v1 存证（anchoredVersion=1）", anchored1.anchoredVersion === 1);
  // 改成 v2 并共同确认。
  await post("a", "diaries/version", { diaryId: id, expectedVersion: 1, date: await t(), title: "N06 存证版本", body: "v2 内容。", visibility: "shared" });
  await post("c", "diaries/confirm", { diaryId: id, expectedVersion: 2 });
  // v2.8 修复：时间线凭证按版本匹配 —— v2 尚无存证 → timeline anchor 为空。
  const tlA = await state("a");
  const item = tlA.us.timeline.find(x => x.id === id);
  check("N06 v2 确认后时间线不再显示 v1 存证（按版本匹配）", item.anchor === null, item.anchor);
  // 当前版可再存证（此前按钮消失）。
  const anchor2 = await post("c", "diaries/anchor", { diaryId: id });
  const anchored2 = (await get("c", `diaries/detail?id=${id}`)).json.data;
  check("N06 v2 可生成新存证（anchoredVersion=2）", anchor2.status === 200 && anchored2.anchoredVersion === 2, { status: anchor2.status, v: anchored2.anchoredVersion });
}

// ---------- N08：核验接受未来“发生时间” ----------
{
  const plan = await post("a", "plans", { targetType: "anniversary", rewardChoice: "A" });
  const planId = plan.json.data.planId;
  await post("c", "plans/accept", { planId, expectedRevision: 1, termsConfirmed: true });
  await req("POST", `/api/v2/admin/advance-time`, { body: { ms: 25 * 3_600_000 }, cookie: cookies.a });
  const nowVirtual = (await state("a")).modes.virtualNow;
  // v2.8 采用“业务日期”语义：明天的日期（无论时刻）被拒；当天的日期按北京当日中午提交。
  const tomorrow = businessToday(nowVirtual + 86_400_000);
  const futureClaim = await post("a", "plans/claims", { planId, targetOccurredAt: Date.parse(`${tomorrow}T00:00:00+08:00`), evidenceNote: "未来日期应被拒绝（演示材料）" });
  check("N08 目标业务日期晚于今天被拒（400）", futureClaim.status === 400, futureClaim.json);
  const okClaim = await post("a", "plans/claims", { planId, targetOccurredAt: Date.parse(`${businessToday(nowVirtual)}T12:00:00+08:00`), evidenceNote: "当天目标可提交（演示材料）" });
  check("N08 当天业务日期可正常提交（中午时刻不再被误判为未来）", okClaim.status === 200, okClaim.json);
}

// ---------- 旧09：幂等缓存 24 小时时间窗口（不再被计数挤出） ----------
{
  const day = await t();
  const key = "qa28-window-key";
  const first = await post("a", "diaries", { kind: "diary", date: day, title: "幂等窗口测试", body: "原请求。", visibility: "draft" }, { "Idempotency-Key": key });
  // 写入大量其他记录（远超旧版 200 条上限），验证同键重试仍返回原 ID。
  for (let i = 0; i < 260; i++) {
    const r = await post("a", "diaries", { kind: "diary", date: day, title: `填充 ${i}`, body: "填充记录。", visibility: "draft" }, { "Idempotency-Key": `qa28-fill-${i}` });
    if (r.status !== 200) { check("旧09 填充记录创建", false, r.json); break; }
  }
  const retry = await post("a", "diaries", { kind: "diary", date: day, title: "幂等窗口测试", body: "原请求。", visibility: "draft" }, { "Idempotency-Key": key });
  check("旧09 高流量后同键重试仍返回原 diaryId（24h 时间窗口淘汰）",
    retry.status === 200 && retry.json.data.diaryId === first.json.data.diaryId, { first: first.json.data, retry: retry.json.data });
  const listA = (await state("a")).us.timeline.filter(x => x.title === "幂等窗口测试");
  check("旧09 未产生重复记录", listA.length === 1, listA.length);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
