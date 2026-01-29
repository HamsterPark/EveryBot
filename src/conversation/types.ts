export type ConvMeta = {
  convId: string;
  agentId: string;
  nextMsgNo: number;
  createdAt: string;
  updatedAt: string;
};

export type ThreadItem = {
  role: "user" | "bot";
  text: string;
  at: string;
  msgNo?: number;
  agentId?: string;
  emailId?: string;
};
