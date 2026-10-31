import { Injectable } from '@nestjs/common';
import { OrderStatus, type Prisma } from '@prisma/client';
import { isUniqueViolation, PrismaService } from '@app/database';

export interface MessageReceipt {
  consumer: string;
  messageId: string;
}

export interface PayableOrder {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
}

/**
 * - `settled`: this call moved the order out of PENDING.
 * - `already-settled`: the order had already left PENDING; nothing changed.
 * - `duplicate`: this message was already processed; nothing changed.
 */
export type SettlementOutcome = 'settled' | 'already-settled' | 'duplicate';

@Injectable()
export class OrderSettlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  async isProcessed(receipt: MessageReceipt): Promise<boolean> {
    const row = await this.prisma.processedMessage.findUnique({
      where: { consumer_messageId: receipt },
      select: { messageId: true },
    });
    return row !== null;
  }

  findPayableOrder(orderId: string): Promise<PayableOrder | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, totalCents: true, currency: true },
    });
  }

  markPaid(
    orderId: string,
    paymentReference: string,
    receipt?: MessageReceipt,
  ): Promise<SettlementOutcome> {
    return this.settle(orderId, receipt, async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.PAID, paymentReference },
      });
      return count === 1;
    });
  }

  /** Marks the order FAILED and puts its reserved stock back, exactly once. */
  markFailed(
    orderId: string,
    failureReason: string,
    receipt?: MessageReceipt,
  ): Promise<SettlementOutcome> {
    return this.settle(orderId, receipt, async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.FAILED, failureReason },
      });
      if (count === 0) {
        return false;
      }
      const items = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { productId: 'asc' },
        select: { productId: true, quantity: true },
      });
      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }
      return true;
    });
  }

  /**
   * The receipt row and the status change commit together. The conditional
   * `status = PENDING` update makes the transition happen at most once even
   * without a receipt; the receipt additionally stops a redelivered message
   * from being handled again.
   */
  private async settle(
    orderId: string,
    receipt: MessageReceipt | undefined,
    transition: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ): Promise<SettlementOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (receipt) {
          await tx.processedMessage.create({ data: receipt });
        }
        return (await transition(tx)) ? 'settled' : 'already-settled';
      });
    } catch (error) {
      if (receipt && isUniqueViolation(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
