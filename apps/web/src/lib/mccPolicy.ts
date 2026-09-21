export const MCC_POLICY = {
  executiveUiMode: "READ_ONLY_PREVIEW",
  externalCommunication: "MANUAL_SEND_ONLY",
  automationMode: "PREPARE_ONLY",
  truthMode: "FAIL_CLOSED",
} as const;

export type MccPolicy = typeof MCC_POLICY;
