import { getBillingSubscriptionState } from '@nextdoo/db';
import { assertWorkspaceAccess } from '../auth';
import { getDb } from '../db';
import { getBillingProviders } from '../billing';
import { getEntitlementSnapshot } from './entitlements';
import { attachmentStorageUsage } from './attachments';
export async function settingsCenterStatus(actor:{userId:string;workspaceId:string}){
  await assertWorkspaceAccess(actor.userId,actor.workspaceId);
  const providers=getBillingProviders();
  return {entitlements:await getEntitlementSnapshot(actor.userId,actor.workspaceId),subscription:await getBillingSubscriptionState(getDb(),actor.userId),storageBytes:await attachmentStorageUsage(actor.workspaceId),checkout:{stripe:providers.STRIPE?.isConfigured()??false,razorpay:providers.RAZORPAY?.isConfigured()??false}};
}
export type SettingsCenterStatus=Awaited<ReturnType<typeof settingsCenterStatus>>;
