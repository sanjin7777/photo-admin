/** 领域路由统一挂载点；app.ts 只需调用一次。 */
import type { Express } from 'express';
import { mountMemberships } from './memberships.module';
import { mountEvents } from './events.module';
import { mountScenes } from './scenes.module';
import { mountRegistrations } from './registrations.module';
import { mountBalance } from './balance.module';
import { mountVotes } from './votes.module';
import { mountAdmin } from './admin.module';
import { mountMemberImport } from './member-import';
import { mountUploads } from './uploads';
import { mountInviteCodes } from './invite-codes';
import { mountCoupons } from './coupons.module';
import { mountConsents } from './consents.module';
import { mountPosterSettings, mountPublicSettings } from './settings';

export function mountDomainRoutes(app: Express): void {
  mountMemberships(app);
  mountEvents(app);
  mountScenes(app);
  mountRegistrations(app);
  mountBalance(app);
  mountVotes(app);
  mountAdmin(app);
  mountMemberImport(app);
  mountUploads(app);
  mountInviteCodes(app);
  mountCoupons(app);
  mountConsents(app);
  mountPosterSettings(app);
  mountPublicSettings(app);
}
