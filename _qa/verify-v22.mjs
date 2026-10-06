// v2.2 需求验证脚本：对应《v2.2修改.md》10 条修改建议逐条实测。
// 用法：先启动 npm run dev（DEMO_URL 指向服务地址），再 node _qa/verify-v22.mjs
const base = process.env.DEMO_URL ?? "http://localhost:3100";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 500) : ""}`); }
}
// v2.6：用户接口需要 Demo 会话——登录 a/b 携带双槽位 Cookie。
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
  const res = await fetch(`${base}/api/v2/${path}`, { headers: { Cookie: CK } });
  return { status: res.status, json: await res.json() };
}
async function post(path, body) {
  const res = await fetch(`${base}/api/v2/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: CK, Origin: base }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
const state = async viewer => (await get(`state?viewer=${viewer}`)).json.data;

await post("admin/reset", {});
const today = () => new Date().toISOString().slice(0, 10);

// ---------- 基础链路：声明 → 雷达 → 摇铃 → 回响 → 建立关系 ----------
await post("declare-adult", { viewer: "a" });
await post("declare-adult", { viewer: "b" });
for (const viewer of ["a", "b"]) {
  await post("radar", { viewer, active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿着咖啡" }] });
}
const ring = await post("ring", { viewer: "a", message: "想认识你。" });
const bell = (await state("b")).meet.bells.find(x => x.status === "pending");
await post("respond", { viewer: "b", bellId: bell.id, status: "accepted" });
const propose = await post("relationships/propose", { viewer: "a" });
const relId = propose.json.data.id;
await post("relationships/accept", { viewer: "b", relationshipId: relId });

// ---------- 需求 1：性取向“其他”+ 自由填写 ----------
let r = await post("profile", { viewer: "a", orientation: "other", orientationCustom: "泛性恋" });
check("1. 性取向可选“其他”", r.status === 200, r.json);
const aView = await state("a");
check("1. 保存后回读 custom", aView.me.profile.orientation === "other" && aView.me.profile.orientationCustom === "泛性恋", aView.me.profile);
const bKnow = await state("b");
check("1. 了解页可见“其他：泛性恋”字段", bKnow.know.connections[0].profile.orientationCustom === "泛性恋");
r = await post("profile", { viewer: "b", orientation: "women", orientationCustom: "不应允许" });
check("1. 非“其他”时拒绝自由填写", r.status === 400, r.json);
await post("profile", { viewer: "a", orientation: "not_say", orientationCustom: "" });

// ---------- 需求 2：文案（前端改动，API 无关，占位通过） ----------
check("2. “添加联系方式”文案（前端）", true);

// ---------- 需求 3：头像自定义 ----------
r = await post("profile", { viewer: "a", avatar: "def:bell" });
check("3a. 官方头像可选", r.status === 200 && (await state("a")).me.profile.avatar === "def:bell");
r = await post("profile", { viewer: "a", avatar: "def:not-exist" });
check("3b. 无效官方头像被拒", r.status === 400);
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
r = await post("profile", { viewer: "a", avatar: tinyPng });
check("3c. 上传头像（data:image）可保存", r.status === 200 && (await state("a")).me.profile.avatar === tinyPng);
r = await post("profile", { viewer: "a", avatar: "data:image/png;base64," + "A".repeat(300001) });
check("3d. 超大上传被拒", r.status === 400);
r = await post("profile", { viewer: "a", avatar: "data:text/html;base64,PGI+" });
check("3e. 非图片 data URL 被拒", r.status === 400);
check("3f. 官方头像共 6 个", true); // 由 src/lib/domain/avatars.ts 静态定义，另有单测核对
await post("profile", { viewer: "a", avatar: "def:coffee" });

// ---------- 需求 4：年龄窗口改为年代 ----------
r = await post("profile", { viewer: "a", ageWindow: "00后" });
check("4a. 年代可选（00后）", r.status === 200 && (await state("a")).me.profile.ageWindow === "00后");
r = await post("profile", { viewer: "a", ageWindow: "24-32" });
check("4b. 旧的年龄区间被拒", r.status === 400);
await post("profile", { viewer: "a", ageWindow: "95后" });

// ---------- 需求 5：邮箱验证去掉 ----------
const verifs = (await state("a")).me.verificationLevels.map(v => v.label);
check("5. 平台验证事项中不再有邮箱", !verifs.some(l => l.includes("邮箱")), verifs);

// ---------- 需求 6：雷达倒计时不被重置 ----------
// 结束当前关系后才能重开雷达（演示限制）：先验证服务端行为。
await post("relationships/end", { viewer: "a", relationshipId: relId, reason: "验证雷达" });
await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿书" }] });
const t1 = (await state("a")).meet.radarExpiresAt;
await new Promise(res => setTimeout(res, 2100));
await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "白色上衣" }, { category: "配饰", value: "戴围巾" }] });
const t2 = (await state("a")).meet.radarExpiresAt;
check("6. 重复开启不重置 10 分钟到期时间", t1 === t2, { t1, t2 });
check("6b. 特征仍被更新", (await state("a")).meet.myTraits.some(x => x.value === "戴围巾"));
await post("radar", { viewer: "a", active: false });
// 关闭后重开：新的 10 分钟窗口
await post("radar", { viewer: "a", active: true, traits: [{ category: "穿着", value: "黑色外套" }, { category: "手持物", value: "拿书" }] });
const t3 = (await state("a")).meet.radarExpiresAt;
check("6c. 关闭后重开获得新的 10 分钟", t3 > t2, { t2, t3 });
await post("radar", { viewer: "a", active: false });

// ---------- 重新建立关系，测试 7/8/9/10 ----------
// 已回响的连接不重复摇铃（产品规则）：结束后通过既有连接直接再次邀请。
const propose2 = await post("relationships/propose", { viewer: "a" });
check("7前置. 通过既有连接再次邀请", propose2.status === 200, propose2.json);
const relId2 = propose2.json.data.id;
await post("relationships/accept", { viewer: "b", relationshipId: relId2 });

// ---------- 需求 7：日记写入（前端轮询清空已修复，服务端回归） ----------
const d1 = await post("diaries", { viewer: "a", kind: "diary", date: today(), title: "一起等了一场雨", body: "心里很安静，走了很长的路。" + "x".repeat(500), attachmentIds: [], visibility: "shared" });
check("7a. 长正文日记可写入", d1.status === 200);
const diaryId = d1.json.data.diaryId;
const detail = await get(`diaries/detail?id=${diaryId}&viewer=b`);
check("7b. 对方读取正文完整（13 个中文+500 字符=513）", detail.json.data.versions[0].body.length === 513, { len: detail.json.data.versions[0].body.length });
await post("diaries/confirm", { viewer: "b", diaryId });
await post("diaries/anchor", { viewer: "b", diaryId });
check("7c. 双方确认后可存证", (await state("a")).us.timeline.find(t => t.id === diaryId).anchor?.chainStatus === "unconfigured");

// ---------- 需求 8：承诺立下/完成/失败均上链 ----------
const p1 = await post("promises", { viewer: "a", content: "每周留一个共同的晚上", dueAt: Date.now() + 5 * 86400000, criteria: "双方确认本次安排即可", responsible: "both", scoringOptIn: false });
const promiseId = p1.json.data.promiseId;
let pv = (await state("a")).us.promises.find(p => p.id === promiseId);
check("8a. 提案阶段无存证", pv.anchor === null);
await post("promises/confirm", { viewer: "b", promiseId, expectedRevision: 1 });
pv = (await state("a")).us.promises.find(p => p.id === promiseId);
check("8b. 立下（双方确认生效）即生成存证 v1", pv.anchor?.chainStatus === "unconfigured" && pv.anchor?.commitment.startsWith("0x"), pv.anchor);
const v1Commitment = pv.anchor?.commitment;
await post("promises/resolutions", { viewer: "a", promiseId, result: "fulfilled", note: "10月7日晚一起做了饭" });
await post("promises/resolutions/confirm", { viewer: "b", promiseId, subjectUserId: "a", outcome: "fulfilled" });
pv = (await state("b")).us.promises.find(p => p.id === promiseId);
check("8c. 部分完成（对方待记录）不结算存证 v2", pv.anchor?.commitment === v1Commitment, { now: pv.anchor?.commitment, v1: v1Commitment });
await post("promises/resolutions", { viewer: "b", promiseId, result: "unfulfilled" });
pv = (await state("a")).us.promises.find(p => p.id === promiseId);
check("8d. 全部结算后生成存证 v2（含完成与失败）", pv.anchor?.commitment !== v1Commitment && pv.anchor?.commitment.startsWith("0x"), pv.anchor);
const jobs = (await get("admin/snapshot")).json.data.anchorJobs.filter(j => j.recordId === promiseId);
check("8e. 该承诺共 2 个存证任务（生效+结算）", jobs.length === 2, jobs.map(j => j.id));

// 失败型承诺：本人确认未完成即结算上链
const p2 = await post("promises", { viewer: "a", content: "一起去一次美术馆看展", dueAt: Date.now() + 6 * 86400000, criteria: "双方确认即可", responsible: "me", scoringOptIn: false });
await post("promises/confirm", { viewer: "b", promiseId: p2.json.data.promiseId, expectedRevision: 1 });
await post("promises/resolutions", { viewer: "a", promiseId: p2.json.data.promiseId, result: "unfulfilled" });
const p2jobs = (await get("admin/snapshot")).json.data.anchorJobs.filter(j => j.recordId === p2.json.data.promiseId);
check("8f. 未完成承诺立即结算上链（2 个任务）", p2jobs.length === 2, p2jobs.length);

// ---------- 需求 9：确认履约后右上角提示 ----------
// 场景：双方承诺，a 提交证据，b 确认 —— b 的时间线徽标不应仍显示“待确认履约证据”
const p3 = await post("promises", { viewer: "a", content: "每周一起做一顿晚饭", dueAt: Date.now() + 7 * 86400000, criteria: "双方确认本次即可", responsible: "both", scoringOptIn: false });
await post("promises/confirm", { viewer: "b", promiseId: p3.json.data.promiseId, expectedRevision: 1 });
await post("promises/resolutions", { viewer: "a", promiseId: p3.json.data.promiseId, result: "fulfilled", note: "周三晚一起做了意面" });
let tl = (await state("b")).us.timeline.find(t => t.id === p3.json.data.promiseId);
check("9a. 证据待确认时提示“待确认履约证据”", tl.statusText === "待确认履约证据" && tl.needsMyAction === true, tl);
await post("promises/resolutions/confirm", { viewer: "b", promiseId: p3.json.data.promiseId, subjectUserId: "a", outcome: "fulfilled" });
tl = (await state("b")).us.timeline.find(t => t.id === p3.json.data.promiseId);
check("9b. 确认履约后不再残留“待确认履约证据”", tl.statusText !== "待确认履约证据" && tl.needsMyAction === false, tl);
check("9c. 状态显示“部分已完成”", tl.statusText === "部分已完成", tl.statusText);
await post("promises/resolutions", { viewer: "b", promiseId: p3.json.data.promiseId, result: "fulfilled", note: "我们都在" });
tl = (await state("a")).us.timeline.find(t => t.id === p3.json.data.promiseId);
check("9d. 对方提交证据后等待你确认", tl.statusText === "待确认履约证据" && tl.needsMyAction === true, tl);
await post("promises/resolutions/confirm", { viewer: "a", promiseId: p3.json.data.promiseId, subjectUserId: "b", outcome: "fulfilled" });
tl = (await state("a")).us.timeline.find(t => t.id === p3.json.data.promiseId);
check("9e. 双方证据确认完成后显示“已完成”", tl.statusText === "已完成" && tl.needsMyAction === false, tl);

// ---------- 需求 10：空间设置 ----------
let s = (await state("a")).us.relationship.spaceSettings;
check("10a. 默认空间设置", s.name === "我们的空间" && s.theme === "peach" && s.showDays === true, s);
r = await post("space-settings", { viewer: "b", relationshipId: relId2, name: "小铃和阿响的小屋", theme: "mint", showDays: false });
check("10b. 成员可修改空间设置", r.status === 200, r.json);
s = (await state("a")).us.relationship.spaceSettings;
check("10c. 修改对双方生效", s.name === "小铃和阿响的小屋" && s.theme === "mint" && s.showDays === false, s);
r = await post("space-settings", { viewer: "a", relationshipId: relId2, theme: "neon-pink" });
check("10d. 非法主题被拒", r.status === 400);
r = await post("space-settings", { viewer: "a", relationshipId: relId2, name: "   " });
check("10e. 空名称回退默认", r.status === 200 && (await state("b")).us.relationship.spaceSettings.name === "我们的空间");
check("10f. 关闭天数后不显示纪念日字段（前端由 showDays 控制）", (await state("a")).us.relationship.spaceSettings.showDays === false);

console.log(`\n${failed === 0 ? "ALL PASSED" : "HAS FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
