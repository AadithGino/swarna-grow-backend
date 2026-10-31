import { listCustomerOpenOrdersSummary } from "../src/services/digital-metals-customer-orders.service.js";
import { getAdminPaymentExceptionRefund, recordAdminPaymentExceptionRefundManual } from '../src/services/ecommerce-payment-exception-refund.service.js';
import { confirmDigitalMetalPaymentExceptionRefundFromProvider } from '../src/services/digital-metals-payment-exception.service.js';
import { recordPayoutSettlement } from '../src/services/digital-metals-payout.service.js';
// Permanent regression cases for the 2026-10-30 production remediation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createId } from '../src/lib/ids.js';
import { withTransaction } from '../src/lib/transaction.js';
import { seal } from '../src/lib/crypto.js';
import { signAccessToken } from '../src/services/token.service.js';
import { Permission } from '../src/constants/permissions.js';
import { TenantRole } from '../src/constants/enums.js';
import * as M from '../src/models/index.js';
import { resetTestDb, seedTenantUser, seedCustomer, seedBranch, bearerFor } from '../tests/helpers/db.js';
import { makeTenantQuoteReady } from '../tests/helpers/digital-metals-live-ready.js';
import { creditWalletForTest } from '../src/services/digital-metals-ledger.service.js';
import { finalizeDigitalMetalBuyPaymentSuccess } from '../src/services/digital-metals-buy-finalize.service.js';
import { finalizeEcommercePaymentSuccess } from '../src/services/ecommerce-payment-finalize.service.js';
import { createPayoutInstruction } from '../src/services/digital-metals-payout.service.js';
import { finalizeDigitalMetalRedemptionChargeSuccess } from '../src/services/digital-metals-redemption-charge-finalize.service.js';
import { runDigitalMetalBuyPaymentReconcile } from '../src/services/digital-metals-payment-reconcile.service.js';
import { initiateDigitalMetalBuyPaymentAttempt } from '../src/services/digital-metals-buy-payment.service.js';
import { phonePeProvider } from '../src/integrations/phonepe.provider.js';
import { processWebhook } from '../src/workers/processors.js';

const app=createApp();
test.beforeEach(async()=>{await resetTestDb();process.env.ECOMMERCE_PAYMENTS_TEST_HARNESS='true'});
const idem=()=>randomUUID();
async function ready(){
 const ctx=await seedTenantUser();
 await M.Tenant.updateOne({_id:ctx.tenant._id},{$set:{'subscription.planFeaturesSnapshot.digitalMetals':true,'subscription.tier':'GROWTH','operations.digitalMetalsEnabled':true}});
 ctx.customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});
 const session=await M.Session.create({_id:createId('session'),tenantId:ctx.tenant._id,customerId:ctx.customer._id,deviceId:'audit',familyId:createId('family'),refreshTokenHash:idem(),platform:'web',expiresAt:new Date(Date.now()+86400000)});
 ctx.token=signAccessToken({id:ctx.customer._id,type:'CUSTOMER',tenantId:ctx.tenant._id,branchId:ctx.branch._id,role:'CUSTOMER',permissions:[],deviceId:'audit',sessionId:session._id});
 await makeTenantQuoteReady(app,ctx.tenant._id,bearerFor(ctx.user));return ctx;
}
function pauseTwoReads(model,method,predicate){
 const original=model[method];let arrived=0;let release;const gate=new Promise(r=>release=r);
 model[method]=function(filter,...args){const q=original.call(this,filter,...args);if(predicate(filter)){const lean=q.lean.bind(q);q.lean=async(...a)=>{const row=await lean(...a);arrived++;if(arrived===2)release();await Promise.race([gate,new Promise((_,r)=>setTimeout(()=>r(new Error('audit barrier timed out')),15000))]);return row;};}return q;};
 return()=>{model[method]=original;release();};
}

test('DM credited buy: a different successful attempt must open a refund case',async()=>{
 const {tenant,customer}=await ready();const orderId=createId('dmbo');const winner=createId('dmbpay');const extra=createId('dmbpay');
 await M.DigitalMetalBuyOrder.create({_id:orderId,tenantId:tenant._id,customerId:customer._id,quoteId:createId('dmq'),status:'CREDITED',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,totalPayablePaise:600000,quoteExpiresAt:new Date(Date.now()+600000),paymentAcceptanceExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem(),successfulPaymentAttemptId:winner});
 await M.DigitalMetalBuyPaymentAttempt.create({_id:extra,tenantId:tenant._id,customerId:customer._id,orderId,status:'INITIATED',amountPaise:600000,currency:'INR',merchantOrderId:extra,idempotencyKey:idem()});
 const result=await finalizeDigitalMetalBuyPaymentSuccess({tenantId:tenant._id,merchantOrderId:extra,transactionId:idem(),amountPaise:600000});
 const fresh=await M.DigitalMetalBuyOrder.findById(orderId).lean();const attempt=await M.DigitalMetalBuyPaymentAttempt.findById(extra).lean();
 console.log('AUDIT_DM_DUPLICATE',JSON.stringify({outcome:result.outcome,extraAttemptStatus:attempt.status,exception:fresh.paymentExceptionStatus}));
 assert.equal(fresh.paymentExceptionStatus,'DUPLICATE_PAYMENT_REFUND_REQUIRED');
});

test('Ecommerce processing order: a second captured payment must be recorded for refund',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('eo');const extra=createId('epay');
 await M.EcommerceOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,orderNumber:'AUDIT-ORDER',status:'PROCESSING',totalPaise:50000,successfulPaymentAttemptId:createId('epay'),creationBodyHash:'audit',idempotencyKey:idem(),fulfilmentMode:'DELIVERY'});
 await M.EcommercePaymentAttempt.create({_id:extra,tenantId:ctx.tenant._id,customerId:customer._id,orderId:id,status:'INITIATED',amountPaise:50000,currency:'INR',merchantOrderId:extra,idempotencyKey:idem(),redirectUrl:'https://example.com/return'});
 const result=await finalizeEcommercePaymentSuccess({tenantId:ctx.tenant._id,merchantOrderId:extra,transactionId:idem(),amountPaise:50000});
 const fresh=await M.EcommerceOrder.findById(id).lean();const attempt=await M.EcommercePaymentAttempt.findById(extra).lean();
 console.log('AUDIT_ECOM_PROCESSING_DUPLICATE',JSON.stringify({outcome:result.outcome,attempt:attempt.status,exception:fresh.paymentExceptionStatus}));
 assert.equal(fresh.paymentExceptionStatus,'DUPLICATE_PAYMENT_REFUND_REQUIRED');
});

test('DM redemption: accepting one quote concurrently must create only one order',async()=>{
 const ctx=await ready();await withTransaction(s=>creditWalletForTest(s,{tenantId:ctx.tenant._id,customerId:ctx.customer._id,metal:'GOLD',finenessPpm:999000,quantityUg:10000000,idempotencyKey:idem()}));
 const item=await M.DigitalMetalRedemptionCatalogItem.create({_id:createId('dmrci'),tenantId:ctx.tenant._id,sku:'AUDIT-COIN',label:'2g coin',metal:'GOLD',finenessPpm:999000,unitQuantityUg:2000000,mintingRule:{type:'FLAT_INR',amountPaise:50000},pickupEnabled:true,deliveryEnabled:false,active:true});
 const q=await request(app).post('/api/v1/app/digital-metals/quotes/redemption').set('Authorization',`Bearer ${ctx.token}`).set('X-Idempotency-Key',idem()).send({catalogueItemId:item._id,metal:'GOLD',finenessPpm:999000,unitCount:1,fulfilmentMode:'PICKUP',pickupBranchId:ctx.branch._id});
 assert.equal(q.status,201,JSON.stringify(q.body));const quote=q.body.data;
 const restore=pauseTwoReads(M.DigitalMetalQuote,'findOne',f=>f?._id===quote.quoteId&&f.side==='REDEMPTION');
 let result;try{result=await Promise.all([1,2].map(()=>request(app).post('/api/v1/app/digital-metals/redemption/orders').set('Authorization',`Bearer ${ctx.token}`).set('X-Idempotency-Key',idem()).send({quoteId:quote.quoteId,termsVersionAccepted:quote.termsVersion,termsContentHashAccepted:quote.termsContentHash})));}finally{restore()}
 const count=await M.DigitalMetalRedemptionOrder.countDocuments({quoteId:quote.quoteId});const wallet=await M.DigitalMetalWallet.findOne({tenantId:ctx.tenant._id,customerId:ctx.customer._id}).lean();
 console.log('AUDIT_REDEMPTION_QUOTE_RACE',JSON.stringify({statuses:result.map(r=>r.status),orders:count,reservedUg:wallet.reservedUg}));assert.equal(count,1);
});

test('DM branch manager: payout approval for another branch must be denied',async()=>{
 const ctx=await seedTenantUser({role:TenantRole.BRANCH_MANAGER});const other=await seedBranch({tenantId:ctx.tenant._id});const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:other._id});await M.Tenant.updateOne({_id:ctx.tenant._id},{$set:{'subscription.planFeaturesSnapshot.digitalMetals':true,'subscription.tier':'GROWTH','operations.digitalMetalsEnabled':true}});
 const payable=await M.DigitalMetalPayable.create({_id:createId('dmpaybl'),tenantId:ctx.tenant._id,customerId:customer._id,sellOrderId:createId('dmso'),amountPaise:50000,outstandingPaise:50000,status:'OPEN'});
 const payout=await M.DigitalMetalPayout.create({_id:createId('dmpos'),tenantId:ctx.tenant._id,payableId:payable._id,sellOrderId:payable.sellOrderId,customerId:customer._id,amountPaise:50000,status:'PENDING_APPROVAL',makerUserId:createId('user'),idempotencyKey:idem()});
 const token=bearerFor(ctx.user,[Permission.DIGITAL_METALS_READ,Permission.DIGITAL_METALS_PAYOUT_APPROVE]);
 const denied=await request(app).get(`/api/v1/admin/digital-metals/payouts/${payout._id}`).set('Authorization',`Bearer ${token}`);
 const approve=await request(app).post(`/api/v1/admin/digital-metals/payouts/${payout._id}/approve`).set('Authorization',`Bearer ${token}`).set('X-Idempotency-Key',idem()).send({});
 await M.DigitalMetalPayout.updateOne({_id:payout._id},{$set:{status:'SUBMITTED'}});
 const markUnknown=await request(app).post(`/api/v1/admin/digital-metals/payouts/${payout._id}/mark-unknown`).set('Authorization',`Bearer ${bearerFor(ctx.user)}`).set('X-Idempotency-Key',idem()).send({});
 console.log('AUDIT_BRANCH_PAYOUT',JSON.stringify({readStatus:denied.status,approveWithGrantStatus:approve.status,markUnknownWithDefaultPermissionsStatus:markUnknown.status,storedStatus:(await M.DigitalMetalPayout.findById(payout._id).lean()).status}));assert.equal(markUnknown.status,403);assert.equal(approve.status,403);
});

test('DM payout: concurrent instructions must not exceed one payable',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const destination=await M.DigitalMetalBankDestination.create({_id:createId('dmbd'),tenantId:ctx.tenant._id,customerId:customer._id,accountHolderName:'Audit',accountNumberSealed:seal('123456789012'),accountLast4:'9012',ifsc:'HDFC0001234',status:'ACTIVE',verifiedAt:new Date()});
 const sell=await M.DigitalMetalSellOrder.create({_id:createId('dmso'),tenantId:ctx.tenant._id,customerId:customer._id,branchId:ctx.branch._id,quoteId:createId('dmq'),reservationId:createId('dmres'),bankDestinationId:destination._id,status:'PAYABLE_OPEN',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,settlementPaise:50000,quoteExpiresAt:new Date(Date.now()+60000),termsAcceptedAt:new Date(),idempotencyKey:idem()});
 const payable=await M.DigitalMetalPayable.create({_id:createId('dmpaybl'),tenantId:ctx.tenant._id,customerId:customer._id,sellOrderId:sell._id,amountPaise:50000,outstandingPaise:50000,status:'OPEN'});
 const restore=pauseTwoReads(M.DigitalMetalPayout,'find',f=>f?.payableId===payable._id);let result;
 try{result=await Promise.allSettled([1,2].map(()=>createPayoutInstruction({auth:{id:ctx.user._id,type:'TENANT_USER',tenantId:ctx.tenant._id,role:'TENANT_OWNER'},scope:{tenantId:ctx.tenant._id},headers:{'x-idempotency-key':idem()},body:{payableId:payable._id,amountPaise:50000}})));}finally{restore()}
 const rows=await M.DigitalMetalPayout.find({payableId:payable._id}).lean();const committed=rows.reduce((s,r)=>s+r.amountPaise,0);
 console.log('AUDIT_PAYOUT_RACE',JSON.stringify({results:result.map(r=>r.status),payablePaise:payable.amountPaise,committedPaise:committed,instructions:rows.length}));assert.ok(committed<=payable.amountPaise);
});

test('Ecommerce: every extra captured payment must retain its own refund obligation',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('eo');
 await M.EcommerceOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,orderNumber:'AUDIT-MULTI',status:'PAID',totalPaise:50000,successfulPaymentAttemptId:createId('epay'),creationBodyHash:'audit',idempotencyKey:idem(),fulfilmentMode:'DELIVERY'});
 const captures=[];
 for(let n=0;n<2;n++){
  const attemptId=createId('epay');captures.push(attemptId);
  await M.EcommercePaymentAttempt.create({_id:attemptId,tenantId:ctx.tenant._id,customerId:customer._id,orderId:id,status:'INITIATED',amountPaise:50000,currency:'INR',merchantOrderId:attemptId,idempotencyKey:idem(),redirectUrl:'https://example.com/return'});
  await finalizeEcommercePaymentSuccess({tenantId:ctx.tenant._id,merchantOrderId:attemptId,transactionId:idem(),amountPaise:50000});
 }
 const cases=await M.EcommercePaymentExceptionRefund.find({tenantId:ctx.tenant._id,orderId:id}).lean();
 console.log('AUDIT_ECOM_MULTI_CAPTURE',JSON.stringify({extraCaptures:captures.length,refundCases:cases.length,obligationPaise:cases.reduce((s,r)=>s+r.amountPaise,0),expectedPaise:100000}));assert.equal(cases.reduce((s,r)=>s+r.amountPaise,0),100000);
 const req={auth:{tenantId:ctx.tenant._id,id:ctx.user._id},params:{orderId:id},body:{},query:{}};
 await assert.rejects(recordAdminPaymentExceptionRefundManual({...req,body:{providerRefundReference:'audit-ref',reason:'Verified bank refund',evidenceNote:'Verified statement record'}}),error=>error.code==='REFUND_CASE_REQUIRED');
 for(const row of cases){
  await recordAdminPaymentExceptionRefundManual({...req,body:{refundId:row._id,providerRefundReference:idem(),reason:'Verified bank refund',evidenceNote:'Verified statement record'}});
 }
 const fresh=await M.EcommerceOrder.findById(id).lean();assert.equal(fresh.status,'PAID');assert.equal(fresh.paymentExceptionStatus,null);
 const history=await getAdminPaymentExceptionRefund(req);assert.equal(history.refunds.length,2);assert.ok(history.refunds.every(r=>r.status==='MANUAL_RECORDED'));

});

test('DM redemption: an additional charge capture must preserve completed physical fulfilment',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('dmro');const extra=createId('dmrpay');
 await M.DigitalMetalRedemptionOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,quoteId:createId('dmq'),catalogueItemId:createId('dmrci'),catalogueVersion:1,reservationId:createId('dmres'),status:'COMPLETED',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,unitCount:1,chargeTotalPaise:50000,fulfilmentMode:'PICKUP',pickupBranchId:ctx.branch._id,quoteExpiresAt:new Date(Date.now()-86400000),chargePaymentExpiresAt:new Date(Date.now()-86400000),termsAcceptedAt:new Date(),successfulChargeAttemptId:createId('dmrpay'),physicalOutEventId:createId('dmphy'),completedAt:new Date(),idempotencyKey:idem()});
 await M.DigitalMetalRedemptionPaymentAttempt.create({_id:extra,tenantId:ctx.tenant._id,customerId:customer._id,orderId:id,status:'INITIATED',amountPaise:50000,merchantOrderId:extra,idempotencyKey:idem()});
 const result=await finalizeDigitalMetalRedemptionChargeSuccess({tenantId:ctx.tenant._id,merchantOrderId:extra,transactionId:idem(),amountPaise:50000});
 const fresh=await M.DigitalMetalRedemptionOrder.findById(id).lean();console.log('AUDIT_COMPLETED_REDEMPTION_CAPTURE',JSON.stringify({outcome:result.outcome,status:fresh.status,physicalOutEventPresent:!!fresh.physicalOutEventId}));assert.equal(fresh.status,'COMPLETED');
});

test('DM uncertain initiation: reconciliation must scan a stale persisted pending attempt',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const orderId=createId('dmbo');
 await M.Tenant.updateOne({_id:ctx.tenant._id},{$set:{'integrationSecrets.phonepe':{clientId:'audit-placeholder',clientSecret:'audit-placeholder',clientVersion:1,environment:'SANDBOX'}}});
 await M.DigitalMetalBuyOrder.create({_id:orderId,tenantId:ctx.tenant._id,customerId:customer._id,quoteId:createId('dmq'),status:'QUOTE_ACCEPTED',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,totalPayablePaise:50000,quoteExpiresAt:new Date(Date.now()+600000),paymentAcceptanceExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem()});
 const original=phonePeProvider.createSdkOrder;const oldMode=process.env.DIGITAL_METALS_CHECKOUT_MODE;process.env.DIGITAL_METALS_CHECKOUT_MODE='live';let caught;
 phonePeProvider.createSdkOrder=async()=>{throw new Error('SIMULATED_PROVIDER_RESPONSE_LOST')};
 try{await initiateDigitalMetalBuyPaymentAttempt({auth:{id:customer._id,type:'CUSTOMER',tenantId:ctx.tenant._id},params:{orderId},body:{redirectUrl:'https://example.com/return'},headers:{'x-idempotency-key':idem()}})}catch(error){caught=error.code}finally{phonePeProvider.createSdkOrder=original;if(oldMode==null)delete process.env.DIGITAL_METALS_CHECKOUT_MODE;else process.env.DIGITAL_METALS_CHECKOUT_MODE=oldMode}
 assert.equal(caught,'PAYMENT_INITIATION_UNCERTAIN');const attempt=await M.DigitalMetalBuyPaymentAttempt.findOne({orderId}).lean();const id=attempt._id;
 await M.DigitalMetalBuyPaymentAttempt.collection.updateOne({_id:id},{$set:{createdAt:new Date(Date.now()-3600000),updatedAt:new Date(Date.now()-3600000)}});
 const result=await runDigitalMetalBuyPaymentReconcile();const fresh=await M.DigitalMetalBuyPaymentAttempt.findById(id).lean();
 console.log('AUDIT_UNCERTAIN_PENDING',JSON.stringify({scanned:result.scanned,status:fresh.status,failureReason:fresh.failureReason,merchantOrderId:!!fresh.merchantOrderId,providerOrderId:!!fresh.providerOrderId}));assert.ok(result.scanned>=1);
});

test('DM redemption: the webhook worker must apply a valid completed charge callback',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('dmro');const attemptId=createId('dmrpay');
 await M.DigitalMetalRedemptionOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,quoteId:createId('dmq'),catalogueItemId:createId('dmrci'),catalogueVersion:1,reservationId:createId('dmres'),status:'CHARGE_PENDING',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,unitCount:1,chargeTotalPaise:50000,fulfilmentMode:'PICKUP',pickupBranchId:ctx.branch._id,quoteExpiresAt:new Date(Date.now()+600000),chargePaymentExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem()});
 await M.DigitalMetalRedemptionPaymentAttempt.create({_id:attemptId,tenantId:ctx.tenant._id,customerId:customer._id,orderId:id,status:'INITIATED',amountPaise:50000,merchantOrderId:attemptId,providerOrderId:'audit-provider-order',checkoutMode:'LIVE',idempotencyKey:idem()});
 const event=await M.WebhookEvent.create({_id:createId('webhook'),tenantId:ctx.tenant._id,provider:'PHONEPE',providerEventId:idem(),status:'QUEUED',payload:{type:'CHECKOUT_ORDER_COMPLETED',payload:{originalMerchantOrderId:attemptId,amount:50000,currency:'INR',paymentDetails:[{state:'COMPLETED',transactionId:idem(),amount:50000}]}}});
 const pending = await listCustomerOpenOrdersSummary({auth:{id:customer._id,tenantId:ctx.tenant._id,type:'CUSTOMER'}});
 assert.equal(pending.openRedemptionCount,1);
 await processWebhook({data:{webhookEventId:event._id},attemptsMade:0});
 const order=await M.DigitalMetalRedemptionOrder.findById(id).lean();const attempt=await M.DigitalMetalRedemptionPaymentAttempt.findById(attemptId).lean();const webhook=await M.WebhookEvent.findById(event._id).lean();
 console.log('AUDIT_REDEMPTION_WEBHOOK',JSON.stringify({order:order.status,attempt:attempt.status,webhook:webhook.status}));assert.equal(order.status,'CHARGE_PAID');
});


test('DM duplicate refund completion preserves credited purchase and separates captures',async()=>{
 const ctx=await ready();const id=createId('dmbo');
 await M.DigitalMetalBuyOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:ctx.customer._id,quoteId:createId('dmq'),status:'CREDITED',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,totalPayablePaise:50000,quoteExpiresAt:new Date(Date.now()+600000),paymentAcceptanceExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem(),successfulPaymentAttemptId:createId('dmpay'),creditJournalId:createId('dmj')});
 for(let n=0;n<2;n++){
  const extra=createId('dmpay');await M.DigitalMetalBuyPaymentAttempt.create({_id:extra,tenantId:ctx.tenant._id,customerId:ctx.customer._id,orderId:id,status:'INITIATED',amountPaise:50000,currency:'INR',merchantOrderId:extra,idempotencyKey:idem()});
  await finalizeDigitalMetalBuyPaymentSuccess({tenantId:ctx.tenant._id,merchantOrderId:extra,transactionId:idem(),amountPaise:50000});
 }
 const cases=await M.DigitalMetalPaymentExceptionRefund.find({orderId:id}).lean();assert.equal(cases.length,2);
 for(const row of cases) await confirmDigitalMetalPaymentExceptionRefundFromProvider({tenantId:ctx.tenant._id,payload:{merchantRefundId:row._id,state:'COMPLETED',amount:50000}});
 const order=await M.DigitalMetalBuyOrder.findById(id).lean();assert.equal(order.status,'CREDITED');assert.equal(order.paymentExceptionStatus,null);
});

test('payout settlement rejects legacy overcommit instead of clamping outstanding to zero',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});
 const payable=await M.DigitalMetalPayable.create({_id:createId('dmpaybl'),tenantId:ctx.tenant._id,customerId:customer._id,sellOrderId:createId('dmso'),amountPaise:50000,outstandingPaise:10000,status:'OPEN'});
 const payout=await M.DigitalMetalPayout.create({_id:createId('dmpos'),tenantId:ctx.tenant._id,payableId:payable._id,sellOrderId:payable.sellOrderId,customerId:customer._id,amountPaise:50000,status:'APPROVED',makerUserId:createId('user'),idempotencyKey:idem()});
 await assert.rejects(recordPayoutSettlement({auth:{id:ctx.user._id,type:'TENANT_USER',role:'TENANT_OWNER',tenantId:ctx.tenant._id},scope:{tenantId:ctx.tenant._id},params:{payoutId:payout._id},headers:{'x-idempotency-key':idem()},body:{settlementDate:'2026-10-30',bankReference:'audit-bank',evidenceUploadIds:['audit-evidence'],approverAttestation:true}}),error=>error.code==='OVERPAYMENT_PREVENTED');
 assert.equal((await M.DigitalMetalPayout.findById(payout._id).lean()).status,'APPROVED');assert.equal((await M.DigitalMetalPayable.findById(payable._id).lean()).outstandingPaise,10000);
});

test('uncertain checkout recovery uses merchant identity for buy, ecommerce and redemption charges',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const t=ctx.tenant._id;
 const buyId=createId('dmbo'), ecommerceId=createId('eo'), redemptionId=createId('dmro');
 await M.DigitalMetalBuyOrder.create({_id:buyId,tenantId:t,customerId:customer._id,quoteId:createId('dmq'),status:'PAYMENT_PENDING',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,totalPayablePaise:50000,quoteExpiresAt:new Date(Date.now()+600000),paymentAcceptanceExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem()});
 await M.EcommerceOrder.create({_id:ecommerceId,tenantId:t,customerId:customer._id,orderNumber:'AUDIT-RECOVERY',status:'PENDING_PAYMENT',totalPaise:50000,creationBodyHash:'audit',idempotencyKey:idem(),fulfilmentMode:'DELIVERY'});
 await M.DigitalMetalRedemptionOrder.create({_id:redemptionId,tenantId:t,customerId:customer._id,quoteId:createId('dmq'),catalogueItemId:createId('dmrci'),catalogueVersion:1,reservationId:createId('dmres'),status:'CHARGE_PENDING',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,unitCount:1,chargeTotalPaise:50000,fulfilmentMode:'PICKUP',quoteExpiresAt:new Date(Date.now()+600000),chargePaymentExpiresAt:new Date(Date.now()+600000),termsAcceptedAt:new Date(),idempotencyKey:idem()});
 const refs=[];
 for(const [Model,prefix,orderId]of[[M.DigitalMetalBuyPaymentAttempt,'dmpay',buyId],[M.EcommercePaymentAttempt,'epay',ecommerceId],[M.DigitalMetalRedemptionPaymentAttempt,'dmrpay',redemptionId]]){
  const id=createId(prefix);refs.push(id);await Model.create({_id:id,tenantId:t,customerId:customer._id,orderId,status:'PENDING',amountPaise:50000,currency:'INR',merchantOrderId:id,idempotencyKey:idem(),failureReason:'PROVIDER_INITIATION_UNCERTAIN',gatewayReconcileNextAt:new Date(Date.now()-1000)});
 }
 const original=phonePeProvider.getOrderStatus;const polled=[];
 phonePeProvider.getOrderStatus=async reference=>{polled.push(reference);return{state:'COMPLETED',amount:50000,paymentDetails:[{state:'COMPLETED',transactionId:`audit-${reference}`}]}};
 try{
  const {runEcommercePaymentReconcile}=await import('../src/services/ecommerce-payment-reconcile.service.js');
  await runDigitalMetalBuyPaymentReconcile();await runEcommercePaymentReconcile();
 }finally{phonePeProvider.getOrderStatus=original}
 assert.deepEqual([...polled].sort(),[...refs].sort());
 assert.equal((await M.DigitalMetalBuyOrder.findById(buyId).lean()).status,'CREDITED');
 assert.equal((await M.EcommerceOrder.findById(ecommerceId).lean()).status,'PAID');
 assert.equal((await M.DigitalMetalRedemptionOrder.findById(redemptionId).lean()).status,'CHARGE_PAID');
});

test('reconciliation exhaustion alerts once and excludes unresolved attempts from automatic retry',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('dmpay');
 const {env}=await import('../src/config/env.js');const max=env.DIGITAL_METALS_PAYMENT_RECONCILE_MAX_ATTEMPTS??12;
 await M.DigitalMetalBuyPaymentAttempt.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,orderId:createId('dmbo'),status:'PENDING',amountPaise:50000,merchantOrderId:id,idempotencyKey:idem(),gatewayReconcileAttempts:max-1,gatewayReconcileNextAt:new Date(Date.now()-1000)});
 const original=phonePeProvider.getOrderStatus;let calls=0;phonePeProvider.getOrderStatus=async()=>{calls++;return{state:'PENDING'}};
 try{await runDigitalMetalBuyPaymentReconcile();await runDigitalMetalBuyPaymentReconcile()}finally{phonePeProvider.getOrderStatus=original}
 assert.equal(calls,1);assert.equal(await M.Alert.countDocuments({entityId:id,type:'GATEWAY_RECONCILE_EXHAUSTED'}),1);
});

test('redemption refund completion rolls back both records after an order-update failure',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('dmro');
 await M.DigitalMetalRedemptionOrder.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,quoteId:createId('dmq'),catalogueItemId:createId('dmrci'),catalogueVersion:1,reservationId:createId('dmres'),status:'COMPLETED',metal:'GOLD',finenessPpm:999000,quantityUg:1000000,unitCount:1,chargeTotalPaise:50000,fulfilmentMode:'PICKUP',quoteExpiresAt:new Date(),chargePaymentExpiresAt:new Date(),termsAcceptedAt:new Date(),idempotencyKey:idem(),paymentExceptionStatus:'ADDITIONAL_CAPTURE'});
 const refund=await M.DigitalMetalRedemptionChargeRefundCase.create({_id:createId('dmrref'),tenantId:ctx.tenant._id,customerId:customer._id,redemptionOrderId:id,paymentAttemptId:createId('dmrpay'),merchantOrderId:createId('dmrpay'),amountPaise:50000,exceptionType:'ADDITIONAL_CAPTURE',status:'ASSIGNED'});
 const {confirmRedemptionChargeRefundFromProvider}=await import('../src/services/digital-metals-redemption-charge-refund.service.js');
 const original=M.DigitalMetalRedemptionOrder.updateOne;M.DigitalMetalRedemptionOrder.updateOne=()=>{throw new Error('SIMULATED_ORDER_UPDATE_FAILURE')};
 try{await assert.rejects(confirmRedemptionChargeRefundFromProvider({tenantId:ctx.tenant._id,payload:{merchantRefundId:refund._id,state:'COMPLETED',amount:50000}}),/SIMULATED_ORDER_UPDATE_FAILURE/)}finally{M.DigitalMetalRedemptionOrder.updateOne=original}
 assert.equal((await M.DigitalMetalRedemptionChargeRefundCase.findById(refund._id).lean()).status,'ASSIGNED');
 assert.equal((await M.DigitalMetalRedemptionOrder.findById(id).lean()).status,'COMPLETED');
 await confirmRedemptionChargeRefundFromProvider({tenantId:ctx.tenant._id,payload:{merchantRefundId:refund._id,state:'COMPLETED',amount:50000}});
 assert.equal((await M.DigitalMetalRedemptionChargeRefundCase.findById(refund._id).lean()).status,'SUCCEEDED');
 assert.equal((await M.DigitalMetalRedemptionOrder.findById(id).lean()).status,'COMPLETED');
});

test('invalid completed provider responses also consume the bounded retry budget',async()=>{
 const ctx=await seedTenantUser();const customer=await seedCustomer({tenantId:ctx.tenant._id,branchId:ctx.branch._id});const id=createId('dmpay');
 const {env}=await import('../src/config/env.js');const max=env.DIGITAL_METALS_PAYMENT_RECONCILE_MAX_ATTEMPTS??12;
 await M.DigitalMetalBuyPaymentAttempt.create({_id:id,tenantId:ctx.tenant._id,customerId:customer._id,orderId:createId('dmbo'),status:'PENDING',amountPaise:50000,merchantOrderId:id,idempotencyKey:idem(),gatewayReconcileAttempts:max-1,gatewayReconcileNextAt:new Date(Date.now()-1000)});
 const original=phonePeProvider.getOrderStatus;let calls=0;phonePeProvider.getOrderStatus=async()=>{calls++;return{state:'COMPLETED',amount:50000,paymentDetails:[]}};
 try{await runDigitalMetalBuyPaymentReconcile();await runDigitalMetalBuyPaymentReconcile()}finally{phonePeProvider.getOrderStatus=original}
 const attempt=await M.DigitalMetalBuyPaymentAttempt.findById(id).lean();assert.equal(calls,1);assert.equal(attempt.gatewayLastReconcileOutcome,'INVALID_COMPLETED');assert.equal(await M.Alert.countDocuments({entityId:id,type:'GATEWAY_RECONCILE_EXHAUSTED'}),1);
});

test('customer DM order lists ignore Vercel rewrite path and empty cursor',async()=>{
 const ctx=await ready();
 for (const path of ['buy-orders','sell-orders','redemption/orders']) {
  const res=await request(app)
   .get(`/api/v1/app/digital-metals/${path}`)
   .query({limit:20,path:`app/digital-metals/${path}`,cursor:''})
   .set('Authorization',`Bearer ${ctx.token}`);
  assert.equal(res.status,200,`${path} => ${JSON.stringify(res.body?.error||{})}`);
  assert.equal(res.body.success,true);
 }
});
