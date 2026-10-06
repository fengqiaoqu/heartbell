// 统一 Demo 用户注册表（v2.8 / M03 MD-01）。
// 只放公开展示信息；密码与凭证仅存服务端 demo-auth.ts，浏览器代码不能包含秘密。
// 领域服务使用通用 string 用户 ID；A–F 是演示夹具，不是业务硬上限。
export interface DemoUserSeed {
  id: string;
  nickname: string;
  avatar: string;
  ageWindow: string;
  orientation: "women" | "men" | "everyone" | "other" | "not_say";
  mbti: string;
  interests: string[];
  intention: "serious" | "open" | "not_now";
  bio: string;
  contacts: { label: string; value: string }[];
  adultDeclared: boolean;
}

export const demoUserIds = ["a", "b", "c", "d", "e", "f"] as const;
export type DemoUserId = (typeof demoUserIds)[number];

export function isDemoUserId(value: unknown): value is DemoUserId {
  return typeof value === "string" && (demoUserIds as readonly string[]).includes(value);
}

export const demoUserSeeds: Record<DemoUserId, DemoUserSeed> = {
  a: {
    id: "a", nickname: "小铃", avatar: "def:coffee", ageWindow: "00后", orientation: "not_say", mbti: "INFP",
    interests: ["咖啡", "音乐", "散步"], intention: "open",
    bio: "想认识一个愿意一起慢慢走的人。",
    contacts: [{ label: "微信", value: "demo-xiaoling" }, { label: "手机号", value: "138****0001（演示）" }],
    adultDeclared: false,
  },
  b: {
    id: "b", nickname: "阿响", avatar: "def:cat", ageWindow: "95后", orientation: "men", mbti: "ISFJ",
    interests: ["猫咪", "音乐", "展览"], intention: "serious",
    bio: "慢热，但认真。想认真认识一个人。",
    contacts: [{ label: "微信", value: "demo-axiang" }, { label: "手机号", value: "139****0002（演示）" }],
    adultDeclared: false,
  },
  // v2.6 安全与隐私：第三人 C（负面权限测试 —— 始终无权读取 A/B 之间授权的内容）。
  c: {
    id: "c", nickname: "小柯", avatar: "def:star", ageWindow: "95后", orientation: "not_say", mbti: "ENTP",
    interests: ["展览", "咖啡"], intention: "open",
    bio: "演示第三人：用于验证未授权者读取被拒绝。",
    contacts: [{ label: "微信", value: "demo-xiaoke" }],
    adultDeclared: true,
  },
  // v2.8（M03）：D/E/F 加入多人相遇演示（A/B/C/D ↔ 活动甲，E/F ↔ 活动乙）。
  d: {
    id: "d", nickname: "阿丁", avatar: "def:blossom", ageWindow: "00后", orientation: "everyone", mbti: "ENFP",
    interests: ["骑行", "露营", "咖啡"], intention: "open",
    bio: "周末总在路上的演示用户 D。",
    contacts: [{ label: "微信", value: "demo-ding" }],
    adultDeclared: true,
  },
  e: {
    id: "e", nickname: "小叶", avatar: "def:starmoon", ageWindow: "95后", orientation: "women", mbti: "INFJ",
    interests: ["阅读", "电影"], intention: "serious",
    bio: "演示用户 E：另一个活动的成员。",
    contacts: [{ label: "微信", value: "demo-xiaoye" }],
    adultDeclared: true,
  },
  f: {
    id: "f", nickname: "阿枫", avatar: "def:music", ageWindow: "90后", orientation: "not_say", mbti: "ISTP",
    interests: ["摄影", "爬山"], intention: "open",
    bio: "演示用户 F：另一个活动的成员。",
    contacts: [{ label: "微信", value: "demo-afeng" }],
    adultDeclared: true,
  },
};
