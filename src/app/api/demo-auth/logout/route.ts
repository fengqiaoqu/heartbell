// POST /api/demo-auth/logout：撤销对应槽位会话并清除该账号 Cookie（v2.6）。
// 只影响请求的槽位：退出 a 不影响 hb_demo_b 或 hb_ops_session；重复退出也成功。
import { NextResponse } from "next/server";
import { ApiError, badRequest } from "../../../../lib/server/v2/errors";
import { assertSameOrigin, clearedCookieHeader, isDemoViewer, logoutDemoViewer } from "../../../../lib/server/demo-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { body = {}; }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("请求必须为对象");
    const viewer = body.viewer;
    if (!isDemoViewer(viewer)) throw badRequest("viewer 仅支持 a/b");
    logoutDemoViewer(request.headers.get("cookie"), viewer);
    return NextResponse.json(
      { data: { ok: true, viewer }, requestId: crypto.randomUUID() },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": clearedCookieHeader(viewer) } },
    );
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL", "服务器内部错误");
    return NextResponse.json(
      { error: { code: e.code, message: e.message, retryable: false }, requestId: crypto.randomUUID() },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
