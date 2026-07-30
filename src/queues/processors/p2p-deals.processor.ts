import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { MarketplaceDealsService } from '../../marketplace-deals/marketplace-deals.service.js';

/** Queue that drives the periodic P2P-deal deadline sweep. */
export const P2P_DEALS_QUEUE = 'p2p-deals';
const SWEEP_JOB = 'sweep-deals';

/**
 * Runs the P2P deadline sweep on a repeatable schedule: overdue ACCEPTED deals
 * are expired, the non-confirming party is struck, and reservations released.
 * The repeatable job is (re)registered on boot with a fixed `jobId` so redeploys
 * don't stack duplicates.
 */
@Processor(P2P_DEALS_QUEUE)
export class P2pDealsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(P2pDealsProcessor.name);

  constructor(
    private readonly deals: MarketplaceDealsService,
    private readonly config: ConfigService,
    @InjectQueue(P2P_DEALS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const everyMin = this.config.get<number>('p2p.sweepEveryMin', 15);
    await this.queue.add(
      SWEEP_JOB,
      {},
      {
        repeat: { every: everyMin * 60_000 },
        jobId: 'p2p-sweep', // stable id → one schedule, survives redeploys
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log(`P2P deal sweep scheduled every ${everyMin} min`);
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === SWEEP_JOB) {
      return this.deals.sweepExpiredDeals();
    }
    this.logger.warn(`Unknown p2p-deals job: ${job.name}`);
    return null;
  }
}
