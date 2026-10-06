// 官方默认头像（v2.2 需求 3）：6 枚与品牌视觉一致的内置头像，另支持自由上传。
// avatar 值的三种形态（服务端与客户端共用同一判定）：
//   "def:xxx"  —— 官方头像 id
//   "data:image/..." —— 用户上传的本地图片（压缩后 base64，仅存演示内存仓库）
//   其它短字符串 —— 历史表情符号（兼容 v2.1 既有档案）

export interface OfficialAvatar {
  id: string;          // 存档值使用 "def:" + id
  label: string;
  svg: string;         // 48x48 viewBox 品牌风格插图
}

// 品牌色：主色 #B94360 / 深色 #93324B / 浅底 #FBE8ED（globals.css 视觉规格）。
export const officialAvatars: OfficialAvatar[] = [
  {
    id: "bell", label: "心动铃铛",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><path d="M33 21a9 9 0 0 0-18 0c0 10-4.5 10.5-4.5 13.5h27C37.5 31.5 33 31 33 21Z" fill="#B94360"/><path d="M20.5 38.5a3.6 3.6 0 0 0 7 0Z" fill="#93324B"/><circle cx="24" cy="10.5" r="2.4" fill="#93324B"/><path d="M17 27c.4 3.4-1.2 5.6-2.6 6.6" stroke="#F8DCE5" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M31 27c-.4 3.4 1.2 5.6 2.6 6.6" stroke="#F8DCE5" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M21 16.5c.6-1.6 1.8-2.6 3-3" stroke="#fff" stroke-opacity=".65" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  },
  {
    id: "blossom", label: "晚樱",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><g fill="#B94360"><path d="M24 9c2.6 3.8 2.6 8.2 0 11.4-2.6-3.2-2.6-7.6 0-11.4Z"/><path d="M36.5 18.5c-1.2 4.5-4.6 7.3-8.7 7.6.9-4.4 4.2-7.2 8.7-7.6Z"/><path d="M11.5 18.5c1.2 4.5 4.6 7.3 8.7 7.6-.9-4.4-4.2-7.2-8.7-7.6Z"/><path d="M31.2 33.6c-3.9 1.6-7.9.5-10-2.4 3.6-1.6 7.8-.8 10 2.4Z"/><path d="M16.8 33.6c3.9 1.6 7.9.5 10-2.4-3.6-1.6-7.8-.8-10 2.4Z"/></g><circle cx="24" cy="23.4" r="2.6" fill="#93324B"/><circle cx="20.2" cy="21" r="1" fill="#93324B"/><circle cx="27.8" cy="21" r="1" fill="#93324B"/><circle cx="21.6" cy="26.8" r="1" fill="#93324B"/><circle cx="26.4" cy="26.8" r="1" fill="#93324B"/></svg>`,
  },
  {
    id: "coffee", label: "咖啡",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><path d="M12 20h22v9a8 8 0 0 1-8 8h-6a8 8 0 0 1-8-8v-9Z" fill="#B94360"/><path d="M34 22h2.6a4.2 4.2 0 0 1 0 8.4H34" stroke="#B94360" stroke-width="2.4" fill="none"/><path d="M15 23.5c3.5 0 5.5-1.5 9-1.5M15 28c3.5 0 5.5-1.5 9-1.5" stroke="#FBE8ED" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M20 14c-1.2-1.8-.4-3.4 1-4.4 1.6 1.2 1.8 3 .6 4.6" stroke="#93324B" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M26 12.5c-1-1.5-.3-2.9 1-3.8 1.4 1 1.5 2.6.5 3.9" stroke="#93324B" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`,
  },
  {
    id: "cat", label: "奶猫",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><path d="M13 20.5 12.5 12l7 4.2a15 15 0 0 1 9 0l7-4.2-.5 8.5c1.2 1.9 1.9 4 1.9 6.2 0 6.3-5.6 10.3-11.9 10.3S12.6 33 12.6 26.7c0-2.2.2-4.2 1.4-6.2Z" fill="#B94360"/><path d="m14.2 13.4 4.2 2.5M33.8 13.4l-4.2 2.5" stroke="#93324B" stroke-width="1.5" stroke-linecap="round"/><circle cx="19.4" cy="25.4" r="1.7" fill="#352B30"/><circle cx="28.6" cy="25.4" r="1.7" fill="#352B30"/><path d="M24 28.6c-1 1.4-2.6 1.2-3.2 0M24 28.6c1 1.4 2.6 1.2 3.2 0" stroke="#352B30" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M21.6 32.4c1.5 1.1 3.3 1.1 4.8 0" stroke="#93324B" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M17.2 22.2c.8-1 2.2-1.1 3-.3M27.8 22.2c.8-1 2.2-1.1 3-.3" stroke="#fff" stroke-opacity=".7" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
  },
  {
    id: "starmoon", label: "星月",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><path d="M30.8 10.5a13.5 13.5 0 1 0 6.7 17.8 11 11 0 0 1-6.7-17.8Z" fill="#B94360"/><path d="M18 16.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L18 25.2l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5L18 16.5Z" fill="#93324B"/><circle cx="34.5" cy="15" r="1.4" fill="#93324B"/><circle cx="38.5" cy="21" r="1" fill="#93324B"/><circle cx="31" cy="9.5" r="1" fill="#93324B"/></svg>`,
  },
  {
    id: "music", label: "音符",
    svg: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="23" fill="#FBE8ED"/><path d="M19 32.5V16l14-3v16.5" stroke="#B94360" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="15.6" cy="33" rx="3.9" ry="3.1" fill="#B94360"/><ellipse cx="29.6" cy="30" rx="3.9" ry="3.1" fill="#B94360"/><path d="M19 20.5c3-1.6 8.5-2.3 14-2" stroke="#93324B" stroke-width="1.7" fill="none" stroke-linecap="round" opacity=".8"/><path d="M22 15.5c2.5-1.3 6.6-1.9 10.8-1.6" stroke="#F8DCE5" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`,
  },
];

export const defaultAvatarIds = officialAvatars.map(a => `def:${a.id}`);

export type AvatarKind = "official" | "image" | "emoji";

export function avatarKind(avatar: string | null | undefined): AvatarKind {
  if (!avatar) return "emoji";
  if (avatar.startsWith("def:")) return "official";
  if (avatar.startsWith("data:image/")) return "image";
  return "emoji";
}

export function officialAvatarOf(avatar: string): OfficialAvatar | null {
  if (!avatar.startsWith("def:")) return null;
  return officialAvatars.find(a => a.id === avatar.slice(4)) ?? null;
}

// 上传头像上限：base64 长度 ≤ 300000（约 220KB 原始数据，客户端压缩到远小于此值）。
export const MAX_UPLOAD_AVATAR_LENGTH = 300_000;
