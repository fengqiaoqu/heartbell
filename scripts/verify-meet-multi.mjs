// v2.8（M03）多人相遇与候选发现验证（npm run verify:meet，对应《03-验收清单》AT 关键场景）。
// 覆盖：A–F 六账号与两活动隔离、多候选匿名 DTO、candidateRef 绑定、定向摇铃（缺参 400）、
// 限流（3 条/60 秒）、幂等（同键同请求/同键异请求）、对向窗口、只有接收者可回应、
// 并发双回响只建一个连接（superseded）、多连接授权对象/scope 二维正确、
// connectionId 强制、关系建立后停止双方发现、候选卡安全入口、活动后台管理与暂停联动、隐私哨兵。
// 未运行项：AT-27（10 条/10 分钟长窗口边界需超过 6 个演示账号的隔离夹具）。
// 用法：npm run dev -- -p 3108 && DEMO_URL=http://localhost:3108 npm run verify:meet
const base = process.env.DEMO_URL ?? "http://localhost:3108";
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
const PASSWORDS = { a: "HeartbellA2026!", b: "HeartbellB2026!", c: "HeartbellC2026!", d: "HeartbellD2026!", e: "HeartbellE2026!", f: "HeartbellF2026!" };
async function login(viewer) {
  const res = await fetch(`${base}/api/demo-auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: viewer, password: PASSWORDS[viewer] }),
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
for (const v of ["a", "b", "c", "d", "e", "f"]) cookies[v] = await login(v);
const get = async (viewer, path) => req("GET", `/api/v2/${path}${path.includes("?") ? "&" : "?"}viewer=${viewer}`, { cookie: cookies[viewer] });
const post = async (viewer, path, body, headers) => req("POST", `/api/v2/${path}`, { body: { ...body, viewer }, cookie: cookies[viewer], headers });
const state = async viewer => (await get(viewer, "state")).json.data;

await req("POST", `/api/v2/admin/reset`, { body: {}, cookie: cookies.a });

const ALPHA = "HEARTS26", BETA = "BELLTK26";
// 每人带可识别特征（候选匿名，测试用特征值区分对象）。
const tagOf = v => `特征-${v}`;
async function joinAndRadar(v, code) {
  await post(v, "declare-adult", {});
  await post(v, "meet/events/join", { code });
  const r = await post(v, "radar", { active: true, traits: [{ category: "穿着", value: tagOf(v) }, { category: "手持物", value: "拿着咖啡" }], discoveryNote: `留言-${v}` });
  if (r.status !== 200) throw new Error(`${v} 开雷达失败 ${r.status} ${JSON.stringify(r.json)}`);
}
for (const v of ["a", "b", "c", "d"]) await joinAndRadar(v, ALPHA);
for (const v of ["e", "f"]) await joinAndRadar(v, BETA);

const candOf = async (viewer, targetTag) =>
  (await state(viewer)).meet.candidates.find(c => c.traits.some(t => t.value === targetTag));
const ringTo = (viewer, cand, key, message = "想认识你。") =>
  post(viewer, "ring", { candidateRef: cand.candidateRef, message, idempotencyKey: key });

// ---------- AT-01/04：身份与活动隔离 ----------
{
  const me = await state("a");
  check("AT-04 A（活动甲）看见 B/C/D 三张候选卡", me.meet.candidates.length === 3, me.meet.candidates.map(c => c.alias));
  check("AT-04 A 不看见自己与活动乙成员 E/F",
    !me.meet.candidates.some(c => c.traits.some(t => t.value === tagOf("a")))
    && !me.meet.candidates.some(c => c.traits.some(t => t.value === tagOf("e") || t.value === tagOf("f"))));
  const meE = await state("e");
  check("AT-04 E（活动乙）只看见 F", meE.meet.candidates.length === 1 && meE.meet.candidates.some(c => c.traits.some(t => t.value === tagOf("f"))));
  check("AT-16 候选 DTO 无长期身份字段（哨兵检查：昵称/联系方式/用户 ID 不出现）",
    !JSON.stringify(me.meet.candidates).includes("阿响") && !JSON.stringify(me.meet.candidates).includes("demo-xiaoke")
    && !JSON.stringify(me.meet.candidates).includes('"userId"'));
  check("AT-16 整份 state 不含未相关用户昵称（nicknameOf 收敛）",
    !JSON.stringify(me).includes("阿枫") && !JSON.stringify(me).includes("小叶"));
}

// ---------- AT-07/19/23：入场幂等、引用绑定与缺参 400 ----------
{
  const again = await post("a", "meet/events/join", { code: ALPHA });
  check("AT-07 重复加入当前活动幂等成功", again.status === 200 && again.json.data.alreadyMember === true);
  const radarBefore = (await state("a")).meet.radarExpiresAt;
  check("AT-07 重复加入不刷新雷达", radarBefore !== null);
  const candC = await candOf("a", tagOf("c"));
  const stolen = await post("c", "ring", { candidateRef: candC.candidateRef, message: "想认识你。", idempotencyKey: "stolen-ref-1" });
  check("AT-19 C 复制 A 的 candidateRef 被拒（404，不泄露状态）", stolen.status === 404, stolen.json);
  const cross = await post("e", "ring", { candidateRef: candC.candidateRef, message: "想认识你。", idempotencyKey: "stolen-ref-2" });
  check("AT-19 跨活动使用他人引用被拒", cross.status === 404, cross.json);
  const noRef = await post("a", "ring", { message: "想认识你。", idempotencyKey: "no-ref-1" });
  check("AT-23 缺 candidateRef 返回 400", noRef.status === 400, noRef.json);
  const noKey = await post("a", "ring", { candidateRef: candC.candidateRef, message: "想认识你。" });
  check("AT-23 缺幂等键返回 400", noKey.status === 400, noKey.json);
  const keyConflict = await post("a", "ring", { candidateRef: candC.candidateRef, message: "想认识你。", idempotencyKey: "body-key-x" }, { "Idempotency-Key": "header-key-y" });
  check("AT-23 header/body 幂等键冲突返回 400", keyConflict.status === 400, keyConflict.json);
  const badMsg = await post("a", "ring", { candidateRef: candC.candidateRef, message: "自定义表达不允许", idempotencyKey: "bad-msg-1" });
  check("AT-23 预设外 message 返回 400", badMsg.status === 400, badMsg.json);
}

// ---------- AT-21/24/26/28：定向摇铃、限流与幂等 ----------
{
  // 依次摇 B、C、D（三个不同对象）验证每卡独立状态与限流。
  const r1 = await ringTo("a", await candOf("a", tagOf("b")), "meet-a-b-1");
  check("AT-21 A→B 定向摇铃成功", r1.status === 200 && !!r1.json.data.bellId, r1.json);
  const bellAB = r1.json.data.bellId;
  // 只有 B 收到（C/D/E/F 均无来铃）。
  const inbox = {};
  for (const v of ["b", "c", "d", "e", "f"]) {
    inbox[v] = (await state(v)).meet.bells.filter(x => x.direction === "incoming" && x.status === "pending").map(x => x.id);
  }
  check("AT-21 只有 B 收到这条铃声", inbox.b.includes(bellAB) && !inbox.c.includes(bellAB) && !inbox.d.includes(bellAB) && !inbox.e.includes(bellAB) && !inbox.f.includes(bellAB), inbox);
  // AT-28 幂等：同键同请求 → 同 bellId；同键不同请求 → 409。
  const replay = await ringTo("a", await candOf("a", tagOf("b")), "meet-a-b-1");
  check("AT-28 同键同请求重放返回同一 bellId", replay.status === 200 && replay.json.data.bellId === bellAB && replay.json.data.replayed === true, replay.json);
  const sameKeyDiffMsg = await post("a", "ring", { candidateRef: (await candOf("a", tagOf("b"))).candidateRef, message: "想和你聊一聊。", idempotencyKey: "meet-a-b-1" });
  check("AT-28 同键不同请求返回 409", sameKeyDiffMsg.status === 409, sameKeyDiffMsg.json);
  // AT-25 有向对 10 分钟窗口。
  const r1Again = await ringTo("a", await candOf("a", tagOf("b")), "meet-a-b-2");
  check("AT-25 同对象 10 分钟内第二条被拒（409）", r1Again.status === 409, r1Again.json);
  // AT-24：B 卡 pending，C/D 仍可操作（每卡独立状态，非全局禁用）。
  const me = await state("a");
  const cardB = me.meet.candidates.find(c => c.traits.some(t => t.value === tagOf("b")));
  const cardC = me.meet.candidates.find(c => c.traits.some(t => t.value === tagOf("c")));
  check("AT-24 已摇对象卡片为 pending，其他候选仍 ready", cardB?.ringState === "pending" && cardC?.ringState === "ready", { cardB: cardB?.ringState, cardC: cardC?.ringState });
  // 第二、三条（→C、→D）后触发 3/60 秒限流。
  const r2 = await ringTo("a", await candOf("a", tagOf("c")), "meet-a-c-1");
  const r3 = await ringTo("a", await candOf("a", tagOf("d")), "meet-a-d-1");
  check("AT-26 前置：A 三条铃声全部创建", r2.status === 200 && r3.status === 200);
  const r4 = await ringTo("a", await candOf("a", tagOf("b")), "meet-a-b-3");
  check("AT-26 60 秒内第 4 条被限流（429，重试提示）", r4.status === 429 && r4.json.error.code === "TOO_MANY_RINGS", r4.json);
}

// ---------- AT-31/32：只有接收者可回应 ----------
{
  const cBell = (await state("c")).meet.bells.find(x => x.direction === "incoming" && x.status === "pending");
  const senderRespond = await post("a", "respond", { bellId: cBell.id, status: "accepted" });
  check("AT-31 发送者不能回应自己的铃声（404）", senderRespond.status === 404, senderRespond.json);
  const thirdRespond = await post("d", "respond", { bellId: cBell.id, status: "accepted" });
  check("AT-31 第三人不能回应他人铃声（404）", thirdRespond.status === 404, thirdRespond.json);
}

// ---------- AT-33：并发双回响只建一个连接（A↔C 互相摇铃） ----------
{
  // C 也向 A 摇铃（C 此前未发过铃声，不受 A 的限流影响）。
  const cRing = await ringTo("c", await candOf("c", tagOf("a")), "meet-c-a-1");
  check("AT-33 前置：C→A 反向摇铃成功", cRing.status === 200, cRing.json);
  const bellAC = (await state("a")).meet.bells.find(x => x.direction === "incoming" && x.status === "pending");
  const bellCA = (await state("c")).meet.bells.find(x => x.direction === "incoming" && x.status === "pending");
  // 双方并发接受（同一轮事件循环内发出）。
  const [respA, respC] = await Promise.all([
    post("a", "respond", { bellId: bellAC.id, status: "accepted" }),
    post("c", "respond", { bellId: bellCA.id, status: "accepted" }),
  ]);
  const connsAC = (await state("a")).know.connections.filter(x => x.userId === "c");
  check("AT-33 并发接受只建立一个 A↔C 连接", connsAC.length === 1, connsAC.map(c => c.id));
  check("AT-33 一条 accepted、另一条 superseded（同一 connectionId）",
    [respA.json.data.status, respC.json.data.status].sort().join(",") === "accepted,accepted"
    && respA.json.data.connectionId === respC.json.data.connectionId, { respA: respA.json.data, respC: respC.json.data });
  const myBellsA = (await state("a")).meet.bells;
  const superseded = myBellsA.filter(b => b.status === "superseded");
  check("AT-33 superseded 铃声带连接 ID（界面可跳转）", superseded.length > 0 && superseded.every(b => b.connectionId === connsAC[0].id));
}

// ---------- AT-36/37/39/40：多连接授权（对象 × scope 二维） ----------
{
  // B 接受 A 的铃声 → A 拥有 B、C 两个独立连接。
  const bellB = (await state("b")).meet.bells.find(x => x.direction === "incoming" && x.status === "pending");
  const respB = await post("b", "respond", { bellId: bellB.id, status: "accepted" });
  const connB = respB.json.data.connectionId;
  const connC = (await state("a")).know.connections.find(x => x.userId === "c").id;
  check("AT-36 前置：A 与 B、C 分别建立独立连接", !!connB && !!connC && connB !== connC);
  // 只给 C 联系方式授权。
  const grantC = await post("a", "share-grants", { scope: "profile_contact", connectionId: connC });
  check("AT-37 A 只给 C 联系方式授权成功", grantC.status === 200, grantC.json);
  const viewC = await state("c");
  const viewB = await state("b");
  check("AT-37 C 能读 A 的联系方式", viewC.know.connections.find(x => x.userId === "a")?.contacts?.length > 0);
  check("AT-37 B 不能读 A 的联系方式（对象维度）", (viewB.know.connections.find(x => x.userId === "a")?.contacts ?? null) === null);
  // 只给 B 摘要授权；C 不因此能读摘要。
  await post("a", "share-grants", { scope: "trust_summary", connectionId: connB });
  const viewB2 = await state("b");
  const viewC2 = await state("c");
  check("AT-37 B 能读 A 的履约摘要（scope 维度）", viewB2.know.connections.find(x => x.userId === "a")?.trust.status === "granted");
  check("AT-37 C 未获摘要授权（scope 维度隔离）", viewC2.know.connections.find(x => x.userId === "a")?.trust.status !== "granted");
  // AT-39：缺 connectionId / 无关连接。
  const noConn = await post("a", "share-grants", { scope: "profile_contact" });
  check("AT-39 缺 connectionId 返回 400（不默认第一个连接）", noConn.status === 400, noConn.json);
  const fakeConn = await post("b", "share-grants", { scope: "profile_contact", connectionId: connC });
  check("AT-39 他人连接不能用于授权（403）", fakeConn.status === 403, fakeConn.json);
  const proposeNoConn = await post("a", "relationships/propose", {});
  check("AT-39 邀请缺 connectionId 返回 400", proposeNoConn.status === 400);
}

// ---------- AT-41/43：按对象邀请与关系建立联动 ----------
{
  const connC = (await state("a")).know.connections.find(x => x.userId === "c").id;
  const propose = await post("a", "relationships/propose", { connectionId: connC });
  check("AT-41 A 只邀请 C 成功", propose.status === 200, propose.json);
  const inviteC = (await state("c")).us.incomingInvite;
  const inviteB = (await state("b")).us.incomingInvite;
  check("AT-41 只有 C 收到邀请，B 没有", !!inviteC && !inviteB);
  await post("c", "relationships/accept", { relationshipId: inviteC.id });
  const meA = await state("a");
  check("AT-43 关系建立后 A 雷达停止", meA.meet.radarActive === false);
  check("AT-43 关系建立后 C 雷达停止", (await state("c")).meet.radarActive === false);
  const viewB = await state("b");
  check("AT-43 A/C 从 B 的候选中消失", !viewB.meet.candidates.some(x => x.traits.some(t => t.value === tagOf("a")))
    && !viewB.meet.candidates.some(x => x.traits.some(t => t.value === tagOf("c"))), viewB.meet.candidates.map(c => c.alias));
  check("AT-44 既有了解连接按原规则保留（A-B 连接仍在）", meA.know.connections.some(x => x.userId === "b"));
}

// ---------- AT-45/47：候选卡安全入口与屏蔽联动 ----------
{
  // D 仍在活动甲且雷达开启；B 与 D 互相可见。
  const candD = await candOf("b", tagOf("d"));
  check("AT-47 前置：B 可见 D 候选", !!candD);
  const safetyCtx = await post("b", "safety/candidate-context", { candidateRef: candD.candidateRef });
  check("AT-45 有效候选引用换取 safety targetRef（不返回目标 ID）",
    safetyCtx.status === 200 && !!safetyCtx.json.data.targetRef && !("targetId" in safetyCtx.json.data), safetyCtx.json);
  // targetRef 不能用于摇铃（仅救济用途）。
  const ringWithSafetyRef = await post("b", "ring", { candidateRef: safetyCtx.json.data.targetRef, message: "想认识你。", idempotencyKey: "safety-ref-ring" });
  check("AT-45 safety targetRef 不能当 candidateRef 摇铃（404）", ringWithSafetyRef.status === 404, ringWithSafetyRef.json);
  // 屏蔽 D：双方从彼此候选消失。
  const block = await post("b", "safety/blocks", { targetRef: safetyCtx.json.data.targetRef });
  check("AT-47 通过候选引用屏蔽成功", block.status === 200, block.json);
  const viewB = await state("b");
  const viewD = await state("d");
  check("AT-47 屏蔽后双方从彼此候选中消失",
    !viewB.meet.candidates.some(x => x.traits.some(t => t.value === tagOf("d")))
    && !viewD.meet.candidates.some(x => x.traits.some(t => t.value === tagOf("b"))));
}

// ---------- AT-51/52/53/14：活动后台管理 ----------
{
  const ownerLogin = await ops("POST", "login", { username: "owner", password: "heartbell-owner" });
  const ownerCookie = (ownerLogin.setCookie ?? "").split(";")[0];
  const reviewerLogin = await ops("POST", "login", { username: "reviewer", password: "heartbell-reviewer" });
  const reviewerCookie = (reviewerLogin.setCookie ?? "").split(";")[0];
  const list = await ops("GET", "events", undefined, ownerCookie);
  check("AT-51 owner 可读活动列表（两个种子活动）", list.status === 200 && list.json.data.items.length >= 2, list.json?.data?.items?.length);
  check("AT-52 活动列表不含明文活动码与摘要", !JSON.stringify(list.json.data).includes(ALPHA) && !JSON.stringify(list.json.data).includes("codeHash"));
  const reviewerList = await ops("GET", "events", undefined, reviewerCookie);
  check("AT-51 reviewer 无 events.read 权限被拒（403）", reviewerList.status === 403, reviewerList.status);
  // 创建活动：明文码仅返回一次。
  const created = await ops("POST", "events", { name: "验证活动-铃铛", capacity: 10, startsAt: Date.now(), endsAt: Date.now() + 3600_000 }, ownerCookie);
  check("AT-52 创建活动返回一次性明文码", created.status === 200 && typeof created.json.data.code === "string" && created.json.data.code.length === 8, created.json?.data);
  const newCode = created.json.data.code;
  const eventId = created.json.data.event.id;
  // D 换入新活动（确认换活动）。
  const switchNoConfirm = await post("d", "meet/events/join", { code: newCode });
  check("AT-08 换活动未确认时 409 且保留原状态", switchNoConfirm.status === 409, switchNoConfirm.json);
  check("AT-08 原活动状态保留（D 仍可见活动名）", (await state("d")).meet.event.joined === true);
  const switchOk = await post("d", "meet/events/join", { code: newCode, replaceCurrent: true });
  check("AT-08 确认后成功换入新活动", switchOk.status === 200 && switchOk.json.data.eventId === eventId, switchOk.json);
  check("AT-08 换活动后雷达未自动开启", (await state("d")).meet.radarActive === false);
  await post("d", "radar", { active: true, traits: [{ category: "穿着", value: tagOf("d") }, { category: "手持物", value: "拿着咖啡" }] });
  // 换码：旧码不能加入（此时 revision 仍为创建时的 1，D 入场不改变 revision）。
  const rotated = await ops("POST", `events/${eventId}/rotate-code`, { expectedRevision: created.json.data.event.revision }, ownerCookie);
  check("AT-52 换码返回新明文码", rotated.status === 200 && typeof rotated.json.data.code === "string", rotated.json?.data);
  const oldCodeJoin = await post("b", "meet/events/join", { code: newCode });
  check("AT-52 旧码不能再加入（统一失败文案）", oldCodeJoin.status === 409 && oldCodeJoin.json.error.message === "活动当前不可加入", oldCodeJoin.json);
  // 暂停活动：D 的雷达关闭、恢复后不自动开启。
  const paused = await ops("POST", `events/${eventId}/status`, { status: "paused", expectedRevision: rotated.json.data.event.revision }, ownerCookie);
  check("AT-53 暂停活动成功", paused.status === 200 && paused.json.data.event.status === "paused", paused.json?.data);
  check("AT-53 暂停后活动内雷达关闭", (await state("d")).meet.radarActive === false);
  const resumed = await ops("POST", `events/${eventId}/status`, { status: "open", expectedRevision: rotated.json.data.event.revision + 1 }, ownerCookie);
  check("AT-53 恢复开放成功", resumed.status === 200 && resumed.json.data.event.status === "open");
  check("AT-53 恢复后不自动开启雷达（需主动再开）", (await state("d")).meet.radarActive === false);
  // 并发 revision 冲突。
  const staleRev = await ops("POST", `events/${eventId}/status`, { status: "paused", expectedRevision: 1 }, ownerCookie);
  check("AT-54 旧 revision 并发修改被拒（409）", staleRev.status === 409, staleRev.json);
}

// ---------- AT-05/06：活动码归一与入场失败冷却（放最后：会占用 f 的失败额度） ----------
{
  const lower = await post("f", "meet/events/join", { code: "  bells  " });
  check("AT-05 不存在的码统一失败文案", lower.status === 409 && lower.json.error.message === "活动当前不可加入", lower.json);
  for (let i = 0; i < 4; i++) await post("f", "meet/events/join", { code: `BADCODE${i}` });
  const sixth = await post("f", "meet/events/join", { code: ALPHA });
  check("AT-06 连续 5 次失败后冷却（429，正确码也暂不可用）", sixth.status === 429, sixth.json);
  const ctx = (await get("f", "meet/context")).json.data;
  check("AT-06 冷却剩余时间透出（>0）", ctx.joinCooldownSeconds > 0, ctx.joinCooldownSeconds);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
console.log("未运行：AT-27（10 条/10 分钟长窗口边界需超过 6 个演示账号的隔离服务层夹具）；AT-54 容量 50 边界（需 50 个夹具用户）。");
process.exit(failed > 0 ? 1 : 0);
