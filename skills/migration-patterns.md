# Migration Patterns — Legacy Upgrade Strategies

Tài liệu thực chiến cho **Legacy Guardian Agent**.
Bao gồm: Adapter Pattern cho 4 ngôn ngữ (Go, PHP, Python, TypeScript), code snippets wrap hàm cũ,
và quy ước đặt tên interface theo Strangler Fig Pattern.

> **Quy tắc #1:** Không bao giờ sửa code trong `/src/legacy/`.
> Mọi tương tác đều đi qua adapter trong `/src/adapters/`.

---

## Mục lục

1. [Adapter Pattern — Theo ngôn ngữ](#1-adapter-pattern--theo-ngôn-ngữ)
2. [Wrap Legacy Functions — Code Snippets](#2-wrap-legacy-functions--code-snippets)
3. [Strangler Fig — Quy ước đặt tên Interface](#3-strangler-fig--quy-ước-đặt-tên-interface)
4. [Corrective Adapter — Sửa bug không chạm legacy](#4-corrective-adapter--sửa-bug-không-chạm-legacy)
5. [Decision Matrix](#5-decision-matrix)
6. [Cấu trúc thư mục Adapter](#6-cấu-trúc-thư-mục-adapter)

---

## 1. Adapter Pattern — Theo ngôn ngữ

### 1.1 TypeScript

```typescript
// /src/adapters/billing/interface.ts
// Interface SẠCH — Green Zone chỉ thấy cái này
export interface BillingPort {
  calculateTotal(orderId: string): Promise<number>;
  applyDiscount(orderId: string, code: string): Promise<number>;
}

// /src/adapters/billing/adapter.ts
// Adapter — delegate xuống legacy, KHÔNG sửa legacy
import type { BillingPort } from './interface';
// Legacy import — chỉ xuất hiện TRONG adapter, không bao giờ trong v3
import { calcOrder, applyPromo } from '../../legacy/billing';

export class LegacyBillingAdapter implements BillingPort {
  async calculateTotal(orderId: string): Promise<number> {
    // Legacy trả về string → adapter convert sang number
    const raw = await calcOrder(orderId);
    return parseFloat(raw);
  }

  async applyDiscount(orderId: string, code: string): Promise<number> {
    // Legacy dùng tên param khác (promoCode) — adapter translate
    const raw = await applyPromo({ oid: orderId, promoCode: code });
    return parseFloat(raw);
  }
}
```

```typescript
// /src/modules/v3/checkout/checkout.service.ts
// Green Zone — chỉ import interface, KHÔNG biết legacy tồn tại
import type { BillingPort } from '../../../adapters/billing/interface';

export class CheckoutService {
  constructor(private readonly billing: BillingPort) {} // DI

  async checkout(orderId: string): Promise<{ total: number }> {
    const total = await this.billing.calculateTotal(orderId);
    return { total };
  }
}
```

### 1.2 Go

```go
// /src/adapters/billing/port.go
// Interface — Go convention: đặt interface ở consumer side
package billing

type BillingPort interface {
    CalculateTotal(orderID string) (float64, error)
    ApplyDiscount(orderID string, code string) (float64, error)
}
```

```go
// /src/adapters/billing/legacy_adapter.go
package billing

import (
    "strconv"
    legacy "nexus/src/legacy/billing" // import legacy — CHỈ trong adapter
)

type LegacyBillingAdapter struct{}

func NewLegacyBillingAdapter() *LegacyBillingAdapter {
    return &LegacyBillingAdapter{}
}

func (a *LegacyBillingAdapter) CalculateTotal(orderID string) (float64, error) {
    // Legacy trả string — adapter convert
    raw, err := legacy.CalcOrder(orderID)
    if err != nil {
        return 0, fmt.Errorf("legacy billing.CalcOrder: %w", err)
    }
    return strconv.ParseFloat(raw, 64)
}

func (a *LegacyBillingAdapter) ApplyDiscount(orderID string, code string) (float64, error) {
    raw, err := legacy.ApplyPromo(orderID, code)
    if err != nil {
        return 0, fmt.Errorf("legacy billing.ApplyPromo: %w", err)
    }
    return strconv.ParseFloat(raw, 64)
}
```

```go
// /src/modules/v3/checkout/service.go
// Green Zone — chỉ dùng interface, không biết legacy
package checkout

import "nexus/src/adapters/billing"

type CheckoutService struct {
    billing billing.BillingPort // interface, không phải concrete
}

func NewCheckoutService(b billing.BillingPort) *CheckoutService {
    return &CheckoutService{billing: b}
}

func (s *CheckoutService) Checkout(orderID string) (float64, error) {
    return s.billing.CalculateTotal(orderID)
}
```

### 1.3 Python

```python
# /src/adapters/billing/interface.py
from abc import ABC, abstractmethod


class BillingPort(ABC):
    """Interface sạch — Green Zone chỉ thấy cái này."""

    @abstractmethod
    async def calculate_total(self, order_id: str) -> float: ...

    @abstractmethod
    async def apply_discount(self, order_id: str, code: str) -> float: ...
```

```python
# /src/adapters/billing/adapter.py
from .interface import BillingPort
# Legacy import — CHỈ trong adapter
from src.legacy.billing import calc_order, apply_promo


class LegacyBillingAdapter(BillingPort):
    """Bọc legacy billing — translate data format, không sửa logic."""

    async def calculate_total(self, order_id: str) -> float:
        # Legacy trả string → adapter convert
        raw = await calc_order(order_id)
        return float(raw)

    async def apply_discount(self, order_id: str, code: str) -> float:
        # Legacy dùng dict param — adapter wrap lại
        raw = await apply_promo({"oid": order_id, "promo_code": code})
        return float(raw)
```

```python
# /src/modules/v3/checkout/service.py
# Green Zone — chỉ import interface
from src.adapters.billing.interface import BillingPort


class CheckoutService:
    def __init__(self, billing: BillingPort) -> None:
        self._billing = billing  # DI — nhận interface

    async def checkout(self, order_id: str) -> dict:
        total = await self._billing.calculate_total(order_id)
        return {"total": total}
```

### 1.4 PHP

```php
<?php
// /src/adapters/Billing/BillingPort.php
namespace App\Adapters\Billing;

// Interface sạch — Green Zone chỉ thấy cái này
interface BillingPort
{
    public function calculateTotal(string $orderId): float;
    public function applyDiscount(string $orderId, string $code): float;
}
```

```php
<?php
// /src/adapters/Billing/LegacyBillingAdapter.php
namespace App\Adapters\Billing;

// Legacy import — CHỈ trong adapter
use App\Legacy\Billing\BillingModule;

class LegacyBillingAdapter implements BillingPort
{
    private BillingModule $legacy;

    public function __construct(BillingModule $legacy)
    {
        $this->legacy = $legacy;
    }

    public function calculateTotal(string $orderId): float
    {
        // Legacy trả string → adapter convert
        $raw = $this->legacy->calcOrder($orderId);
        return (float) $raw;
    }

    public function applyDiscount(string $orderId, string $code): float
    {
        // Legacy dùng array param — adapter wrap
        $raw = $this->legacy->applyPromo(['oid' => $orderId, 'promoCode' => $code]);
        return (float) $raw;
    }
}
```

```php
<?php
// /src/modules/v3/Checkout/CheckoutService.php
// Green Zone — chỉ import interface
namespace App\Modules\V3\Checkout;

use App\Adapters\Billing\BillingPort;

class CheckoutService
{
    public function __construct(
        private readonly BillingPort $billing // DI — nhận interface
    ) {}

    public function checkout(string $orderId): array
    {
        $total = $this->billing->calculateTotal($orderId);
        return ['total' => $total];
    }
}
```

---

## 2. Wrap Legacy Functions — Code Snippets

Các mẫu code để **bọc hàm legacy mà không thay đổi logic bên trong**.
Mỗi wrapper chỉ làm 3 việc: translate input → gọi legacy → translate output.

### 2.1 Simple Wrapper — Hàm đơn lẻ

Bọc 1 hàm legacy, chỉ đổi signature cho sạch.

**TypeScript:**
```typescript
// Legacy: getUserData(uid: string): { usr_name: string, usr_email: string }
// Adapter: sạch hoá field names

import { getUserData } from '../../legacy/users';

export async function getUser(userId: string): Promise<{ name: string; email: string }> {
  const raw = getUserData(userId);
  return { name: raw.usr_name, email: raw.usr_email };
}
```

**Go:**
```go
// Legacy: GetUserData(uid string) (map[string]string, error)
// Adapter: trả struct thay vì map

import legacy "nexus/src/legacy/users"

type User struct {
    Name  string
    Email string
}

func GetUser(userID string) (*User, error) {
    raw, err := legacy.GetUserData(userID)
    if err != nil {
        return nil, fmt.Errorf("legacy GetUserData: %w", err)
    }
    return &User{Name: raw["usr_name"], Email: raw["usr_email"]}, nil
}
```

**Python:**
```python
# Legacy: get_user_data(uid) → {"usr_name": "...", "usr_email": "..."}
# Adapter: trả dataclass thay vì dict

from dataclasses import dataclass
from src.legacy.users import get_user_data


@dataclass(frozen=True)
class User:
    name: str
    email: str


def get_user(user_id: str) -> User:
    raw = get_user_data(user_id)
    return User(name=raw["usr_name"], email=raw["usr_email"])
```

**PHP:**
```php
// Legacy: getUserData($uid) → ['usr_name' => '...', 'usr_email' => '...']
// Adapter: trả DTO thay vì array

use App\Legacy\Users\UserModule;

final class UserDto
{
    public function __construct(
        public readonly string $name,
        public readonly string $email,
    ) {}
}

function getUser(string $userId, UserModule $legacy): UserDto
{
    $raw = $legacy->getUserData($userId);
    return new UserDto(name: $raw['usr_name'], email: $raw['usr_email']);
}
```

### 2.2 Error Translation Wrapper

Legacy throw exception/error lạ → adapter translate sang domain error DỰ ĐOÁN ĐƯỢC.

**TypeScript:**
```typescript
import { processPayment as legacyPay } from '../../legacy/payment';

export class PaymentFailedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PaymentFailedError';
  }
}

export async function processPayment(amount: number, currency: string): Promise<string> {
  try {
    // Legacy throw generic Error với message "ERR_42: insufficient funds"
    return await legacyPay({ amt: amount, cur: currency });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Parse legacy error format → domain error
    const match = msg.match(/^ERR_(\d+):\s*(.+)$/);
    if (match) {
      throw new PaymentFailedError(match[1], match[2]);
    }
    throw new PaymentFailedError('UNKNOWN', msg);
  }
}
```

**Go:**
```go
import legacy "nexus/src/legacy/payment"

type PaymentError struct {
    Code    string
    Message string
}

func (e *PaymentError) Error() string {
    return fmt.Sprintf("payment error %s: %s", e.Code, e.Message)
}

func ProcessPayment(amount float64, currency string) (string, error) {
    txID, err := legacy.ProcessPayment(amount, currency)
    if err != nil {
        // Legacy trả error string "ERR_42: insufficient funds"
        // Adapter parse → structured PaymentError
        return "", parsePaymentError(err)
    }
    return txID, nil
}
```

### 2.3 Async-to-Sync / Callback-to-Promise Wrapper

Legacy dùng callback → adapter wrap thành Promise/async.

**TypeScript:**
```typescript
// Legacy: sendEmail(to, body, callback: (err, result) => void)
import { sendEmail as legacySend } from '../../legacy/notification';

export function sendEmail(to: string, body: string): Promise<{ messageId: string }> {
  return new Promise((resolve, reject) => {
    legacySend(to, body, (err: Error | null, result: any) => {
      if (err) return reject(new NotificationError(err.message));
      resolve({ messageId: result.msg_id });
    });
  });
}
```

**PHP:**
```php
// Legacy: sendEmail($to, $body) trả void, throw nếu lỗi
// Adapter: wrap thành Result object

use App\Legacy\Notification\Mailer;

final class EmailResult
{
    public function __construct(
        public readonly bool $success,
        public readonly ?string $messageId = null,
        public readonly ?string $error = null,
    ) {}
}

function sendEmail(string $to, string $body, Mailer $legacy): EmailResult
{
    try {
        $raw = $legacy->sendEmail($to, $body);
        return new EmailResult(success: true, messageId: $raw['msg_id'] ?? null);
    } catch (\Throwable $e) {
        return new EmailResult(success: false, error: $e->getMessage());
    }
}
```

### 2.4 Batch/Aggregate Wrapper

Legacy chỉ xử lý 1 item → adapter wrap thành batch.

**Python:**
```python
from src.legacy.inventory import check_stock  # check_stock(sku) → int


async def check_stock_batch(skus: list[str]) -> dict[str, int]:
    """Legacy chỉ check 1 SKU/lần → adapter batch lại."""
    import asyncio
    results = await asyncio.gather(
        *(asyncio.to_thread(check_stock, sku) for sku in skus)
    )
    return dict(zip(skus, results))
```

**Go:**
```go
import legacy "nexus/src/legacy/inventory"

// Legacy chỉ check 1 SKU → adapter batch qua goroutine
func CheckStockBatch(skus []string) (map[string]int, error) {
    type result struct {
        sku   string
        qty   int
        err   error
    }

    ch := make(chan result, len(skus))
    for _, sku := range skus {
        go func(s string) {
            qty, err := legacy.CheckStock(s)
            ch <- result{sku: s, qty: qty, err: err}
        }(sku)
    }

    out := make(map[string]int, len(skus))
    for range skus {
        r := <-ch
        if r.err != nil {
            return nil, fmt.Errorf("check stock %s: %w", r.sku, r.err)
        }
        out[r.sku] = r.qty
    }
    return out, nil
}
```

---

## 3. Strangler Fig — Quy ước đặt tên Interface

> Mục tiêu: Đặt tên sao cho khi xóa legacy hoàn toàn, code Green Zone **KHÔNG cần rename gì cả**.

### 3.1 Nguyên tắc bắt buộc

| Quy tắc | Giải thích |
|---|---|
| Interface dùng **tên domain thuần** | `BillingPort`, `UserRepository` — KHÔNG có chữ "Legacy" hay "Old" |
| Adapter class mang prefix `Legacy` | `LegacyBillingAdapter` — rõ ràng đây là cầu nối tạm thời |
| New implementation dùng **tên domain** | `BillingService` (v3) — khi xóa legacy, nó thay thế adapter seamlessly |
| File adapter đặt trong `/src/adapters/` | Khi xóa legacy → xóa cả folder adapter, không ảnh hưởng v3 |

### 3.2 Naming Convention — Tất cả ngôn ngữ

```
Interface (contract):
  TS:     {Domain}Port          → BillingPort, UserPort, NotificationPort
  Go:     {Domain}Port          → BillingPort, UserPort (hoặc {Domain}er nếu 1 method)
  Python: {Domain}Port          → BillingPort, UserPort
  PHP:    {Domain}Port          → BillingPort, UserPort

Legacy Adapter (tạm thời — sẽ bị xóa):
  TS:     Legacy{Domain}Adapter → LegacyBillingAdapter
  Go:     Legacy{Domain}Adapter → LegacyBillingAdapter
  Python: Legacy{Domain}Adapter → LegacyBillingAdapter
  PHP:    Legacy{Domain}Adapter → LegacyBillingAdapter

New Implementation (v3 — sẽ thay thế adapter):
  TS:     {Domain}Service       → BillingService
  Go:     {Domain}Service       → BillingService
  Python: {Domain}Service       → BillingService
  PHP:    {Domain}Service       → BillingService
```

### 3.3 Strangler Flow — Vòng đời tên

```
PHASE 1: Legacy còn sống
  ┌──────────────┐     ┌────────────────────────┐     ┌────────────────┐
  │ Green Zone   │────▶│ BillingPort (interface) │◀────│ Legacy code    │
  │ (v3 code)    │     └────────────────────────┘     │ (read-only)    │
  └──────────────┘              ▲                     └────────────────┘
                                │
                    ┌───────────────────────┐
                    │ LegacyBillingAdapter  │  ← adapter bọc legacy
                    └───────────────────────┘

PHASE 2: New implementation sẵn sàng (song song)
  ┌──────────────┐     ┌────────────────────────┐
  │ Green Zone   │────▶│ BillingPort (interface) │
  └──────────────┘     └────────────────────────┘
                          ▲              ▲
             ┌────────────┘              └────────────┐
  ┌───────────────────────┐          ┌────────────────────┐
  │ LegacyBillingAdapter  │          │ BillingService (v3) │
  │   (feature toggle OFF)│          │   (feature toggle ON)│
  └───────────────────────┘          └────────────────────┘

PHASE 3: Legacy xóa sổ
  ┌──────────────┐     ┌────────────────────────┐     ┌────────────────────┐
  │ Green Zone   │────▶│ BillingPort (interface) │◀────│ BillingService (v3)│
  └──────────────┘     └────────────────────────┘     └────────────────────┘
                                                        ↑
                                    Xóa adapter folder + legacy folder.
                                    Green Zone code thay đổi: 0 dòng.
```

### 3.4 Ví dụ DI Container — Swap không đau

**TypeScript (tsyringe / manual):**
```typescript
// /src/modules/v3/di.ts
import type { BillingPort } from '../../adapters/billing/interface';
import { LegacyBillingAdapter } from '../../adapters/billing/adapter';
// import { BillingService } from './billing/billing.service'; // ← uncomment khi sẵn sàng

export function createBilling(): BillingPort {
  // PHASE 1: dùng legacy adapter
  return new LegacyBillingAdapter();
  // PHASE 3: swap sang v3 — CHỈ SỬA DÒNG NÀY
  // return new BillingService();
}
```

**Go (wire / manual):**
```go
// /src/modules/v3/di.go
package v3

import "nexus/src/adapters/billing"

func NewBillingPort() billing.BillingPort {
    // PHASE 1: dùng legacy adapter
    return billing.NewLegacyBillingAdapter()
    // PHASE 3: swap sang v3
    // return billing.NewBillingService()
}
```

**Python (dependency-injector / manual):**
```python
# /src/modules/v3/di.py
from src.adapters.billing.interface import BillingPort
from src.adapters.billing.adapter import LegacyBillingAdapter
# from src.modules.v3.billing.service import BillingService  # uncomment khi sẵn sàng


def create_billing() -> BillingPort:
    # PHASE 1: dùng legacy adapter
    return LegacyBillingAdapter()
    # PHASE 3: swap sang v3
    # return BillingService()
```

**PHP (Laravel container / manual):**
```php
<?php
// /src/modules/v3/di.php
use App\Adapters\Billing\BillingPort;
use App\Adapters\Billing\LegacyBillingAdapter;
// use App\Modules\V3\Billing\BillingService; // uncomment khi sẵn sàng

// Laravel service provider
$this->app->bind(BillingPort::class, function ($app) {
    // PHASE 1: dùng legacy adapter
    return new LegacyBillingAdapter($app->make(\App\Legacy\Billing\BillingModule::class));
    // PHASE 3: swap sang v3
    // return new BillingService();
});
```

---

## 4. Corrective Adapter — Sửa bug không chạm legacy

Khi phát hiện bug trong legacy — **KHÔNG sửa legacy source**. Tạo Corrective Adapter bọc + fix behavior.

**TypeScript:**
```typescript
import { calculateTax as legacyCalcTax } from '../../legacy/tax';

// BUG: Legacy tính tax sai khi amount = 0 (trả NaN thay vì 0)
export function calculateTax(amount: number, rate: number): number {
  if (amount <= 0) return 0; // ← Corrective: fix edge case
  return legacyCalcTax(amount, rate);
}
```

**Go:**
```go
import legacy "nexus/src/legacy/tax"

// BUG: Legacy panic khi amount = 0
func CalculateTax(amount, rate float64) (float64, error) {
    if amount <= 0 {
        return 0, nil // Corrective: tránh panic
    }
    return legacy.CalculateTax(amount, rate)
}
```

**Python:**
```python
from src.legacy.tax import calculate_tax as legacy_calc_tax

# BUG: Legacy raise ZeroDivisionError khi rate = 0
def calculate_tax(amount: float, rate: float) -> float:
    if rate <= 0:
        return 0.0  # Corrective: fix edge case
    return legacy_calc_tax(amount, rate)
```

**PHP:**
```php
use App\Legacy\Tax\TaxCalculator;

// BUG: Legacy trả null khi amount = 0 thay vì 0.0
function calculateTax(float $amount, float $rate, TaxCalculator $legacy): float
{
    if ($amount <= 0) {
        return 0.0; // Corrective: fix edge case
    }
    return (float) $legacy->calculateTax($amount, $rate);
}
```

> **Mọi bug fix phải được document trong adapter README.md + ghi vào KB qua Librarian.**

---

## 5. Decision Matrix

| Tình huống | Pattern khuyến nghị |
|---|---|
| Thay thế dần module legacy | Strangler Fig + Feature Toggle |
| Legacy data model quá khác biệt | Anti-Corruption Layer |
| Nhiều callers, cần refactor từng bước | Branch by Abstraction |
| Logic critical (payment, auth) | Parallel Run |
| Cần rollback nhanh không deploy | Feature Toggle |
| Nhiều legacy modules → 1 API thống nhất | Facade Adapter |
| Bug trong legacy cần fix | Corrective Adapter |
| Legacy dùng callback/sync cũ | Async Wrapper |
| Legacy chỉ xử lý 1 item | Batch Wrapper |

---

## 6. Cấu trúc thư mục Adapter

```
/src/adapters/
  {legacy-module-name}/
    interface.ts        # {Domain}Port — contract cho Green Zone
    adapter.ts          # Legacy{Domain}Adapter — delegate xuống legacy
    adapter.test.ts     # Tests: contract compliance, parity, edge cases
    README.md           # Legacy docs, known bugs, migration status
```

**README.md adapter bắt buộc ghi:**
- Legacy module nào đang wrap + version/commit hash.
- Known quirks / bugs (cross-ref KB).
- Corrective fixes đã áp dụng.
- Migration status: `Active` | `Partial` | `Complete`.
- Next steps trong migration plan.
- Danh sách callers (output từ `get_impact_analysis`).
