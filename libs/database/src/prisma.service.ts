import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // Runs after every onModuleDestroy hook, so consumers have drained before the pool closes.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
