// v2.6 Demo 登录验证脚本（对应 v2.5 交付 03-验收清单可接口化部分 L01–L28）。
// 用法：先启动 npm run dev（DEMO_URL 指向服务地址），再 node scripts/verify-demo-login.mjs
// 统一凭据：a / HeartbellA2026!；b / HeartbellB2026!
const base = process.env.DEMO_URL ?? "http://localhost:3100";
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? " — " + JSON.stringify(detail)?.slice(0, 400) : ""}`); }
}
async function req(method, path, { body, cookie, origin } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie"), location: res.headers.get("location") };
}
const cookieOf = setCookie => (setCookie ?? "").split(";")[0];

// ---------- L01：登录页 ----------
const loginPage = await fetch(`${base}/login`);
check("L01 /login 页面可访问（含标题与 Demo 说明）", loginPage.status === 200 && (await loginPage.text()).includes("欢迎回到心动铃铛"));

// ---------- L04/L05：凭据校验 ----------
let r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "wrong" } });
check("L04a 错误密码统一提示“账号或密码不正确”（401）", r.status === 401 && r.json?.error?.message === "账号或密码不正确", r.json);
r = await req("POST", "/api/demo-auth/login", { body: { username: "zzz", password: "whatever!" } });
check("L04b 未知账号同样 401（不区分不存在/密码错）", r.status === 401 && r.json?.error?.message === "账号或密码不正确", r.json);
r = await req("POST", "/api/demo-auth/login", { body: { username: "", password: "" } });
check("L04c 空字段 401（不创建会话）", r.status === 401);
r = await req("POST", "/api/demo-auth/login", { body: { username: ["a"], password: "x" } });
check("L04d 数组等错误输入被拒绝（401/400）", r.status === 401 || r.status === 400, r.status);
r = await req("POST", "/api/demo-auth/login", { body: { username: " A ", password: "HeartbellA2026!" } });
check("L05a 账号 trim + 转小写后可登录（大写 A / 带空格）", r.status === 200 && r.json?.data?.viewer === "a", r.json);
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "heartbella2026!" } });
check("L05b 密码大小写敏感（错误大小写被拒）", r.status === 401);

// ---------- L02/L03/L26：登录成功与 Cookie 属性 ----------
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!" } });
check("L02 a 登录成功，返回 viewer/nickname/redirectTo，不返回 token", r.status === 200 && r.json.data.viewer === "a" && !!r.json.data.nickname && r.json.data.redirectTo === "/demo/a?tab=meet" && !("token" in r.json.data), r.json);
const cookieHeader = r.setCookie ?? "";
check("L26 Cookie 属性：hb_demo_a / HttpOnly / SameSite=Lax / Path=/ / Max-Age=28800",
  /hb_demo_a=/.test(cookieHeader) && /HttpOnly/.test(cookieHeader) && /SameSite=Lax/.test(cookieHeader) && /Path=\//.test(cookieHeader) && /Max-Age=28800/.test(cookieHeader), cookieHeader);
const cookieA = cookieOf(cookieHeader);
r = await req("POST", "/api/demo-auth/login", { body: { username: "b", password: "HeartbellB2026!", tab: "us" } });
check("L03 b 登录成功（tab 白名单透传）", r.status === 200 && r.json.data.redirectTo === "/demo/b?tab=us", r.json);
const cookieB = cookieOf(r.setCookie ?? "");
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!", tab: "javascript:alert(1)" } });
check("L28 非法 tab 回退 meet；不跳外站", r.status === 200 && r.json.data.redirectTo === "/demo/a?tab=meet", r.json);

// ---------- L21：登录不重置业务数据 ----------
const before = await req("GET", "/api/v2/state?viewer=a", { cookie: `${cookieA}; ${cookieB}` });
const nickBefore = before.json?.data?.me?.profile?.nickname;
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!" } });
const after = await req("GET", "/api/v2/state?viewer=a", { cookie: `${cookieOf(r.setCookie)}; ${cookieB}` });
check("L21 重复登录不重置资料/业务（昵称不变）", after.status === 200 && after.json.data.me.profile.nickname === nickBefore, { nickBefore, now: after.json?.data?.me?.profile?.nickname });
const cookieA2 = cookieOf(r.setCookie);

// ---------- L09/L10/L11：槽位保护 ----------
r = await req("GET", "/api/v2/state?viewer=b", { cookie: cookieA });
check("L09a 仅持 a Cookie 请求 viewer=b 被拒（401）", r.status === 401, r.json);
r = await req("GET", "/api/demo-auth/session?viewer=b", { cookie: cookieA });
check("L09b a 的会话查 b 槽位返回 401", r.status === 401);
r = await req("GET", "/api/v2/state?viewer=a", { cookie: `hb_demo_b=${cookieA.split("=")[1]}` });
check("L10 a 的 token 放进 hb_demo_b 槽位被拒（会话身份不匹配）", r.status === 401, r.json);
r = await req("POST", "/api/v2/declare-adult", { body: { viewer: "a" }, cookie: cookieA, origin: base });
const conflict = await fetch(`${base}/api/v2/declare-adult?viewer=b`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: base },
  body: JSON.stringify({ viewer: "a" }),
});
check("L11 body.viewer=a 与 query.viewer=b 冲突返回 400", conflict.status === 400, conflict.status);

// ---------- L07/L08：未登录拒绝（业务状态不变、无 sweep 副作用） ----------
r = await req("GET", "/api/v2/state?viewer=a");
check("L07a 未登录请求 V2 state 返回 401", r.status === 401 && r.json?.error?.code === "UNAUTHENTICATED", r.json);
r = await req("POST", "/api/v2/ring", { body: { viewer: "a", message: "想认识你。" }, origin: base });
check("L07b 未登录写入被拒（401）", r.status === 401);
r = await req("GET", "/api/v2/export?recordId=whatever&viewer=a");
check("L07c 未登录证据导出被拒（401）", r.status === 401);
r = await req("GET", "/api/demo?viewer=a");
check("L08 旧 /api/demo 用户接口同样拒绝（401，无免登录通道）", r.status === 401, r.json);
r = await req("GET", "/api/demo-auth/session?viewer=g");
check("无效 viewer（g，超出 A–F 演示注册表）返回 400", r.status === 400);

// ---------- L06：未登录页面门禁 ----------
const demoPage = await fetch(`${base}/demo/a?tab=us`, { redirect: "manual" });
check("L06 未登录打开 /demo/a 重定向到对应登录页（携带栏目）", [302, 307].includes(demoPage.status) && (demoPage.headers.get("location") ?? "").startsWith("/login?account=a"), demoPage.headers.get("location"));
const demo404 = await fetch(`${base}/demo/g`);
check("非法角色 /demo/g 仍 404（A–F 为合法演示账号，g 超出注册表）", demo404.status === 404);

// ---------- L12：伪造/已撤销会话 ----------
r = await req("GET", "/api/v2/state?viewer=a", { cookie: "hb_demo_a=" + "f".repeat(64) });
check("L12a 伪造 sessionId 被拒（401）", r.status === 401);

// ---------- L14/L15/L16/L17：同浏览器双账号 + 退出 ----------
r = await req("GET", "/api/v2/state?viewer=a", { cookie: `${cookieA}; ${cookieB}` });
check("L14a 同浏览器同时登录 A/B，各自窗口读取正常", r.status === 200 && r.json.data.me.id === "a");
r = await req("GET", "/api/v2/state?viewer=b", { cookie: `${cookieA}; ${cookieB}` });
check("L14b B 窗口读取 b 身份（不串号）", r.status === 200 && r.json.data.me.id === "b");
r = await req("POST", "/api/demo-auth/logout", { body: { viewer: "a" }, cookie: `${cookieA}; ${cookieB}`, origin: base });
check("L16a 退出 a 成功（清除 hb_demo_a，不动 hb_demo_b）", r.status === 200 && /hb_demo_a=;/.test(r.setCookie ?? ""), r.setCookie);
r = await req("GET", "/api/v2/state?viewer=a", { cookie: `${cookieA}; ${cookieB}` });
check("L16b/L17 退出后旧 a 会话立即失效（服务器撤销，非仅清 Cookie）", r.status === 401);
r = await req("GET", "/api/v2/state?viewer=b", { cookie: cookieB });
check("L16c B 会话不受影响", r.status === 200);
r = await req("POST", "/api/demo-auth/logout", { body: { viewer: "a" }, cookie: `${cookieA}; ${cookieB}`, origin: base });
check("L16d 重复退出也成功", r.status === 200);
// 新登录 a 后恢复
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!" } });
const cookieA3 = cookieOf(r.setCookie);
check("退出后可用固定凭据重新登录", r.status === 200 && !!cookieA3);

// ---------- L19/L20：与维护后台互不干扰 ----------
const opsLogin = await req("POST", "/api/v2/ops/login", { body: { username: "owner", password: "heartbell-owner" }, origin: base });
const opsCookie = cookieOf(opsLogin.setCookie ?? "");
check("L19a 管理员登录不受用户会话影响", opsLogin.status === 200, opsLogin.json);
r = await req("GET", "/api/v2/ops/overview", { cookie: `${cookieA3}; ${cookieB}; ${opsCookie}` });
check("L19b 管理员会话仍可用", r.status === 200);
r = await req("GET", "/api/v2/ops/overview", { cookie: `${cookieA3}; ${cookieB}` });
check("L20 仅用户 Cookie 不能通过 ops 校验（401）", r.status === 401);
r = await req("POST", "/api/demo-auth/logout", { body: { viewer: "b" }, cookie: `${cookieA3}; ${cookieB}; ${opsCookie}`, origin: base });
check("L19c 退出用户 b 不清除 hb_ops_session", r.status === 200 && /hb_demo_b=;/.test(r.setCookie ?? "") && !/hb_ops/.test((r.setCookie ?? "").replace("hb_demo_b=;", "")), r.setCookie);
r = await req("GET", "/api/v2/ops/overview", { cookie: opsCookie });
check("L19d 退出用户后管理员会话继续可用", r.status === 200);

// ---------- L22：虚拟业务时钟不影响会话（真实时间 8h） ----------
await req("POST", "/api/v2/admin/advance-time", { body: { ms: 10 * 86_400_000 }, origin: base });
r = await req("GET", "/api/demo-auth/session?viewer=a", { cookie: cookieA3 });
check("L22 推进业务时钟 10 天后用户会话仍有效（真实时间计算）", r.status === 200, r.json);

// ---------- L27：同源 Origin 校验 ----------
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!" }, origin: "https://evil.example.com" });
check("L27a 跨站 Origin 写请求被拒绝", r.status === 403, r.json);
r = await req("POST", "/api/demo-auth/login", { body: { username: "a", password: "HeartbellA2026!" }, origin: base });
check("L27b 正确同源 Origin 成功", r.status === 200);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: Demo 登录验证 ${passed} 项通过，${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
