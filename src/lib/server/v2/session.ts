// 演示会话：v2.6 起 viewer 由 Demo 登录会话确认（requireDemoSession），
// 此函数只做“已认证身份存在且是演示用户”的最终解析，不再单独承担认证。
import { unauthenticated } from "./errors";
import type { V2State } from "../../repositories/demo-repo";

const demoSlots = new Set(["a", "b", "c"]);
export function resolveDemoUser(state: V2State, viewer: unknown): string {
  if (typeof viewer !== "string" || !demoSlots.has(viewer)) throw unauthenticated("无效演示身份（仅支持 a/b/c 演示会话）");
  const user = state.users.get(viewer);
  if (!user) throw unauthenticated("演示用户不存在");
  if (user.disabledAt) throw unauthenticated("该账号已注销，无法继续访问业务");
  return viewer;
}

export function otherOf(userId: string, members: [string, string]): string {
  return members[0] === userId ? members[1] : members[0];
}
