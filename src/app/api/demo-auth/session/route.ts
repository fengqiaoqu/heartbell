// GET /api/demo-auth/session?viewer=a|b：校验该槽位会话并返回摘要（v2.6）。
// 未登录 / 过期 / 撤销 / 槽位不匹配统一 401；无效 viewer 400；非 demo 模式 403。
import { NextResponse } from "next/server";
import { ApiError, badRequest, unauthenticated } from "../../../../lib/server/v2/errors";
import { isDemoViewer, resolveSlotFromCookieHeader, sessionSummary } from "../../../../lib/server/demo-auth";
import { getV2State } from "../../../../lib/server/v2/registry";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const viewer = new URL(request.url).searchParams.get("viewer");
    if (!isDemoViewer(viewer)) throw badRequest("viewer 仅支持 a/b");
    const session = resolveSlotFromCookieHeader(request.headers.get("cookie"), viewer);
    if (!session) throw unauthenticated("该账号未登录或会话已失效");
    const state = getV2State();
    const user = state.users.get(viewer);
    if (!user) throw unauthenticated("演示用户不存在");
    return NextResponse.json(
      { data: sessionSummary(session, user.profile.nickname), requestId: crypto.randomUUID() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const e = error instanceof ApiError ? error : new ApiError(500, "INTERNAL", "服务器内部错误");
    return NextResponse.json(
      { error: { code: e.code, message: e.message, retryable: false }, requestId: crypto.randomUUID() },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
