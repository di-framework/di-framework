export interface ReservationItem {
  sku: string;
  quantity: number;
}

export interface ReservationResult {
  reservationId: string;
  items: ReservationItem[];
  expiresAt: number;
}

export interface ReleaseResult {
  released: boolean;
  reservationId: string;
}

export interface InventoryContract {
  reserve(items: ReservationItem[]): Promise<ReservationResult>;
  release(reservationId: string): Promise<ReleaseResult>;
  checkStock(sku: string): Promise<number>;
}
