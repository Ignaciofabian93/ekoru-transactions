import { registerEnumType } from '@nestjs/graphql';

export enum ServicePricing {
  FIXED = 'FIXED',
  QUOTATION = 'QUOTATION',
  HOURLY = 'HOURLY',
  PACKAGE = 'PACKAGE',
}

export enum QuotationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export enum ServiceSortField {
  CREATED_AT = 'CREATED_AT',
  NAME = 'NAME',
  BASE_PRICE = 'BASE_PRICE',
}

// ─── Payment Enums (Chile-first) ────────────────────────────────────────────

export enum ChileanPaymentProvider {
  KHIPU = 'KHIPU',
  WEBPAY = 'WEBPAY',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  EXPIRED = 'EXPIRED',
}

export enum PaymentType {
  ORDER = 'ORDER',
  QUOTATION = 'QUOTATION',
}

export enum RefundStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
}

// ─── Transaction & Order Enums ───────────────────────────────────────────────

export enum TransactionKind {
  PURCHASE = 'PURCHASE',
  SELL = 'SELL',
  STOREPURCHASE = 'STOREPURCHASE',
  EXCHANGE = 'EXCHANGE',
  RECYCLE = 'RECYCLE',
  REPAIR = 'REPAIR',
  ATTENDTOWORKSHOP = 'ATTENDTOWORKSHOP',
  ATTENDTOEVENT = 'ATTENDTOEVENT',
}

export enum ExchangeStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum ShippingStage {
  PREPARING = 'PREPARING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  RETURNED = 'RETURNED',
  CANCELED = 'CANCELED',
}

export enum SellerType {
  PERSON = 'PERSON',
  STARTUP = 'STARTUP',
  COMPANY = 'COMPANY',
}

// ─── Register all enums with GraphQL ─────────────────────────────────────────

registerEnumType(ServicePricing, {
  name: 'ServicePricing',
  description: 'Service pricing types',
});

registerEnumType(QuotationStatus, {
  name: 'QuotationStatus',
  description: 'Quotation status types',
});

registerEnumType(SortOrder, {
  name: 'SortOrder',
  description: 'Sort order direction',
});

registerEnumType(ServiceSortField, {
  name: 'ServiceSortField',
  description: 'Service sort field options',
});

registerEnumType(ChileanPaymentProvider, {
  name: 'ChileanPaymentProvider',
  description: 'Chilean payment providers supported (Khipu, Webpay)',
});

registerEnumType(PaymentStatus, {
  name: 'PaymentStatus',
  description: 'Payment status lifecycle',
});

registerEnumType(PaymentType, {
  name: 'PaymentType',
  description: 'Payment linked to an order or a quotation',
});

registerEnumType(RefundStatus, {
  name: 'RefundStatus',
  description: 'Refund status lifecycle',
});

registerEnumType(PaymentEnvironment, {
  name: 'PaymentEnvironment',
  description: 'Payment environment: sandbox or production',
});

registerEnumType(TransactionKind, {
  name: 'TransactionKind',
  description: 'Type of eco-transaction performed',
});

registerEnumType(ExchangeStatus, {
  name: 'ExchangeStatus',
  description: 'Exchange status lifecycle',
});

registerEnumType(ShippingStage, {
  name: 'ShippingStage',
  description: 'Shipping stage lifecycle',
});

registerEnumType(SellerType, {
  name: 'SellerType',
  description: 'Seller type (person, startup, company)',
});
