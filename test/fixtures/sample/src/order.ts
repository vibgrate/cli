import { double } from './math';

export interface Entity { id: string; }

export class OrderService {
  total = 0;
  addItem(price: number): void {
    this.total = double(price);
  }
  deleteAsync(id: string): void {
    this.addItem(0);
  }
}

export class PaidOrderService extends OrderService {
  pay(): void { this.addItem(1); }
}
