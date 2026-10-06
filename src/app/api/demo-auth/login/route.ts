// POST /api/demo-auth/login：固定 Demo 账号登录（v2.6）。
// 成功设置对应槽位 Cookie（hb_demo_a / hb_demo_b），返回 redirectTo（服务端按验证出的 userId 构造）。
import { NextResponse } from "next/server";
import { ApiError } from "../../../../lib/server/v2/errors";
import { assertSameOrigin, loginDemoUser, sessionCookieHeader } from "../../../../lib/server/demo-auth";
import { getV2State } from "../../../../lib/server/v2/registry";

export const dynamic = "force-dynamic";

const tabs = new Set(["meet", "know", "us", "future"]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { return NextResponse.json({ error: { code: "BAD_REQUEST", message: "无效 JSON", retryable: false }, requestId: crypto.randomUUID() }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "BAD_REQUEST", "请求必须为对象");
    const { viewer, sessionId, expiresAt } = loginDemoUser(body.username, body.password);
    const tab = typeof body.tab === "string" && tabs.has(body.tab) ? body.tab : "meet";
    const state = getV2State();
    const user = state.users.get(viewer);
    // v2.6：已注销账号拒绝登录（无默认兜底）。
    if (!user || user.disabledAt) throw new ApiError(401, "UNAUTHENTICATED", "该账号已注销，无法登录");
    return NextResponse.json({
      data: {
        viewer,
        username: viewer,
        nickname: user.profile.nickname ?? viewer,
        expiresAt,
        redirectTo: `/demo/${viewer}?tab=${tab}`,
      },
      requestId: crypto.randomUUID(),
    }, { headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookieHeader(viewer, sessionId) } });
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL", "服务器内部错误");
    return NextResponse.json(
      { error: { code: e.code, message: e.message, retryable: false }, requestId: crypto.randomUUID() },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
