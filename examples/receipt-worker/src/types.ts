export type ReceiptItem = {
  description: string;
  amount: number;
};

export type ReceiptJobPayload = {
  receiptId: string;
  customerId: string;
  items: ReceiptItem[];
  total: number;
};

export type ProcessedReceipt = {
  receiptId: string;
  customerId: string;
  total: number;
  processedAt: number;
};
