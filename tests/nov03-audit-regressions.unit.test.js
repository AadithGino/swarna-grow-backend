import { listCustomerSellOrders } from "../src/services/digital-metals-customer-orders.service.js";
// Application control-flow tests with model doubles. Mongo integration remains a separate gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as M from '../src/models/index.js';
import { releaseReservation, commitReservation, reservationAccountingIsAmbiguous } from '../src/services/digital-metals-ledger.service.js';
import { completeDeliveryHandover, completePickupHandover, issuePickupCode } from '../src/services/digital-metals-redemption-fulfilment.service.js';
import { recordAdminReturnManualRefund, resolveAdminReturnRequest } from '../src/services/ecommerce-order-return.service.js';
import { applyReturnReceiptRestockOnce } from '../src/lib/ecommerce-order-stock-restock.js';
import { claimManualRefund } from '../src/lib/ecommerce-manual-refund.js';
import { runMaturityTransitionBatch, runDefaultingBatch } from '../src/services/scheme-maintenance.service.js';
import { withDurableEnrolment } from '../src/lib/enrolment-operation.js';
import { assertCounterTenderReplay, postAssistedOrderCash } from '../src/lib/counter-tender.js';
import { idempotencyEndpointsCompatible } from '../src/lib/idempotency-endpoint.js';
import { tenantBrandingDto } from '../src/lib/customer-app-dto.js';
import { otpProvider } from '../src/integrations/otp.provider.js';
import { toMessageCentralMobile } from '../src/integrations/message-central.client.js';
import { expireAndReleaseRedemptionOrder } from '../src/services/digital-metals-redemption-maintenance.service.js';
import { runReservationExpiryBatch } from '../src/services/digital-metals-reservation-expiry.service.js';
import { schedulerRepeatableJobs } from '../src/schedulers/repeatable-jobs.js';
import { getAdminCustomerEcommerceSummary } from '../src/services/ecommerce-admin-customer-orders.service.js';
import { hashPickupCode } from '../src/lib/ecommerce-pickup-code.js';

function query(value) {
  return { session(){return this;},sort(){return this;},limit(){return this;},select(){return this;},
    lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject);} };
}
function transaction(t, before = async()=>{}) {
  const session={ withTransaction:async work=>{await before();return work();},endSession:async()=>{} };
  t.mock.method(mongoose,'startSession',async()=>session);
  return session;
}
const staff={auth:{type:'TENANT_USER',tenantId:'tenant_a',id:'owner_a',role:'TENANT_OWNER'},scope:{}};

function ledger(t, mode) {
  const wallet={_id:'wallet_a',tenantId:'tenant_a',heldUg:100000,reservedUg:60000,save:async()=>{}};
  const reservation={_id:'res_a',status:'ACTIVE',walletId:'wallet_a',quantityUg:60000,lotAllocations:[{lotId:'lot_a',quantityUg:60000}],lotAccountingMode:mode,save:async()=>{}};
  let remaining=100000;
  t.mock.method(M.DigitalMetalReservation,'findOne',()=>query(reservation));
  t.mock.method(M.DigitalMetalWallet,'findById',()=>query(wallet));
  t.mock.method(M.DigitalMetalJournal,'create',async rows=>rows);
  t.mock.method(M.DigitalMetalLot,'updateOne',async (_filter,update)=>{remaining+=update.$inc.remainingUg;return {modifiedCount:1};});
  return {wallet,reservation,remaining:()=>remaining};
}
test('R03: unmarked allocated reservations fail closed before changing wallet or lot',async t=>{
  const f=ledger(t,null);
  assert.equal(reservationAccountingIsAmbiguous(f.reservation),true);
  await assert.rejects(releaseReservation({},'tenant_a','old','release'),{code:'RESERVATION_ACCOUNTING_AMBIGUOUS'});
  await assert.rejects(commitReservation({},'tenant_a','old','commit'),{code:'RESERVATION_ACCOUNTING_AMBIGUOUS'});
  assert.equal(f.remaining(),100000);assert.equal(f.wallet.reservedUg,60000);assert.equal(f.wallet.heldUg,100000);
});
test('R03: reviewed legacy release does not add metal to its untouched lots',async t=>{
  const f=ledger(t,'LEGACY_WALLET_RESERVE');await releaseReservation({},'tenant_a','old','release');
  assert.equal(f.remaining(),100000);assert.equal(f.wallet.reservedUg,0);
});
test('R03: reviewed legacy commit debits lots and wallet by the same quantity',async t=>{
  const f=ledger(t,'LEGACY_WALLET_RESERVE');await commitReservation({},'tenant_a','old','commit');
  assert.equal(f.remaining(),40000);assert.equal(f.wallet.heldUg,40000);assert.equal(f.wallet.reservedUg,0);
});

test('R05: stored counter tender rejects changed mode, reference or operator after cache loss',()=>{
  const order={assisted:{paymentMode:'UPI',paymentReference:'UTR-1',byUserId:'owner_a'}};
  assert.doesNotThrow(()=>assertCounterTenderReplay(order,{...staff,body:{paymentMode:'UPI',paymentReference:'UTR-1'}}));
  for(const body of [{paymentMode:'CASH',paymentReference:''},{paymentMode:'UPI',paymentReference:'UTR-2'}])
    assert.throws(()=>assertCounterTenderReplay(order,{...staff,body}),{code:'IDEMPOTENCY_KEY_REUSED'});
});
test('R05: counter cash repair uses stored staff and same transaction; repeated source does not double-post',async t=>{
  const session={};let adjustment=null;let creates=0;
  t.mock.method(M.CashAdjustment,'findOne',()=>query(adjustment));
  t.mock.method(M.CashStaffCustody,'findOneAndUpdate',async(_f,_u,options)=>{assert.equal(options.session,session);});
  t.mock.method(M.CashAdjustment,'create',async(rows,options)=>{assert.equal(options.session,session);creates++;adjustment=rows[0];return rows;});
  const order={_id:'buy_a',tenantId:'tenant_a',totalPayablePaise:1200,assisted:{paymentMode:'CASH',byUserId:'staff_a',byRole:'BRANCH_STAFF',branchId:'branch_a'}};
  await postAssistedOrderCash(session,order,'DM_COUNTER_BUY');await postAssistedOrderCash(session,order,'DM_COUNTER_BUY');
  assert.equal(creates,1);assert.equal(adjustment.staffId,'staff_a');assert.equal(adjustment.amountPaise,1200);
});

test('R06: unattended expiry is scheduled and batch selects only pre-execution sells',async t=>{
  assert.ok(schedulerRepeatableJobs.some(j=>j.name==='digital-metals-reservation-expiry'&&j.repeat.every===60000));
  let filter;t.mock.method(M.DigitalMetalSellOrder,'find',f=>{filter=f;return query([]);});
  const result=await runReservationExpiryBatch({kind:'sell'});
  assert.deepEqual(filter.$or.map(x=>x.status),['RESERVED','PENDING_APPROVAL']);assert.equal(result.scanned,0);
});
test('R06: pending provider outcome prevents physical redemption reservation release',async t=>{
  transaction(t);
  t.mock.method(M.DigitalMetalRedemptionOrder,'findOne',()=>query({_id:'red_a',tenantId:'tenant_a',version:1}));
  t.mock.method(M.DigitalMetalRedemptionPaymentAttempt,'findOne',()=>query({status:'INITIATED'}));
  t.mock.method(M.DigitalMetalReservation,'findOne',()=>{throw new Error('Must not release uncertain payment');});
  assert.equal((await expireAndReleaseRedemptionOrder({_id:'red_a',tenantId:'tenant_a',version:1})).outcome,'PAYMENT_UNRESOLVED');
});

function physical(t,{mode='DELIVERY',beforeTransaction}={}) {
  let current={_id:'red_a',tenantId:'tenant_a',customerId:'cust_a',idempotencyKey:'reserve',status:mode==='PICKUP'?'PICKUP_READY':'DISPATCHED',
    version:1,quantityUg:1000,metal:'GOLD',finenessPpm:999000,completionAttestation:false,completionEvidenceUploadIds:[],statusHistory:[],
    fulfilmentBranchId:'branch_a',pickupCodeHash:hashPickupCode('123456'),pickupCodeExpiresAt:new Date(Date.now()+60000),pickupCodeAttempts:0};
  const doc=data=>({...globalThis.structuredClone(data),toObject(){const {save: _save,toObject: _toObject,...plain}=this;return plain;},async save(){current=this.toObject();}});
  transaction(t,async()=>{if(beforeTransaction)await beforeTransaction();});
  t.mock.method(M.DigitalMetalRedemptionOrder,'findOne',filter=>query(filter.version!=null&&filter.version!==current.version?null:doc(current)));
  t.mock.method(M.DigitalMetalRedemptionOrder,'findById',()=>query(current));
  t.mock.method(M.DigitalMetalRedemptionOrder,'findOneAndUpdate',async(filter,update)=>{
    if(filter.version!==current.version)return null;
    current={...current,...update.$set,version:current.version+1};return doc(current);
  });
  t.mock.method(M.Customer,'findOne',()=>query({_id:'cust_a',tenantId:'tenant_a'}));
  t.mock.method(M.DigitalMetalPhysicalOutEvent,'findOne',()=>query(null));
  t.mock.method(M.DigitalMetalPhysicalOutEvent,'create',async rows=>rows);
  t.mock.method(M.DigitalMetalOutboxEvent,'create',async rows=>rows);
  t.mock.method(M.DigitalMetalReservation,'findOne',()=>query({status:'COMMITTED'}));
  const req={...staff,params:{orderId:'red_a'},headers:{'x-idempotency-key':'handover_a'},body:{expectedVersion:1,approverAttestation:true,evidenceUploadIds:['proof_a'],pickupCode:'123456',staffHandoverConfirmed:true,fulfilmentBranchId:'branch_a'}};
  return {req,current:()=>current};
}
test('R07: completed locked document retains delivery attestation and evidence after reload',async t=>{
  const f=physical(t);await completeDeliveryHandover(f.req);
  assert.equal(f.current().status,'COMPLETED');assert.equal(f.current().completionAttestation,true);assert.deepEqual(f.current().completionEvidenceUploadIds,['proof_a']);
});
test('R08: code reissue between initial validation and final transaction rejects stale handover',async t=>{
  let f;f=physical(t,{mode:'PICKUP',beforeTransaction:async()=>{
    await issuePickupCode({...f.req,body:{expectedVersion:1}});
  }});
  await assert.rejects(completePickupHandover(f.req),{code:'STATE_RACE'});
  assert.equal(f.current().status,'PICKUP_READY');assert.equal(f.current().version,2);
});

test('R09: shared manual claim excludes provider pending/unknown and terminal outcomes',async t=>{
  for(const state of ['INITIATED','PROVIDER_PENDING','SUCCEEDED','MANUAL_RECORDED']){
    t.mock.method(M.EcommercePaymentExceptionRefund,'findOneAndUpdate',async filter=>{
      assert.deepEqual(filter.status.$in,['ASSIGNED','FAILED']);assert.deepEqual(filter.$or,[{status:'FAILED'},{providerRefundId:null}]);
      assert.equal(filter.status.$in.includes(state),false);return null;
    });
    await assert.rejects(claimManualRefund({}, {tenantId:'tenant_a',orderId:'order_a',refundId:'refund_a',reference:'manual'}),{code:'REFUND_NOT_MANUALLY_PAYABLE'});
  }
});
test('R09: manual RETURN endpoint cannot bypass pending gateway case',async t=>{
  transaction(t);
  t.mock.method(M.EcommerceOrderReturnRequest,'findOne',()=>query({_id:'return_a',orderId:'order_a',kind:'RETURN',status:'INSPECTED',version:1,onlineRefundId:'gateway_a'}));
  t.mock.method(M.EcommerceOrder,'findOne',()=>query({_id:'order_a',paymentMethod:'ONLINE',totalPaise:50000}));
  t.mock.method(M.EcommercePaymentExceptionRefund,'findOne',()=>query({_id:'gateway_a',status:'PROVIDER_PENDING',amountPaise:50000}));
  t.mock.method(M.EcommercePaymentExceptionRefund,'findOneAndUpdate',async()=>null);
  t.mock.method(M.EcommerceOrderReturnRequest,'findOneAndUpdate',()=>{throw new Error('Must not record second repayment');});
  await assert.rejects(recordAdminReturnManualRefund({...staff,params:{returnRequestId:'return_a'},headers:{'x-idempotency-key':'manual_a'},body:{expectedVersion:1,amountPaise:50000,recipient:'Customer',method:'BANK',reference:'MANUAL-1',proofNote:'External repayment'}}),{code:'REFUND_NOT_MANUALLY_PAYABLE'});
});
test('R10: original-order stock entitlement prevents restock by a second return request',async t=>{
  t.mock.method(M.EcommerceOrder,'findOne',()=>query({_id:'order_a',returnStockRestockedRequestId:'first',returnStockRestockedAt:new Date()}));
  t.mock.method(M.EcommerceOrderReturnRequest,'findOne',()=>query(null));
  await assert.rejects(applyReturnReceiptRestockOnce({tenantId:'tenant_a',orderId:'order_a',returnRequestId:'second',session:{}}),{code:'ORDER_ALREADY_RESTOCKED'});
});
test('R11: return cannot resolve from a note while repayment is absent',async t=>{
  transaction(t);
  t.mock.method(M.EcommerceOrderReturnRequest,'findOne',()=>query({_id:'return_a',orderId:'order_a',kind:'RETURN',status:'INSPECTED',version:1}));
  t.mock.method(M.EcommerceOrder,'findOne',()=>query({_id:'order_a'}));
  await assert.rejects(resolveAdminReturnRequest({...staff,params:{returnRequestId:'return_a'},body:{expectedVersion:1,resolutionNote:'Closing without repayment'}}),{code:'RETURN_REFUND_INCOMPLETE'});
});

const matured={_id:'scheme_a',tenantId:'tenant_a',customerId:'cust_a',status:'ACTIVE',version:1,maturityDate:'2026-11-01',paymentPattern:'FIXED',installments:[{status:'PAID'}]};
test('R15: stale scheme maturity decision cannot mutate a newer financial version',async t=>{
  transaction(t);t.mock.method(M.Scheme,'find',()=>query([matured]));
  t.mock.method(M.Scheme,'findOneAndUpdate',async filter=>{assert.equal(filter.version,1);return null;});
  t.mock.method(M.Message,'exists',()=>{throw new Error('Stale transition must not notify');});
  assert.equal((await runMaturityTransitionBatch({today:'2026-11-02'})).processed,0);
});
test('R16: maturity status write and notification creation use the same session',async t=>{
  const session=transaction(t);t.mock.method(M.Scheme,'find',()=>query([matured]));
  t.mock.method(M.Scheme,'findOneAndUpdate',async(_filter,_update,options)=>{assert.equal(options.session,session);return {_id:'scheme_a'};});
  t.mock.method(M.Message,'exists',()=>query(null));
  t.mock.method(M.Customer,'findOne',()=>query({mobile:'+919876543210'}));
  t.mock.method(M.Tenant,'findById',()=>query({_id:'tenant_a',settings:{}}));
  t.mock.method(M.Message,'create',async(_rows,options)=>{assert.equal(options.session,session);throw new Error('NOTICE_WRITE_FAILED');});
  await assert.rejects(runMaturityTransitionBatch({today:'2026-11-02'}),/NOTICE_WRITE_FAILED/);
});

test('R17: durable admin/staff enrolment replay survives HTTP cache loss and rejects changed inputs',async t=>{
  transaction(t);let operation;let effects=0;
  t.mock.method(M.EnrolmentOperation,'findById',()=>query(operation));
  t.mock.method(M.EnrolmentOperation,'create',async rows=>{operation=rows[0];return rows;});
  const req={...staff,baseUrl:'/api/v1/staff',headers:{'x-idempotency-key':'enrol_key_a'},body:{customerId:'cust_a',planId:'plan_a',payment:{amountPaise:10000}}};
  const work=async()=>{effects++;return {_id:'scheme_a',activationPayment:{_id:'payment_a'}};};
  assert.equal((await withDurableEnrolment(req,work))._id,'scheme_a');
  // Response delivery may fail now; the durable row is already committed.
  assert.equal((await withDurableEnrolment(req,work)).activationPayment._id,'payment_a');assert.equal(effects,1);
  await assert.rejects(withDurableEnrolment({...req,body:{...req.body,planId:'plan_b'}},work),{code:'IDEMPOTENCY_KEY_REUSED'});
});
test('R18: current admin/staff namespaces are distinct while legacy same-resource binding works',()=>{
  assert.equal(idempotencyEndpointsCompatible('POST /api/v1/admin/payments','POST /api/v1/staff/payments'),false);
  assert.equal(idempotencyEndpointsCompatible('POST /payments','POST /api/v1/admin/payments'),true);
});
test('R20: public DTO exposes configured OTP length without secret material',()=>{
  const dto=tenantBrandingDto({code:'A',name:'A',integrationSecrets:{messageCentral:{otpLength:4,verifiedAt:new Date(),keySealed:'not-public'}}});
  assert.equal(dto.otpLength,4);assert.equal(dto.integrationSecrets,undefined);assert.equal(JSON.stringify(dto).includes('not-public'),false);
});
test('R21: unsupported country/national lengths fail instead of silently truncating',()=>{
  assert.equal(toMessageCentralMobile('+919876543210','91'),'9876543210');
  assert.throws(()=>toMessageCentralMobile('+971505551234','971'),{code:'OTP_COUNTRY_UNSUPPORTED'});
  assert.throws(()=>toMessageCentralMobile('+971505551234','91'),{code:'MOBILE_INVALID'});
});

test('R14: customer totals include manual return and COD cancellation without linked-case double counting',async t=>{
  t.mock.method(M.Customer,'findOne',()=>query({_id:'cust_a'}));
  t.mock.method(M.EcommerceOrder,'countDocuments',async()=>1);
  t.mock.method(M.EcommerceOrder,'findOne',()=>query(null));
  t.mock.method(M.EcommerceOrder,'aggregate',async pipeline=>{
    const match=pipeline[0].$match;
    if(match.paymentMethod==='ONLINE')return [{amountPaise:10000}];
    if(match['courierCod.remittanceStatus'])return [{amountPaise:900}];
    if(match['courierCod.collectionStatus'])return [{amountPaise:1000}];
    return [];
  });
  t.mock.method(M.EcommercePaymentExceptionRefund,'aggregate',async()=>[{refundOutflowPaise:2000}]);
  t.mock.method(M.EcommerceOrderReturnRequest,'aggregate',async pipeline=>{assert.equal(pipeline[0].$match['manualRefundProof.refundCaseId'],null);return [{amountPaise:3000}];});
  t.mock.method(M.EcommerceOrderCancellationRequest,'aggregate',async()=>[{amountPaise:4000}]);
  const summary=await getAdminCustomerEcommerceSummary({...staff,params:{customerId:'cust_a'}});
  assert.equal(summary.refundOutflowPaise,9000);assert.equal(summary.netCollectedPaise,1900);
});

test('R20: provider validation uses the delivered OTP length and rejects wrong-length input locally',async()=>{
  let validations=0;
  const params={tenantCode:'REVIEW_OTP_LENGTH',mobile:'+919876543210',purpose:'SIGNUP'};
  const deps={env:{OTP_PROVIDER:'message_central',PROVIDER_MODE:'live',MESSAGE_CENTRAL_PLATFORM_CUSTOMER_ID:'review',MESSAGE_CENTRAL_PLATFORM_KEY:'key',MESSAGE_CENTRAL_PLATFORM_OTP_LENGTH:4},
    fetch:async url=>({ok:true,text:async()=>{
      if(String(url).includes('/authentication/token'))return JSON.stringify({token:'test'});
      if(String(url).includes('/validateOtp')){validations++;return JSON.stringify({data:{verificationStatus:'VERIFICATION_COMPLETED'}});}
      return JSON.stringify({responseCode:200,data:{verificationId:'length-test'}});
    }})};
  const sent=await otpProvider.send(params,deps);
  assert.equal((await otpProvider.validate({...params,otp:'123456',otpId:sent.otpId},deps)).ok,false);
  assert.equal(validations,0);
  assert.equal((await otpProvider.validate({...params,otp:'1234',otpId:sent.otpId},deps)).ok,true);
  assert.equal(validations,1);
  assert.equal(await otpProvider.verify({...params,otp:'1234',otpId:sent.otpId},deps),true);
  assert.ok(validations >= 1);
});

test('R15: defaulting sweep fences a selected financial version too',async t=>{
  t.mock.method(M.Scheme,'find',()=>query([{...matured,positionVersion:3,planSnapshot:{benefit:{eligibility:{maxAllowedDefaults:0}}},installments:[{status:'OVERDUE'}]}]));
  t.mock.method(M.Scheme,'findOneAndUpdate',async filter=>{assert.equal(filter.version,1);assert.equal(filter.positionVersion,3);return null;});
  const result=await runDefaultingBatch();assert.equal(result.processed,0);assert.equal(result.conflicted,1);
});

test('R02: customer sell history hydrates the current settled payable too',async t=>{
  t.mock.method(M.DigitalMetalSellOrder,'find',()=>query([{_id:'sell_a',tenantId:'tenant_a',customerId:'cust_a',status:'PAYABLE_OPEN',payableId:'pay_a',quantityUg:1000}]));
  t.mock.method(M.DigitalMetalPayable,'find',()=>query([{_id:'pay_a',status:'SETTLED',amountPaise:50000,outstandingPaise:0}]));
  t.mock.method(M.DigitalMetalPayout,'find',()=>query([]));
  const result=await listCustomerSellOrders({auth:{tenantId:'tenant_a',id:'cust_a'},query:{},digitalMetalsCapability:{canViewHistory:true}});
  assert.equal(result.items[0].paymentDisplayState.key,'PAID');assert.equal(result.items[0].payable.outstandingPaise,0);
});
