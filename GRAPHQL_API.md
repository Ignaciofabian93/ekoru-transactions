# ekoru-transactions — GraphQL API Reference

> **Subgraph**: Transactions — payments (Khipu/Webpay), orders, eco-transaction ledger, and exchanges.

---

## Headers

| Header | Required | Description |
|---|---|---|
| `Authorization` | Some mutations | `Bearer <jwt_token>` |
| `x-seller-id` | Authenticated mutations | Seller UUID from auth |

---

## Enums

```graphql
enum TransactionKind {
  PURCHASE
  SELL
  STOREPURCHASE
  EXCHANGE
  RECYCLE
  REPAIR
  ATTENDTOWORKSHOP
  ATTENDTOEVENT
}

enum ExchangeStatus {
  PENDING
  ACCEPTED
  DECLINED
  COMPLETED
  CANCELLED
}

enum PaymentStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
  REFUNDED
  PARTIALLY_REFUNDED
  EXPIRED
}

enum PaymentType {
  ORDER
  QUOTATION
}

enum ChileanPaymentProvider {
  KHIPU
  WEBPAY
}

enum PaymentEnvironment {
  SANDBOX
  PRODUCTION
}

# ShippingStage values (String enum):
# PREPARING | SHIPPED | DELIVERED | RETURNED | CANCELED
```

---

## Fragments

```graphql
fragment PageInfoFields on PageInfo {
  totalCount
  totalPages
  currentPage
  pageSize
  hasNextPage
  hasPreviousPage
}

fragment OrderItemFields on OrderItem {
  id
  productId
  storeProductId
  quantity
  price
  createdAt
}

fragment OrderFields on Order {
  id
  sellerId
  shippingStatusId
  version
  createdAt
  updatedAt
}

fragment PaymentConfigFields on ChileanPaymentConfig {
  id
  sellerId
  provider
  merchantId
  environment
  isActive
  webhookUrl
  returnUrl
  cancelUrl
  createdAt
  updatedAt
}

fragment PaymentFields on Payment {
  id
  orderId
  quotationId
  amount
  currency
  status
  paymentProvider
  externalId
  externalToken
  description
  fees
  netAmount
  payerId
  receiverId
  failureReason
  paymentType
  chileanConfigId
  createdAt
  updatedAt
  processedAt
  refundedAt
}

fragment TransactionFields on Transaction {
  id
  kind
  pointsCollected
  sellerId
  transactionFeeId
  createdAt
}

fragment TransactionFeeFields on TransactionFee {
  id
  sellerTypeFee
  feePercentage
  description
}

fragment ExchangeFields on Exchange {
  id
  transactionId
  offeredProductId
  requestedProductId
  notes
  status
  createdAt
  completedAt
}
```

---

## Queries

### getOrder

```graphql
query GetOrder($id: ID!) {
  getOrder(id: $id) {
    ...OrderFields
    shippingStatus {
      id
      status
    }
    orderItems {
      ...OrderItemFields
    }
    seller {
      id
    }
  }
}
```

**Variables**
```json
{ "id": "100" }
```

---

### getOrdersBySeller

```graphql
query GetOrdersBySeller(
  $sellerId: ID!
  $page: Int = 1
  $pageSize: Int = 10
) {
  getOrdersBySeller(
    sellerId: $sellerId
    page: $page
    pageSize: $pageSize
  ) {
    nodes {
      ...OrderFields
      shippingStatus {
        id
        status
      }
      orderItems {
        ...OrderItemFields
      }
    }
    pageInfo { ...PageInfoFields }
  }
}
```

**Variables**
```json
{ "sellerId": "seller-uuid-here", "page": 1, "pageSize": 10 }
```

---

### getPaymentConfig

```graphql
query GetPaymentConfig($id: ID!) {
  getPaymentConfig(id: $id) {
    ...PaymentConfigFields
  }
}
```

**Variables**
```json
{ "id": "1" }
```

---

### getPaymentConfigsBySeller

```graphql
query GetPaymentConfigsBySeller($sellerId: ID!) {
  getPaymentConfigsBySeller(sellerId: $sellerId) {
    ...PaymentConfigFields
  }
}
```

**Variables**
```json
{ "sellerId": "seller-uuid-here" }
```

---

### getPayment

```graphql
query GetPayment($id: ID!) {
  getPayment(id: $id) {
    ...PaymentFields
    payer { id }
    receiver { id }
  }
}
```

**Variables**
```json
{ "id": "55" }
```

---

### getPaymentsByPayer

```graphql
query GetPaymentsByPayer(
  $payerId: ID!
  $page: Int = 1
  $pageSize: Int = 10
  $status: PaymentStatus
) {
  getPaymentsByPayer(
    payerId: $payerId
    page: $page
    pageSize: $pageSize
    status: $status
  ) {
    nodes {
      ...PaymentFields
    }
    pageInfo { ...PageInfoFields }
  }
}
```

**Variables**
```json
{ "payerId": "seller-uuid-here", "page": 1, "pageSize": 10, "status": "COMPLETED" }
```

---

### getPaymentsByReceiver

```graphql
query GetPaymentsByReceiver(
  $receiverId: ID!
  $page: Int = 1
  $pageSize: Int = 10
  $status: PaymentStatus
) {
  getPaymentsByReceiver(
    receiverId: $receiverId
    page: $page
    pageSize: $pageSize
    status: $status
  ) {
    nodes {
      ...PaymentFields
    }
    pageInfo { ...PageInfoFields }
  }
}
```

**Variables**
```json
{ "receiverId": "seller-uuid-here", "page": 1, "pageSize": 10 }
```

---

### getTransaction

```graphql
query GetTransaction($id: ID!) {
  getTransaction(id: $id) {
    ...TransactionFields
    seller { id }
    transactionFee {
      ...TransactionFeeFields
    }
    exchange {
      ...ExchangeFields
    }
  }
}
```

**Variables**
```json
{ "id": "88" }
```

---

### getTransactionsBySeller

```graphql
query GetTransactionsBySeller(
  $sellerId: ID!
  $page: Int = 1
  $pageSize: Int = 10
  $kind: TransactionKind
) {
  getTransactionsBySeller(
    sellerId: $sellerId
    page: $page
    pageSize: $pageSize
    kind: $kind
  ) {
    nodes {
      ...TransactionFields
    }
    pageInfo { ...PageInfoFields }
  }
}
```

**Variables**
```json
{ "sellerId": "seller-uuid-here", "page": 1, "pageSize": 10, "kind": "PURCHASE" }
```

---

### getTransactionFees

```graphql
query GetTransactionFees {
  getTransactionFees {
    ...TransactionFeeFields
  }
}
```

---

## Mutations

### createOrder

```graphql
mutation CreateOrder($input: CreateOrderInput!) {
  createOrder(input: $input) {
    ...OrderFields
    orderItems {
      ...OrderItemFields
    }
  }
}
```

**Variables**
```json
{
  "input": {
    "sellerId": "seller-uuid-here",
    "items": [
      { "storeProductId": 42, "quantity": 2, "price": 25000 },
      { "productId": 10, "quantity": 1, "price": 850000 }
    ]
  }
}
```

---

### updateShipping

```graphql
mutation UpdateShipping($input: UpdateShippingInput!) {
  updateShipping(input: $input) {
    ...OrderFields
    shippingStatus {
      id
      status
    }
  }
}
```

**Variables**
```json
{
  "input": {
    "orderId": "100",
    "stage": "SHIPPED"
  }
}
```

---

### createPaymentConfig

Configure a Chilean payment provider for a seller. Requires auth.

```graphql
mutation CreatePaymentConfig($input: CreatePaymentConfigInput!) {
  createPaymentConfig(input: $input) {
    ...PaymentConfigFields
  }
}
```

**Variables**
```json
{
  "input": {
    "sellerId": "seller-uuid-here",
    "provider": "KHIPU",
    "merchantId": "123456789",
    "apiKey": "your-api-key",
    "environment": "SANDBOX",
    "returnUrl": "https://myapp.com/payment/return",
    "cancelUrl": "https://myapp.com/payment/cancel"
  }
}
```

---

### createPayment

```graphql
mutation CreatePayment($input: CreatePaymentInput!) {
  createPayment(input: $input) {
    ...PaymentFields
  }
}
```

**Variables**
```json
{
  "input": {
    "orderId": 100,
    "amount": 50000,
    "currency": "CLP",
    "paymentProvider": "KHIPU",
    "payerId": "buyer-uuid-here",
    "receiverId": "seller-uuid-here",
    "paymentType": "ORDER",
    "chileanConfigId": 1,
    "description": "Pago de orden #100"
  }
}
```

---

### refundPayment

```graphql
mutation RefundPayment($input: RefundPaymentInput!) {
  refundPayment(input: $input) {
    id
    amount
    reason
    status
    createdAt
  }
}
```

**Variables**
```json
{
  "input": {
    "paymentId": 55,
    "amount": 50000,
    "reason": "Producto no disponible"
  }
}
```

---

### createTransaction

```graphql
mutation CreateTransaction($input: CreateTransactionInput!) {
  createTransaction(input: $input) {
    ...TransactionFields
  }
}
```

**Variables**
```json
{
  "input": {
    "kind": "PURCHASE",
    "pointsCollected": 50,
    "sellerId": "seller-uuid-here",
    "transactionFeeId": 1
  }
}
```

---

### createExchange

```graphql
mutation CreateExchange($input: CreateExchangeInput!) {
  createExchange(input: $input) {
    ...ExchangeFields
  }
}
```

**Variables**
```json
{
  "input": {
    "transactionId": 88,
    "offeredProductId": 10,
    "requestedProductId": 25,
    "notes": "Ofrezco iPhone 13 por tu MacBook Air"
  }
}
```

---

### updateExchangeStatus

```graphql
mutation UpdateExchangeStatus($id: ID!, $status: ExchangeStatus!) {
  updateExchangeStatus(id: $id, status: $status) {
    ...ExchangeFields
  }
}
```

**Variables**
```json
{ "id": "5", "status": "ACCEPTED" }
```

---

## Input Types

### CreateOrderInput

```graphql
input CreateOrderInput {
  sellerId: String!
  items: [OrderItemInput!]!   # Min 1 item
}

input OrderItemInput {
  productId: Int              # Marketplace product (one of productId or storeProductId required)
  storeProductId: Int         # Store product
  quantity: Int!              # Min 1
  price: Int!                 # Unit price in CLP
}
```

### UpdateShippingInput

```graphql
input UpdateShippingInput {
  orderId: ID!
  stage: ShippingStage!       # PREPARING | SHIPPED | DELIVERED | RETURNED | CANCELED
}
```

### CreatePaymentConfigInput

```graphql
input CreatePaymentConfigInput {
  sellerId: String!
  provider: ChileanPaymentProvider!   # KHIPU | WEBPAY
  merchantId: String                  # Receiver ID (Khipu) or commerce code (Webpay)
  apiKey: String                      # Write-only — never returned in queries
  secretKey: String                   # Write-only — Webpay signing key
  environment: PaymentEnvironment     # SANDBOX | PRODUCTION (default: SANDBOX)
  webhookUrl: String
  returnUrl: String
  cancelUrl: String
  isActive: Boolean                   # Default: true
}
```

### CreatePaymentInput

```graphql
input CreatePaymentInput {
  orderId: Int
  quotationId: Int
  amount: Float!
  currency: String                      # Default: CLP
  paymentProvider: ChileanPaymentProvider!  # KHIPU | WEBPAY
  description: String
  payerId: String!
  receiverId: String!
  paymentType: PaymentType!             # ORDER | QUOTATION
  chileanConfigId: Int!
}
```

### RefundPaymentInput

```graphql
input RefundPaymentInput {
  paymentId: Int!
  amount: Float!
  reason: String!
}
```

### CreateTransactionInput

```graphql
input CreateTransactionInput {
  kind: TransactionKind!
  pointsCollected: Int!       # Min 0
  sellerId: String!
  transactionFeeId: Int
}
```

### CreateExchangeInput

```graphql
input CreateExchangeInput {
  transactionId: Int!
  offeredProductId: Int!
  requestedProductId: Int!
  notes: String
}
```
