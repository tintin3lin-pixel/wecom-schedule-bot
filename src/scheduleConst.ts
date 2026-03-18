export const TEAM_MEMBERS = ["仪征", "CZ", "Free", "翔哥", "柏总", "博文", "Viola"] as const;
export type TeamMember = (typeof TEAM_MEMBERS)[number];

export const EVENT_TYPES = ["聊新项目", "见投资人", "服务老项目", "内部会议", "项目路演", "其他"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// 企业微信用户ID → 成员名字映射表
// 请将企业微信后台的用户ID填入对应成员名字
export const WECOM_USER_MAP: Record<string, string> = {
  "LinYiZheng": "仪征",
  // 其他成员请在企业微信管理后台通讯录查看 UserID 后填入：
  // "ZhangXiang": "翔哥",
  // "BoCZ": "CZ",
  // "FreeXX": "Free",
  // "BaiZong": "柏总",
  // "BoWen": "博文",
  // "Viola": "Viola",
};

export function getMemberNameByWeComId(wecomUserId: string): string | null {
  return WECOM_USER_MAP[wecomUserId] || null;
}
