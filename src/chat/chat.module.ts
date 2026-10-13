import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersClient } from '../common/clients/index.js';
import { ChatService } from './chat.service.js';
import { ChatResolver } from './chat.resolver.js';
import { ChatAdminService } from './chat-admin.service.js';
import { ChatAdminResolver } from './chat-admin.resolver.js';

/**
 * Chat between buyers and sellers (TRX-18): conversations about a product,
 * store product or service, with contact details masked until the two have
 * traded (TRX-19). New-message notices go out through UsersClient (USR-13).
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ChatService,
    ChatResolver,
    ChatAdminService,
    ChatAdminResolver,
    UsersClient,
  ],
  exports: [ChatService],
})
export class ChatModule {}
