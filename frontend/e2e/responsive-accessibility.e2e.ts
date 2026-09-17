import process from 'node:process';
import { URL } from 'node:url';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
} from '@playwright/test';

import { requireEnvironmentValue, validateLoopbackBaseUrl } from './support/runtime';

const MENU_ITEM_NAME = 'Roasted Root Vegetable Soup';
const UNAVAILABLE_MENU_ITEM_NAME = 'Warm Apple Cake';
const CART_IMAGE_ITEM_ID = '372b82fc-dd0c-465e-ae9a-7b585d03f7c7';
const CART_FALLBACK_ITEM_ID = '00000000-0000-4000-8000-000000000099';
const CART_FALLBACK_ITEM_NAME =
  'Nordic Forest Mushroom and Barley Bowl with Pickled Shallots';
const CART_IMAGE_PNG_PATH = '/images/menu/starters/Roasted-Root-Vegetable-Soup.png';
const CART_IMAGE_SIZES = '(min-width: 64rem) 7rem, (min-width: 40rem) 6rem, 5.5rem';
const CART_IMAGE_WEBP_480_PATH =
  '/images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-480w.webp';
const CART_IMAGE_WEBP_SRCSET =
  '/images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-480w.webp 480w, /images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-720w.webp 720w, /images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-1080w.webp 1080w';
const CART_STORAGE_KEY = 'restaurant-ordering:cart:v1';
const CRITICAL_RESOURCE_TYPES = new Set([
  'document',
  'fetch',
  'script',
  'stylesheet',
  'xhr',
]);
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:access|auth|capability|credential|password|secret|signature|token)/iu;
const STRIPE_HOST_PATTERN =
  /(?:^|\.)(?:stripe\.com|stripe\.dev|stripe\.network|stripeassets\.com|stripecdn\.com|stripepayments\.com)$/iu;
const VIEWPORTS = [
  { height: 812, label: 'mobile', width: 375 },
  { height: 1024, label: 'tablet', width: 768 },
  { height: 800, label: 'desktop', width: 1280 },
] as const;
const G1_CUSTOMER_VIEWPORTS = [
  {
    candidateWidth: 480,
    deviceScaleFactor: 1,
    height: 568,
    label: '200-percent-reflow-equivalent',
    width: 320,
  },
  {
    candidateWidth: 480,
    deviceScaleFactor: 1,
    height: 812,
    label: 'mobile',
    width: 375,
  },
  {
    candidateWidth: 1080,
    deviceScaleFactor: 2,
    height: 932,
    label: 'large-mobile-dpr2',
    width: 430,
  },
  {
    candidateWidth: 720,
    deviceScaleFactor: 1,
    height: 1024,
    label: 'tablet-portrait',
    width: 768,
  },
  {
    candidateWidth: 480,
    deviceScaleFactor: 1,
    height: 768,
    label: 'tablet-landscape',
    width: 1024,
  },
  {
    candidateWidth: 720,
    deviceScaleFactor: 1,
    height: 800,
    label: 'desktop',
    width: 1280,
  },
  {
    candidateWidth: 720,
    deviceScaleFactor: 1,
    height: 900,
    label: 'wide-desktop',
    width: 1440,
  },
] as const;
const G2_ADMIN_VIEWPORTS = G1_CUSTOMER_VIEWPORTS;
const LANDING_LOGO_PNG_PATH = '/images/brand/logo/nordic-hearth-logo.png';
const LANDING_LOGO_SIZES = '(min-width: 48rem) 18rem, min(72vw, 18rem)';
const LANDING_LOGO_WEBP_320_PATH =
  '/images/brand/optimized/logo/nordic-hearth-logo-320w.webp';
const LANDING_LOGO_WEBP_SRCSET =
  '/images/brand/optimized/logo/nordic-hearth-logo-320w.webp 320w, /images/brand/optimized/logo/nordic-hearth-logo-640w.webp 640w';
const LANDING_HERO_PNG_PATH = '/images/brand/hero/restaurant-hero.png';
const LANDING_HERO_SIZES =
  '(min-width: 76rem) calc(36rem - 1px), (min-width: 64rem) calc(50vw - 2rem - 1px), (min-width: 48rem) calc(100vw - 4rem - 2px), calc(100vw - 2rem - 2px)';
const LANDING_HERO_WEBP_SRCSET =
  '/images/brand/optimized/hero/restaurant-hero-640w.webp 640w, /images/brand/optimized/hero/restaurant-hero-1024w.webp 1024w, /images/brand/optimized/hero/restaurant-hero-1600w.webp 1600w';
const LANDING_STORY_PNG_PATH = '/images/brand/story/chef-plating-cod.png';
const LANDING_STORY_SIZES =
  '(min-width: 64rem) 28rem, (min-width: 48rem) 40vw, calc(100vw - 2rem)';
const LANDING_STORY_WEBP_640_PATH =
  '/images/brand/optimized/story/chef-plating-cod-640w.webp';
const LANDING_STORY_WEBP_SRCSET =
  '/images/brand/optimized/story/chef-plating-cod-640w.webp 640w, /images/brand/optimized/story/chef-plating-cod-1024w.webp 1024w';
const LANDING_VIEWPORTS = [
  { candidateWidth: 640, height: 568, label: 'compact-mobile', width: 320 },
  { candidateWidth: 640, height: 812, label: 'mobile', width: 375 },
  { candidateWidth: 1024, height: 1024, label: 'tablet', width: 768 },
  { candidateWidth: 640, height: 800, label: 'desktop', width: 1280 },
  { candidateWidth: 640, height: 900, label: 'wide-desktop', width: 1440 },
] as const;
const CART_VIEWPORTS = [
  { height: 812, label: 'mobile', width: 375 },
  { height: 1024, label: 'tablet', width: 768 },
  { height: 800, label: 'desktop', width: 1280 },
  { height: 900, label: 'wide-desktop', width: 1440 },
] as const;
const CHECKOUT_VIEWPORTS = [
  { height: 812, label: 'mobile', width: 375 },
  { height: 1024, label: 'tablet', width: 768 },
  { height: 800, label: 'desktop', width: 1280 },
  { height: 900, label: 'wide-desktop', width: 1440 },
] as const;

const AUTH_VIEWPORTS = CHECKOUT_VIEWPORTS;
const AUTH_LOGIN_API_PATH = '/api/v1/auth/login';
const AUTH_REGISTER_API_PATH = '/api/v1/auth/register';
const AUTH_ME_API_PATH = '/api/v1/auth/me';
const AUTH_MENU_API_PATH = '/api/v1/menu';
const AUTH_EMAIL = 'stage21-e1-customer@example.invalid';
const AUTH_PASSWORD = 'synthetic auth password';
const AUTH_TOKEN = 'synthetic.stage21.e1.token';
const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_VIEWPORTS = CHECKOUT_VIEWPORTS;
const ACCOUNT_AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
const ACCOUNT_ORDERS_API_PATH = '/api/v1/account/orders';
const ACCOUNT_EMAIL = 'stage21-e2a-customer@example.invalid';
const ACCOUNT_TOKEN = 'synthetic.stage21.e2a.token';
const ACCOUNT_USER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_HOME_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_HOME_EMAIL =
  'stage21-f1-operational-administrator-with-a-deliberately-long-identity@example.invalid';
const ADMIN_HOME_TOKEN = 'synthetic.stage21.f1.admin.token';
const ADMIN_HOME_USER_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_HOME_ORDERS_API_PATH = '/api/v1/admin/orders';
const ADMIN_HOME_MENU_API_PATH = '/api/v1/admin/menu/items';
const ADMIN_HOME_ANALYTICS_API_PATH = '/api/v1/admin/analytics/overview';
const ADMIN_ANALYTICS_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_ANALYTICS_EMAIL =
  'stage21-f4a-analytics-administrator-with-a-deliberately-long-identity@example.invalid';
const ADMIN_ANALYTICS_TOKEN = 'synthetic.stage21.f4a.admin.token';
const ADMIN_ANALYTICS_USER_ID = '77777777-7777-4777-8777-777777777777';
const ADMIN_ANALYTICS_API_ROOT = '/api/v1/admin/analytics';
const ADMIN_ANALYTICS_ENDPOINTS = [
  { key: 'overview', pathname: `${ADMIN_ANALYTICS_API_ROOT}/overview` },
  { key: 'products', pathname: `${ADMIN_ANALYTICS_API_ROOT}/products` },
  { key: 'categories', pathname: `${ADMIN_ANALYTICS_API_ROOT}/categories` },
  { key: 'order-types', pathname: `${ADMIN_ANALYTICS_API_ROOT}/order-types` },
] as const;
const ADMIN_ANALYTICS_LONG_PRODUCT_NAME =
  'NordicForestMushroomBarleyFeastWithPickledShallotsRoastedJuniperAndLingonberry'.repeat(
    2,
  );
const ADMIN_ANALYTICS_LONG_CATEGORY_NAME =
  'LateSummerFjordHarvestForOperationalReportingWithoutAnyHiddenTruncation'.repeat(2);
const ADMIN_ANALYTICS_FILTERED_PRODUCT_NAME =
  'Authoritative applied-range juniper and root vegetable supper';
const ADMIN_ANALYTICS_PRIVATE_RESPONSE_COPY =
  'private analytics contract detail must never reach administrator copy';
const ADMIN_EXPORTS_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_EXPORTS_EMAIL =
  'stage21-f4b-exports-administrator-with-a-deliberately-long-identity@example.invalid';
const ADMIN_EXPORTS_TOKEN = 'synthetic.stage21.f4b.admin.token';
const ADMIN_EXPORTS_USER_ID = '88888888-8888-4888-8888-888888888888';
const ADMIN_EXPORTS_API_ROOT = '/api/v1/admin/exports';
const ADMIN_EXPORTS_ENDPOINTS = [
  { kind: 'orders', pathname: `${ADMIN_EXPORTS_API_ROOT}/orders.csv` },
  { kind: 'product-sales', pathname: `${ADMIN_EXPORTS_API_ROOT}/product-sales.csv` },
  { kind: 'payments', pathname: `${ADMIN_EXPORTS_API_ROOT}/payments.csv` },
] as const;
const ADMIN_EXPORTS_LONG_FILENAME =
  'orders_20260801T000000Z_20260808T000000Z_completed_takeaway_NOK_nordic_hearth_export.csv';
const ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY =
  'private synthetic export failure detail must never reach administrator copy';
const ADMIN_EXPORTS_PRIMARY_RANGE = {
  end: '2026-08-08T00:00:00+02:00',
  endDate: '2026-08-07',
  start: '2026-08-01T00:00:00+02:00',
  startDate: '2026-08-01',
} as const;
const ADMIN_EXPORTS_SECONDARY_RANGE = {
  end: '2026-08-17T00:00:00+02:00',
  endDate: '2026-08-16',
  start: '2026-08-10T00:00:00+02:00',
  startDate: '2026-08-10',
} as const;
const ADMIN_USERS_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_USERS_API_PATH = '/api/v1/admin/users';
const ADMIN_USERS_CURRENT_EMAIL =
  'stage21-f3b-current-super-administrator@example.invalid';
const ADMIN_USERS_CUSTOMER_EMAIL =
  'stage21-f3b-customer-with-an-intentionally-long-unbroken-identity-for-wrapping@example.invalid';
const ADMIN_USERS_ADMIN_EMAIL = 'stage21-f3b-administrator@example.invalid';
const ADMIN_USERS_TOKEN = 'synthetic.stage21.f3b.super-admin.token';
const ADMIN_USERS_CURRENT_ID = '66666666-6666-4666-8666-666666666660';
const ADMIN_USERS_CUSTOMER_ID = '66666666-6666-4666-8666-666666666661';
const ADMIN_USERS_ADMIN_ID = '66666666-6666-4666-8666-666666666662';
const ACCOUNT_LONG_ORDER_NUMBER = 'ROA-ZZZZZZZZZZZZ';
const ACCOUNT_CANCELLED_ORDER_NUMBER = 'ROA-CCCCCCCCCCCC';
const ACCOUNT_ACTIVE_ORDER_NUMBER = 'ROA-PPPPPPPPPPPP';
const ACCOUNT_FINAL_ORDER_NUMBER = 'ROA-RRRRRRRRRRRR';
const ACCOUNT_DETAIL_ACCESS_ORDER_NUMBER = 'ROA-DDDDDDDDDDDD';
const ACCOUNT_DETAIL_RETRY_ORDER_NUMBER = 'ROA-EEEEEEEEEEEE';
const ACCOUNT_DETAIL_LONG_ITEM_NAME =
  'NordicForestMushroomBarleyFeastWithPickledShallotsRoastedJuniperAndLingonberry'.repeat(
    2,
  );
const ACCOUNT_DETAIL_SECOND_ITEM_NAME = 'Cloudberry Oat Cake';
const ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY =
  'private ownership and payment detail must never reach visible customer copy';
const CHECKOUT_PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const CHECKOUT_CAPABILITY =
  'synthetic-checkout-capability-kept-only-in-session-storage';
const CHECKOUT_ATTEMPT_ID = '00000000-0000-4000-8000-000000000004';
const CHECKOUT_ROUTE = `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/checkout`;
const CHECKOUT_ORDER_API_PATH = `/api/v1/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}`;
const CHECKOUT_SESSION_API_PATH = `${CHECKOUT_ORDER_API_PATH}/checkout-session`;
const CHECKOUT_PROVIDER_PATH = '/api/v1/e2e/fake-checkout';
const CHECKOUT_COMPLETION_PATH = '/api/v1/e2e/fake-checkout/complete';
const CHECKOUT_ACCESS_STORAGE_KEY = `restaurant-ordering:order-access:v1:${CHECKOUT_PUBLIC_ORDER_NUMBER}`;
const CHECKOUT_ATTEMPT_STORAGE_KEY = `restaurant-ordering:checkout-attempt:v1:${CHECKOUT_PUBLIC_ORDER_NUMBER}`;
const CHECKOUT_CTA_NAME = 'Continue to secure payment';
const CHECKOUT_LONG_ITEM_NAME =
  'Slow-Roasted Nordic Forest Mushroom and Barley Feast with Pickled Shallots';
const NEUTRAL_PAYMENT_PAGES = [
  {
    heading: 'You returned from secure checkout',
    kind: 'return',
    pathname: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/payment-return`,
    primaryActionName: 'View order status',
    primaryActionPath: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/status`,
    search: '?payment_status=succeeded&redirect_status=failed&payment=pending',
    secondaryActionName: 'Return to payment',
    secondaryActionPath: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/checkout`,
  },
  {
    heading: 'You left secure checkout',
    kind: 'cancelled',
    pathname: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/checkout-cancelled`,
    primaryActionName: 'Return to payment',
    primaryActionPath: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/checkout`,
    search: '?payment_status=failed&redirect_status=succeeded&charged=true',
    secondaryActionName: 'View order status',
    secondaryActionPath: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/status`,
  },
] as const;
const ORDER_STATUS_VIEWPORTS = CHECKOUT_VIEWPORTS;
const ORDER_STATUS_PUBLIC_ORDER_NUMBER = 'ROA-FFFFFFFFFFFF';
const ORDER_STATUS_CAPABILITY =
  'synthetic-order-status-capability-kept-only-in-session-storage';
const ORDER_STATUS_ROUTE = `/orders/${ORDER_STATUS_PUBLIC_ORDER_NUMBER}/status`;
const ORDER_STATUS_API_PATH = `/api/v1/orders/${ORDER_STATUS_PUBLIC_ORDER_NUMBER}`;
const ORDER_STATUS_ACCESS_STORAGE_KEY = `restaurant-ordering:order-access:v1:${ORDER_STATUS_PUBLIC_ORDER_NUMBER}`;
const ORDER_STATUS_LONG_ITEM_NAME =
  'NordicForestMushroomBarleyFeastWithPickledShallotsRoastedJuniperAndLingonberry'.repeat(
    2,
  );
const OVERFLOW_TOLERANCE_PX = 1;
const SAFE_SYNTHETIC_ENVIRONMENT_NAMES = new Set([
  'E2E_ADMIN_EMAIL',
  'E2E_ADMIN_PASSWORD',
]);
const baseOrigin = validateLoopbackBaseUrl(
  requireEnvironmentValue('E2E_BASE_URL', process.env),
);
const runId = requireEnvironmentValue('E2E_RUN_ID', process.env);

interface SyntheticIdentity {
  readonly email: string;
  readonly password: string;
}

interface SyntheticAuthRequest {
  readonly authorization: string | null;
  readonly postData: string | null;
}

interface SyntheticAuthController {
  controlled401Count: number;
  readonly loginRequests: SyntheticAuthRequest[];
  menuRequestCount: number;
  readonly meAuthorizations: (string | null)[];
  readonly networkIssues: string[];
  registrationRequestCount: number;
}

type SyntheticAccountMode = 'empty' | 'error' | 'paged' | 'single';

interface SyntheticAccountRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly mode: SyntheticAccountMode;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAccountController {
  readonly meAuthorizations: (string | null)[];
  mode: SyntheticAccountMode;
  readonly networkIssues: string[];
  readonly orderRequests: SyntheticAccountRequest[];
  retryResponseGate: Promise<void> | null;
}

type SyntheticAdminHomeMode = 'empty' | 'healthy' | 'partial';

interface SyntheticAdminHomeRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAdminHomeController {
  menuFailuresRemaining: number;
  menuRequestCount: number;
  readonly networkIssues: string[];
  nextMenuResponseGate: Promise<void> | null;
  readonly requests: SyntheticAdminHomeRequest[];
  mode: SyntheticAdminHomeMode;
}

type SyntheticAdminAnalyticsEndpoint =
  (typeof ADMIN_ANALYTICS_ENDPOINTS)[number]['key'];
type SyntheticAdminAnalyticsMode =
  'all-malformed' | 'healthy-filtered' | 'healthy-multi' | 'partial-products' | 'zero';

interface SyntheticAdminAnalyticsRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly currency: string | null;
  readonly end: string;
  readonly endpoint: SyntheticAdminAnalyticsEndpoint;
  readonly limit: number | null;
  readonly method: string;
  readonly mode: SyntheticAdminAnalyticsMode;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
  readonly start: string;
}

interface SyntheticAdminAnalyticsController {
  mode: SyntheticAdminAnalyticsMode;
  readonly networkIssues: string[];
  nextBatchResponseGate: Promise<void> | null;
  readonly requests: SyntheticAdminAnalyticsRequest[];
}

type SyntheticAdminExportKind = (typeof ADMIN_EXPORTS_ENDPOINTS)[number]['kind'];
type SyntheticAdminExportMode =
  | 'forbidden'
  | 'invalid-mime'
  | 'invalid-parameters'
  | 'server-error'
  | 'valid-fallback'
  | 'valid-safe';

interface SyntheticAdminExportRequest {
  readonly accept: string | null;
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly contentType: string | null;
  readonly currency: string | null;
  readonly end: string;
  readonly kind: SyntheticAdminExportKind;
  readonly method: string;
  readonly mode: SyntheticAdminExportMode;
  readonly orderStatus: string | null;
  readonly orderType: string | null;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
  readonly start: string;
}

interface SyntheticAdminExportsController {
  readonly modes: Record<SyntheticAdminExportKind, SyntheticAdminExportMode>;
  readonly networkIssues: string[];
  readonly requests: SyntheticAdminExportRequest[];
  readonly responseGates: Partial<
    Record<SyntheticAdminExportKind, Promise<void> | null>
  >;
}

type SyntheticAdminUsersMode = 'empty' | 'healthy' | 'malformed' | 'paged';
type SyntheticAdminUsersOrdinaryRole = 'admin' | 'customer';
type SyntheticAdminUsersFailureStatus = 403 | 409 | 422;

interface SyntheticAdminUsersRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAdminUsersController {
  authoritativeCustomerRole: SyntheticAdminUsersOrdinaryRole;
  failNextPatchStatus: SyntheticAdminUsersFailureStatus | null;
  mode: SyntheticAdminUsersMode;
  readonly networkIssues: string[];
  nextUsersResponseGate: Promise<void> | null;
  patchResponseGate: Promise<void> | null;
  readonly requests: SyntheticAdminUsersRequest[];
}

interface SyntheticAccountDetailRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAccountDetailController {
  readonly detailRequests: SyntheticAccountDetailRequest[];
  readonly meAuthorizations: (string | null)[];
  readonly networkIssues: string[];
  retryResponseGate: Promise<void> | null;
  retryRequestCount: number;
}

type SyntheticAccountDetailStatus = 'cancelled' | 'completed' | 'preparing';

interface SyntheticCartQuoteItem {
  readonly menu_item_id: string;
  readonly quantity: number;
}

interface SyntheticCartQuoteRequest {
  readonly items: readonly SyntheticCartQuoteItem[];
}

interface SyntheticCartFailureController {
  controlled503Count: number;
  failQuotes: boolean;
}

interface SyntheticCartOrderFailureController {
  readonly createBodies: string[];
  createResponseGate: Promise<void> | null;
}

interface BrowserEndpointAllowance {
  readonly method: string;
  readonly pathname: string;
}

interface BrowserHttpFailureAllowance extends BrowserEndpointAllowance {
  readonly search?: string;
  readonly status: number;
}

interface BrowserRequestFailureAllowance extends BrowserEndpointAllowance {
  readonly errorText: string;
  readonly maximumOccurrences: number;
  readonly resourceType: string;
}

interface TrackedBrowserRequestFailureAllowance extends BrowserRequestFailureAllowance {
  observedOccurrences: number;
}

type SyntheticOrderStatus = 'preparing' | 'ready' | 'cancelled';

interface SyntheticOrderStatusRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly postData: string | null;
}

interface SyntheticOrderStatusController {
  controlled503Count: number;
  failNext: boolean;
  readonly networkIssues: string[];
  readonly requests: SyntheticOrderStatusRequest[];
  status: SyntheticOrderStatus;
}

interface SyntheticCheckoutRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly idempotencyKey: string | null;
  readonly postData: string | null;
}

interface SyntheticCheckoutTrace {
  readonly checkoutRequests: SyntheticCheckoutRequest[];
  readonly networkIssues: string[];
  readonly observedLocalRequests: string[];
  readonly orderRequests: SyntheticCheckoutRequest[];
  readonly providerRequests: string[];
}

const SYNTHETIC_CHECKOUT_ORDER = Object.freeze({
  created_at: '2026-08-26T12:00:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 25_800,
      menu_item_id: CART_IMAGE_ITEM_ID,
      name: 'Roasted Root Vegetable Soup',
      quantity: 2,
      unit_price_amount: 12_900,
    },
    {
      line_total_amount: 15_900,
      menu_item_id: CART_FALLBACK_ITEM_ID,
      name: CHECKOUT_LONG_ITEM_NAME,
      quantity: 1,
      unit_price_amount: 15_900,
    },
  ],
  order_type: 'takeaway',
  public_order_number: CHECKOUT_PUBLIC_ORDER_NUMBER,
  status: 'created',
  subtotal_amount: 41_700,
  table_number: null,
  total_amount: 41_700,
  updated_at: '2026-08-26T12:00:01Z',
});

const SYNTHETIC_ACCOUNT_ORDERS = Object.freeze([
  Object.freeze({
    created_at: '2026-08-26T08:15:00Z',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: ACCOUNT_LONG_ORDER_NUMBER,
    status: 'completed',
    total_amount: 9_876_543,
    updated_at: '2026-08-26T09:05:00Z',
  }),
  Object.freeze({
    created_at: '2026-08-25T17:30:00Z',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: ACCOUNT_CANCELLED_ORDER_NUMBER,
    status: 'cancelled',
    total_amount: 25_500,
    updated_at: '2026-08-25T17:42:00Z',
  }),
  Object.freeze({
    created_at: '2026-08-24T11:45:00Z',
    currency: 'USD',
    order_type: 'takeaway',
    public_order_number: ACCOUNT_ACTIVE_ORDER_NUMBER,
    status: 'preparing',
    total_amount: 4_275,
    updated_at: '2026-08-24T11:51:00Z',
  }),
]);

const SYNTHETIC_ADMIN_HOME_ORDERS = Object.freeze([
  Object.freeze({
    created_at: '2026-08-27T10:00:00+02:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-23456789ABCD',
    status: 'created',
    table_number: 12,
    total_amount: 25_800,
    updated_at: '2026-08-27T10:01:00+02:00',
  }),
  Object.freeze({
    created_at: '2026-08-27T09:40:00+02:00',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: 'ROA-BCDEFGHJKLMN',
    status: 'accepted',
    table_number: null,
    total_amount: 15_900,
    updated_at: '2026-08-27T09:43:00+02:00',
  }),
  Object.freeze({
    created_at: '2026-08-27T09:20:00+02:00',
    currency: 'USD',
    order_type: 'takeaway',
    public_order_number: 'ROA-PQRSTUVWXYZ2',
    status: 'preparing',
    table_number: null,
    total_amount: 4_275,
    updated_at: '2026-08-27T09:31:00+02:00',
  }),
  Object.freeze({
    created_at: '2026-08-27T09:00:00+02:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-3456789ABCDE',
    status: 'ready',
    table_number: 4,
    total_amount: 9_876_543,
    updated_at: '2026-08-27T09:18:00+02:00',
  }),
  Object.freeze({
    created_at: '2026-08-27T08:30:00+02:00',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: 'ROA-CDEFGHJKLMNP',
    status: 'completed',
    table_number: null,
    total_amount: 19_900,
    updated_at: '2026-08-27T08:55:00+02:00',
  }),
  Object.freeze({
    created_at: '2026-08-27T08:00:00+02:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-QRSTUVWXYZ23',
    status: 'cancelled',
    table_number: 2,
    total_amount: 12_900,
    updated_at: '2026-08-27T08:04:00+02:00',
  }),
]);

const SYNTHETIC_ADMIN_HOME_MENU_ITEMS = Object.freeze([
  Object.freeze({
    allergens: [],
    category_id: '00000000-0000-4000-8000-000000000010',
    cost_amount: null,
    created_at: '2026-08-20T08:00:00+02:00',
    currency: 'NOK',
    description: null,
    display_order: 10,
    id: '00000000-0000-4000-8000-000000000011',
    image_url: null,
    is_active: true,
    is_available: true,
    name: 'Roasted root vegetable soup',
    price_amount: 12_900,
    updated_at: '2026-08-26T08:00:00+02:00',
  }),
  Object.freeze({
    allergens: [],
    category_id: '00000000-0000-4000-8000-000000000010',
    cost_amount: null,
    created_at: '2026-08-20T08:00:00+02:00',
    currency: 'NOK',
    description: null,
    display_order: 20,
    id: '00000000-0000-4000-8000-000000000012',
    image_url: null,
    is_active: true,
    is_available: false,
    name: 'Nordic seasonal plate',
    price_amount: 18_900,
    updated_at: '2026-08-26T08:00:00+02:00',
  }),
]);

const SYNTHETIC_ACCOUNT_FINAL_ORDER = Object.freeze({
  created_at: '2026-08-20T13:00:00Z',
  currency: 'NOK',
  order_type: 'dine_in',
  public_order_number: ACCOUNT_FINAL_ORDER_NUMBER,
  status: 'ready',
  total_amount: 19_900,
  updated_at: '2026-08-20T13:12:00Z',
});

const SYNTHETIC_ACCOUNT_DETAIL_ITEMS = Object.freeze([
  Object.freeze({
    line_total_amount: 25_800,
    menu_item_id: '00000000-0000-4000-8000-000000000081',
    name: ACCOUNT_DETAIL_LONG_ITEM_NAME,
    quantity: 2,
    unit_price_amount: 12_900,
  }),
  Object.freeze({
    line_total_amount: 15_900,
    menu_item_id: '00000000-0000-4000-8000-000000000082',
    name: ACCOUNT_DETAIL_SECOND_ITEM_NAME,
    quantity: 1,
    unit_price_amount: 15_900,
  }),
]);

const SYNTHETIC_CART_MENU = Object.freeze({
  categories: [
    {
      description: 'A synthetic category used only inside the isolated browser.',
      display_order: 10,
      id: '00000000-0000-4000-8000-000000000001',
      items: [
        {
          allergens: [],
          currency: 'NOK',
          description: 'Slow-roasted roots, herbs, and a calm Nordic finish.',
          display_order: 10,
          id: CART_IMAGE_ITEM_ID,
          image_url: null,
          is_available: true,
          name: MENU_ITEM_NAME,
          price_amount: 12_900,
        },
        {
          allergens: [],
          currency: 'NOK',
          description:
            'A deliberately long local-only name that exercises resilient wrapping.',
          display_order: 20,
          id: CART_FALLBACK_ITEM_ID,
          image_url: null,
          is_available: true,
          name: CART_FALLBACK_ITEM_NAME,
          price_amount: 15_900,
        },
      ],
      name: 'Synthetic cart dishes',
    },
  ],
});

const SYNTHETIC_CART_PRICE_BY_ID = new Map([
  [CART_IMAGE_ITEM_ID, 12_900],
  [CART_FALLBACK_ITEM_ID, 15_900],
]);

const SYNTHETIC_CART_NAME_BY_ID = new Map([
  [CART_IMAGE_ITEM_ID, MENU_ITEM_NAME],
  [CART_FALLBACK_ITEM_ID, CART_FALLBACK_ITEM_NAME],
]);

interface RuntimeBox {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface RuntimeElement {
  readonly clientHeight?: number;
  readonly currentSrc?: string;
  readonly naturalHeight?: number;
  readonly naturalWidth?: number;
  readonly disabled?: boolean;
  readonly parentElement: RuntimeElement | null;
  readonly previousElementSibling: RuntimeElement | null;
  readonly scrollHeight?: number;
  readonly scrollWidth?: number;
  scrollLeft?: number;
  readonly clientWidth?: number;
  readonly tagName: string;
  id?: string;
  textContent?: string | null;
  blur?: () => void;
  closest: (selector: string) => RuntimeElement | null;
  decode?: () => Promise<void>;
  focus?: () => void;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => RuntimeBox;
  querySelector: (selector: string) => RuntimeElement | null;
}

interface BrowserRuntime {
  readonly document: {
    readonly activeElement: RuntimeElement | null;
    readonly body: RuntimeElement & {
      append: (node: RuntimeElement) => void;
      readonly clientWidth: number;
      readonly scrollWidth: number;
    };
    createElement: (tagName: string) => RuntimeElement;
    readonly documentElement: RuntimeElement & {
      readonly clientWidth: number;
      readonly scrollWidth: number;
    };
    readonly fonts: {
      readonly ready: Promise<unknown>;
    };
    readonly scrollingElement:
      | (RuntimeElement & {
          readonly clientWidth: number;
          readonly scrollWidth: number;
        })
      | null;
    querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
  };
  getComputedStyle: (element: RuntimeElement) => {
    readonly animationDelay: string;
    readonly animationDuration: string;
    readonly animationIterationCount: string;
    readonly animationName: string;
    readonly backgroundColor: string;
    readonly borderLeftColor: string;
    readonly boxShadow: string;
    readonly color: string;
    readonly display: string;
    readonly opacity: string;
    readonly outlineOffset: string;
    readonly outlineStyle: string;
    readonly outlineWidth: string;
    readonly overflowWrap: string;
    readonly overflowX: string;
    readonly overflowY: string;
    readonly position: string;
    readonly scrollBehavior: string;
    readonly transform: string;
    readonly transitionDelay: string;
    readonly transitionDuration: string;
    readonly visibility: string;
    readonly wordBreak: string;
  };
  readonly innerWidth: number;
  matchMedia: (query: string) => { readonly matches: boolean };
  readonly scrollX: number;
  readonly scrollY: number;
  readonly location: {
    readonly hash: string;
    readonly pathname: string;
    readonly search: string;
  };
  requestAnimationFrame: (callback: () => void) => number;
  scrollTo: (x: number, y: number) => void;
}

interface OverflowBoxDiagnostic {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface OverflowElementDiagnostic {
  readonly box: OverflowBoxDiagnostic;
  readonly role: string | null;
  readonly selector: string;
}

interface OverflowScrollerDiagnostic {
  readonly box: Pick<OverflowBoxDiagnostic, 'left' | 'right' | 'width'>;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly selector: string;
}

interface OverflowSnapshot {
  readonly body: {
    readonly clientWidth: number;
    readonly delta: number;
    readonly scrollWidth: number;
  };
  readonly localTableOffenderCount: number;
  readonly localTableScrollers: readonly OverflowScrollerDiagnostic[];
  readonly nonLocalOffenderCount: number;
  readonly offenders: readonly OverflowElementDiagnostic[];
  readonly pathname: string;
  readonly scrollingElement: {
    readonly clientWidth: number;
    readonly delta: number;
    readonly maximumScrollX: number;
    readonly scrollWidth: number;
  };
  readonly viewportWidth: number;
}

function safeInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function requireSyntheticEnvironmentValue(name: string): string {
  if (!SAFE_SYNTHETIC_ENVIRONMENT_NAMES.has(name)) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_NAME_INVALID');
  }
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_VALUE_INVALID');
  }
  return value;
}

function loadAdministratorIdentity(): SyntheticIdentity {
  const email = requireSyntheticEnvironmentValue('E2E_ADMIN_EMAIL');
  const password = requireSyntheticEnvironmentValue('E2E_ADMIN_PASSWORD');
  if (email !== `stage18-admin-${runId}@example.com`) {
    throw new Error('E2E_ADMIN_EMAIL_INVALID');
  }
  const passwordLength = Array.from(password).length;
  if (passwordLength < 15 || passwordLength > 128) {
    throw new Error('E2E_ADMIN_PASSWORD_INVALID');
  }
  return Object.freeze({ email, password });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function isCriticalRequest(request: Request): boolean {
  return CRITICAL_RESOURCE_TYPES.has(request.resourceType());
}

function isForbiddenBrowserPath(pathname: string): boolean {
  return (
    pathname === '/api/v1/stripe/webhook' ||
    pathname.startsWith('/api/v1/e2e/') ||
    pathname === '/api/v1/admin/auth/login' ||
    pathname === '/api/v1/admin/auth/me' ||
    pathname.endsWith('/checkout-session')
  );
}

class BrowserSafetyGuard {
  private readonly allowedConsoleHttpFailures: ReadonlySet<string>;
  private readonly allowedForbiddenBrowserRequests: ReadonlySet<string>;
  private readonly allowedHttpFailures: ReadonlySet<string>;
  private readonly allowedRequestFailures: TrackedBrowserRequestFailureAllowance[];
  private readonly issues: string[] = [];

  constructor(
    page: Page,
    sensitiveValues: readonly string[],
    allowedForbiddenBrowserRequests: readonly BrowserEndpointAllowance[] = [],
    allowedHttpFailures: readonly BrowserHttpFailureAllowance[] = [],
    allowedRequestFailures: readonly BrowserRequestFailureAllowance[] = [],
  ) {
    this.allowedForbiddenBrowserRequests = new Set(
      allowedForbiddenBrowserRequests.map(
        ({ method, pathname }) => `${method.toUpperCase()} ${pathname}`,
      ),
    );
    this.allowedHttpFailures = new Set(
      allowedHttpFailures.map(
        ({ method, pathname, search, status }) =>
          `${method.toUpperCase()} ${pathname}${search ?? ''} ${status}`,
      ),
    );
    this.allowedConsoleHttpFailures = new Set(
      allowedHttpFailures.map(
        ({ pathname, search, status }) => `${pathname}${search ?? ''} ${status}`,
      ),
    );
    this.allowedRequestFailures = allowedRequestFailures.map((allowance) => ({
      ...allowance,
      method: allowance.method.toUpperCase(),
      observedOccurrences: 0,
    }));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !this.isAllowedHttpFailureConsoleMessage(message)
      ) {
        this.issues.push('console-error');
      }
    });
    page.on('pageerror', () => {
      this.issues.push('page-error');
    });
    page.on('popup', () => {
      this.issues.push('unexpected-popup');
    });
    page.on('request', (request) => {
      this.inspectRequest(request, sensitiveValues);
    });
    page.on('requestfailed', (request) => {
      this.inspectFailedRequest(request);
    });
    page.on('response', (response) => {
      this.inspectResponse(response);
    });
  }

  assertClean(): void {
    expect([...new Set(this.issues)], 'UNEXPECTED_BROWSER_RUNTIME_FAILURE').toEqual([]);
  }

  private isAllowedHttpFailureConsoleMessage(message: ConsoleMessage): boolean {
    const statusMatch =
      /^Failed to load resource: the server responded with a status of ([45][0-9]{2})(?: \([^\r\n]*\))?$/u.exec(
        message.text(),
      );
    const parsed = parseUrl(message.location().url);
    return (
      statusMatch !== null &&
      parsed !== null &&
      parsed.origin === baseOrigin &&
      this.allowedConsoleHttpFailures.has(
        `${parsed.pathname}${parsed.search} ${Number(statusMatch[1])}`,
      )
    );
  }

  private inspectRequest(request: Request, sensitiveValues: readonly string[]): void {
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      if (isCriticalRequest(request)) this.issues.push('critical-url-invalid');
      return;
    }

    if (STRIPE_HOST_PATTERN.test(parsed.hostname)) {
      this.issues.push('stripe-network-request');
    }
    if (parsed.origin !== baseOrigin && isCriticalRequest(request)) {
      this.issues.push('external-critical-request');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      this.issues.push('url-credentials-present');
    }
    if (
      [...parsed.searchParams.keys()].some((name) =>
        SENSITIVE_QUERY_NAME_PATTERN.test(name),
      ) ||
      sensitiveValues.some(
        (value) =>
          value.length > 0 &&
          (parsed.pathname.includes(value) || parsed.search.includes(value)),
      )
    ) {
      this.issues.push('sensitive-url-material');
    }
    if (
      parsed.origin === baseOrigin &&
      isForbiddenBrowserPath(parsed.pathname) &&
      (parsed.search !== '' ||
        !this.allowedForbiddenBrowserRequests.has(
          `${request.method().toUpperCase()} ${parsed.pathname}`,
        ))
    ) {
      this.issues.push('forbidden-browser-endpoint');
    }
  }

  private inspectFailedRequest(request: Request): void {
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      if (isCriticalRequest(request)) this.issues.push('critical-url-invalid');
      return;
    }
    if (parsed.origin !== baseOrigin || !isCriticalRequest(request)) {
      return;
    }

    const errorText = request.failure()?.errorText ?? 'REQUEST_FAILURE_UNKNOWN';
    const allowance =
      parsed.search === ''
        ? this.allowedRequestFailures.find(
            (candidate) =>
              candidate.observedOccurrences < candidate.maximumOccurrences &&
              candidate.method === request.method().toUpperCase() &&
              candidate.pathname === parsed.pathname &&
              candidate.resourceType === request.resourceType() &&
              candidate.errorText === errorText,
          )
        : undefined;
    if (allowance !== undefined) {
      allowance.observedOccurrences += 1;
      return;
    }

    this.issues.push(
      errorText === 'net::ERR_ABORTED'
        ? 'critical-request-failed:aborted'
        : 'critical-request-failed:other',
    );
  }

  private inspectResponse(response: Response): void {
    if (response.status() < 400) {
      return;
    }
    const parsed = parseUrl(response.url());
    const allowanceKey =
      parsed === null
        ? null
        : `${response.request().method().toUpperCase()} ${parsed.pathname}${parsed.search} ${response.status()}`;
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      (allowanceKey === null || !this.allowedHttpFailures.has(allowanceKey))
    ) {
      this.issues.push('unexpected-http-failure');
    }
  }
}

function waitForApiResponse(
  page: Page,
  method: string,
  pathname: string,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseUrl(response.url());
    return (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === pathname &&
      response.request().method() === method
    );
  });
}

function waitForAdminAnalyticsResponses(page: Page): readonly Promise<Response>[] {
  return ADMIN_ANALYTICS_ENDPOINTS.map(({ pathname }) =>
    waitForApiResponse(page, 'GET', pathname),
  );
}

async function assertAdminAnalyticsResponseStatuses(
  responsePromises: readonly Promise<Response>[],
  code: string,
): Promise<void> {
  const responses = await Promise.all(responsePromises);
  safeInvariant(
    responses.length === ADMIN_ANALYTICS_ENDPOINTS.length &&
      responses.every((response) => response.status() === 200),
    code,
  );
}

async function assertResponseStatus(
  responsePromise: Promise<Response>,
  expectedStatus: number,
  code: string,
): Promise<void> {
  const response = await responsePromise;
  safeInvariant(response.status() === expectedStatus, code);
}

async function assertLocation(page: Page, pathname: string): Promise<void> {
  await expect
    .poll(
      () => {
        const current = new URL(page.url());
        return { pathname: current.pathname, search: current.search };
      },
      { message: 'LOCATION_MISMATCH' },
    )
    .toEqual({ pathname, search: '' });
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    runtime.document.activeElement?.blur?.();
  });
}

async function assertVisibleKeyboardFocus(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const hasVisibleRing = await locator.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
    return (
      style.boxShadow !== 'none' ||
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px')
    );
  });
  safeInvariant(hasVisibleRing, 'VISIBLE_FOCUS_RING_MISSING');
}

async function tabTo(page: Page, target: Locator, maximumTabs = 24): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press('Tab');
    if (
      await target.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return (
          runtime.document.activeElement === (element as unknown as RuntimeElement)
        );
      })
    ) {
      return;
    }
  }
  throw new Error('KEYBOARD_TARGET_NOT_REACHED');
}

async function waitForSettledLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    await runtime.document.fonts.ready;
    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        runtime.requestAnimationFrame(() => resolve());
      });
    await waitForFrame();
    await waitForFrame();
  });
}

async function captureOverflowSnapshot(page: Page): Promise<OverflowSnapshot> {
  return page.evaluate((tolerance) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const root = runtime.document.scrollingElement ?? runtime.document.documentElement;
    const body = runtime.document.body;
    const originalScrollX = runtime.scrollX;
    const originalScrollY = runtime.scrollY;
    runtime.scrollTo(root.scrollWidth, originalScrollY);
    const maximumScrollX = runtime.scrollX;
    runtime.scrollTo(originalScrollX, originalScrollY);

    const safePathnames = new Set([
      '/',
      '/account',
      '/admin',
      '/admin/analytics',
      '/admin/orders',
      '/admin/users',
      '/cart',
      '/login',
      '/menu',
      '/register',
    ]);
    const safeRoles = new Set([
      'alert',
      'button',
      'complementary',
      'dialog',
      'form',
      'heading',
      'link',
      'list',
      'main',
      'navigation',
      'region',
      'status',
      'table',
    ]);
    const roundGeometry = (value: number) => Math.round(value * 100) / 100;
    const safeSelector = (element: RuntimeElement) => {
      const parts: string[] = [];
      let current: RuntimeElement | null = element;
      for (
        let depth = 0;
        depth < 5 && current !== null && current !== body;
        depth += 1
      ) {
        const tagName = current.tagName.toLowerCase();
        let position = 1;
        let sibling = current.previousElementSibling;
        while (sibling !== null) {
          if (sibling.tagName === current.tagName) position += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${tagName}:nth-of-type(${position})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const safeRole = (element: RuntimeElement) => {
      const role = element.getAttribute('role');
      return role !== null && safeRoles.has(role) ? role : null;
    };
    const boxDiagnostic = (box: RuntimeBox): OverflowBoxDiagnostic => ({
      bottom: roundGeometry(box.bottom),
      left: roundGeometry(box.left),
      right: roundGeometry(box.right),
      top: roundGeometry(box.top),
      width: roundGeometry(box.width),
    });
    const localScrollerFor = (element: RuntimeElement) => {
      const navigation = element.closest('nav');
      const categoryScroller =
        navigation?.getAttribute('aria-label') === 'Menu categories'
          ? navigation.querySelector('div')
          : null;
      const table = element.closest('table');
      const wrapper = categoryScroller ?? table?.parentElement ?? null;
      if (
        wrapper === null ||
        wrapper.clientWidth === undefined ||
        wrapper.scrollWidth === undefined
      ) {
        return null;
      }
      const style = runtime.getComputedStyle(wrapper);
      const box = wrapper.getBoundingClientRect();
      const bounded =
        box.left >= -tolerance && box.right <= runtime.innerWidth + tolerance;
      const scrollable =
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        wrapper.scrollWidth > wrapper.clientWidth + tolerance;
      return bounded && scrollable ? wrapper : null;
    };

    const offenders: OverflowElementDiagnostic[] = [];
    const localTableScrollers: OverflowScrollerDiagnostic[] = [];
    const recordedScrollers = new Set<RuntimeElement>();
    let localTableOffenderCount = 0;
    let nonLocalOffenderCount = 0;

    for (const element of runtime.document.querySelectorAll('body *')) {
      const style = runtime.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const rendered =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        Number.isFinite(box.left) &&
        Number.isFinite(box.right) &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0;
      const exceedsViewport =
        box.left < -tolerance || box.right > runtime.innerWidth + tolerance;
      if (!rendered || !exceedsViewport) continue;

      const localScroller = localScrollerFor(element);
      if (localScroller !== null) {
        localTableOffenderCount += 1;
        if (!recordedScrollers.has(localScroller) && localTableScrollers.length < 5) {
          recordedScrollers.add(localScroller);
          const scrollerBox = localScroller.getBoundingClientRect();
          localTableScrollers.push({
            box: {
              left: roundGeometry(scrollerBox.left),
              right: roundGeometry(scrollerBox.right),
              width: roundGeometry(scrollerBox.width),
            },
            clientWidth: localScroller.clientWidth ?? 0,
            scrollWidth: localScroller.scrollWidth ?? 0,
            selector: safeSelector(localScroller),
          });
        }
        continue;
      }

      nonLocalOffenderCount += 1;
      if (offenders.length < 8) {
        offenders.push({
          box: boxDiagnostic(box),
          role: safeRole(element),
          selector: safeSelector(element),
        });
      }
    }

    const pathname = safePathnames.has(runtime.location.pathname)
      ? runtime.location.pathname
      : 'unrecognized';
    const rootDelta = Math.max(0, root.scrollWidth - root.clientWidth);
    const bodyDelta = Math.max(0, body.scrollWidth - body.clientWidth);
    return {
      body: {
        clientWidth: body.clientWidth,
        delta: bodyDelta,
        scrollWidth: body.scrollWidth,
      },
      localTableOffenderCount,
      localTableScrollers,
      nonLocalOffenderCount,
      offenders,
      pathname,
      scrollingElement: {
        clientWidth: root.clientWidth,
        delta: rootDelta,
        maximumScrollX,
        scrollWidth: root.scrollWidth,
      },
      viewportWidth: runtime.innerWidth,
    };
  }, OVERFLOW_TOLERANCE_PX);
}

function stableOverflowSignature(snapshot: OverflowSnapshot): string {
  return JSON.stringify(snapshot);
}

function safeOverflowDiagnostics(snapshot: OverflowSnapshot): string {
  return JSON.stringify(snapshot);
}

async function captureStableOverflowSnapshot(page: Page): Promise<OverflowSnapshot> {
  await waitForSettledLayout(page);
  let previous = await captureOverflowSnapshot(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const runtime = globalThis as typeof globalThis & BrowserRuntime;
          runtime.requestAnimationFrame(() => resolve());
        }),
    );
    const current = await captureOverflowSnapshot(page);
    if (stableOverflowSignature(previous) === stableOverflowSignature(current)) {
      return current;
    }
    previous = current;
  }
  throw new Error(`RESPONSIVE_LAYOUT_UNSTABLE ${safeOverflowDiagnostics(previous)}`);
}

async function assertNoMaterialOverflow(page: Page): Promise<void> {
  const snapshot = await captureStableOverflowSnapshot(page);
  const pageCanScrollHorizontally =
    snapshot.scrollingElement.delta > OVERFLOW_TOLERANCE_PX ||
    snapshot.scrollingElement.maximumScrollX > OVERFLOW_TOLERANCE_PX;
  if (pageCanScrollHorizontally || snapshot.nonLocalOffenderCount > 0) {
    throw new Error(
      `MATERIAL_HORIZONTAL_OVERFLOW ${safeOverflowDiagnostics(snapshot)}`,
    );
  }
}

async function assertVisibleControlsWithinViewport(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const controls = Array.from(
      runtime.document.querySelectorAll(
        'a, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ),
    );
    let visibleCount = 0;
    for (const control of controls) {
      const style = runtime.getComputedStyle(control);
      const box = control.getBoundingClientRect();
      const navigation = control.closest('nav');
      const categoryScroller =
        navigation?.getAttribute('aria-label') === 'Menu categories'
          ? navigation.querySelector('div')
          : null;
      const categoryScrollerStyle =
        categoryScroller === null ? null : runtime.getComputedStyle(categoryScroller);
      const categoryScrollerBox = categoryScroller?.getBoundingClientRect();
      const locallyScrollableCategoryControl =
        categoryScroller !== null &&
        categoryScrollerStyle !== null &&
        categoryScrollerBox !== undefined &&
        categoryScroller.scrollWidth !== undefined &&
        categoryScroller.clientWidth !== undefined &&
        categoryScrollerBox.left >= -1 &&
        categoryScrollerBox.right <= runtime.innerWidth + 1 &&
        (categoryScrollerStyle.overflowX === 'auto' ||
          categoryScrollerStyle.overflowX === 'scroll') &&
        categoryScroller.scrollWidth > categoryScroller.clientWidth + 1;
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < Number.POSITIVE_INFINITY;
      if (
        !visible ||
        box.top < 0 ||
        control.closest('table') !== null ||
        locallyScrollableCategoryControl
      ) {
        continue;
      }
      visibleCount += 1;
      if (box.left < -1 || box.right > runtime.innerWidth + 1) {
        return { bounded: false, visibleCount };
      }
    }
    return { bounded: true, visibleCount };
  });
  safeInvariant(result.visibleCount > 0, 'VISIBLE_CONTROL_SET_EMPTY');
  safeInvariant(result.bounded, 'CRITICAL_CONTROL_CLIPPED');
}

async function assertResponsiveSurface(page: Page): Promise<void> {
  await assertNoMaterialOverflow(page);
  await assertVisibleControlsWithinViewport(page);
}

async function assertCategoryNavigationReachable(page: Page): Promise<void> {
  const navigation = page.getByRole('navigation', { name: 'Menu categories' });
  const lastCategory = navigation.getByRole('button').last();
  await expect(lastCategory).toBeVisible();
  await blurActiveElement(page);
  await tabTo(page, lastCategory);
  await assertVisibleKeyboardFocus(lastCategory);

  const result = await lastCategory.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const control = element as unknown as RuntimeElement;
    const scroller = control.parentElement;
    if (
      scroller === null ||
      scroller.scrollWidth === undefined ||
      scroller.clientWidth === undefined
    ) {
      return { configured: false, fullyVisible: false };
    }
    const scrollWidth = scroller.scrollWidth;
    const clientWidth = scroller.clientWidth;
    const style = runtime.getComputedStyle(scroller);
    const scrollerBox = scroller.getBoundingClientRect();
    const controlBox = control.getBoundingClientRect();
    const bounded =
      scrollerBox.left >= -1 && scrollerBox.right <= runtime.innerWidth + 1;
    const fits = scrollWidth <= clientWidth + 1;
    const scrollable =
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      scrollWidth > clientWidth + 1;
    return {
      configured: bounded && (fits || scrollable),
      fullyVisible:
        controlBox.left >= scrollerBox.left - 1 &&
        controlBox.right <= scrollerBox.right + 1,
    };
  });
  safeInvariant(result.configured, 'CATEGORY_SCROLLER_CONTRACT_MISSING');
  safeInvariant(result.fullyVisible, 'CATEGORY_FOCUS_CLIPPED');
}

async function assertTableReachable(table: Locator): Promise<void> {
  const wrapper = table.locator('..');
  await expect(wrapper).toBeVisible();
  const result = await wrapper.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const scrollContainer = element as unknown as RuntimeElement;
    const tableElement = scrollContainer.querySelector('table');
    const lastCell = tableElement?.querySelector('tbody tr > *:last-child');
    if (
      tableElement === null ||
      lastCell === null ||
      lastCell === undefined ||
      scrollContainer.scrollWidth === undefined ||
      scrollContainer.clientWidth === undefined
    ) {
      return { overflowAllowed: false, reachable: false };
    }
    const style = runtime.getComputedStyle(scrollContainer);
    const maximumScroll = Math.max(
      0,
      scrollContainer.scrollWidth - scrollContainer.clientWidth,
    );
    scrollContainer.scrollLeft = maximumScroll;
    const wrapperBox = scrollContainer.getBoundingClientRect();
    const lastCellBox = lastCell.getBoundingClientRect();
    const reachable =
      lastCellBox.right >= wrapperBox.left - 1 &&
      lastCellBox.left <= wrapperBox.right + 1;
    scrollContainer.scrollLeft = 0;
    const overflowAllowed = style.overflowX === 'auto' || style.overflowX === 'scroll';
    const fits = scrollContainer.scrollWidth <= scrollContainer.clientWidth + 1;
    return { configured: fits || overflowAllowed, reachable };
  });
  safeInvariant(result.configured, 'TABLE_SCROLL_CONTRACT_MISSING');
  safeInvariant(result.reachable, 'TABLE_FINAL_COLUMN_UNREACHABLE');
}

async function assertCollectionLayout(
  page: Page,
  accessibleName: string,
  viewportWidth: number,
): Promise<void> {
  const cards = page.getByRole('list', { name: accessibleName });
  const table = page.getByRole('table', { name: accessibleName });
  if (viewportWidth < 1024) {
    await expect(cards).toBeVisible();
    await expect(table).toBeHidden();
    const cardsFit = await cards.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const box = (element as unknown as RuntimeElement).getBoundingClientRect();
      return box.left >= -1 && box.right <= runtime.innerWidth + 1;
    });
    safeInvariant(cardsFit, 'RESPONSIVE_CARD_COLLECTION_CLIPPED');
    return;
  }
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await assertTableReachable(table);
}

async function assertAccountCollectionLayout(page: Page): Promise<Locator> {
  const accessibleName = 'Your orders, newest first';
  const orders = page.getByRole('list', { name: accessibleName });
  await expect(orders).toBeVisible();
  await expect(page.getByRole('table', { name: accessibleName })).toHaveCount(0);
  const fitsViewport = await orders.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const box = (element as unknown as RuntimeElement).getBoundingClientRect();
    return box.left >= -1 && box.right <= runtime.innerWidth + 1;
  });
  safeInvariant(fitsViewport, 'ACCOUNT_ORDER_COLLECTION_CLIPPED');
  return orders;
}

async function assertLongTextWraps(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const wrapsSafely = await locator.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const node = element as unknown as RuntimeElement;
    const style = runtime.getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return (
      (style.overflowWrap === 'anywhere' ||
        style.wordBreak === 'break-word' ||
        style.wordBreak === 'anywhere') &&
      box.left >= -1 &&
      box.right <= runtime.innerWidth + 1
    );
  });
  safeInvariant(wrapsSafely, 'LONG_TEXT_WRAP_CONTRACT_MISSING');
}

async function assertTextNotClipped(locator: Locator, code: string): Promise<void> {
  await expect(locator).toBeVisible();
  const fits = await locator.evaluate((element, tolerance) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const node = element as unknown as RuntimeElement;
    if (
      node.clientWidth === undefined ||
      node.scrollWidth === undefined ||
      node.clientHeight === undefined ||
      node.scrollHeight === undefined
    ) {
      return false;
    }

    const nodeBox = node.getBoundingClientRect();
    const overflowWidth = Math.max(0, node.scrollWidth - node.clientWidth);
    const overflowHeight = Math.max(0, node.scrollHeight - node.clientHeight);
    const isClipping = (overflow: string) =>
      overflow === 'auto' ||
      overflow === 'clip' ||
      overflow === 'hidden' ||
      overflow === 'scroll';
    const nodeStyle = runtime.getComputedStyle(node);
    if (
      (isClipping(nodeStyle.overflowX) && overflowWidth > tolerance) ||
      (isClipping(nodeStyle.overflowY) && overflowHeight > tolerance)
    ) {
      return false;
    }

    let ancestor = node.parentElement;
    while (ancestor !== null) {
      const ancestorStyle = runtime.getComputedStyle(ancestor);
      const ancestorBox = ancestor.getBoundingClientRect();
      if (
        isClipping(ancestorStyle.overflowX) &&
        (nodeBox.left - overflowWidth < ancestorBox.left - tolerance ||
          nodeBox.right + overflowWidth > ancestorBox.right + tolerance)
      ) {
        return false;
      }
      if (
        isClipping(ancestorStyle.overflowY) &&
        (nodeBox.top - overflowHeight < ancestorBox.top - tolerance ||
          nodeBox.bottom + overflowHeight > ancestorBox.bottom + tolerance)
      ) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    return true;
  }, OVERFLOW_TOLERANCE_PX);
  safeInvariant(fits, code);
}

async function assertContainedWithin(
  locator: Locator,
  container: Locator,
  code: string,
): Promise<void> {
  const [box, containerBox] = await Promise.all([
    locator.boundingBox(),
    container.boundingBox(),
  ]);
  safeInvariant(box !== null && containerBox !== null, code);
  safeInvariant(
    box.x >= containerBox.x - OVERFLOW_TOLERANCE_PX &&
      box.y >= containerBox.y - OVERFLOW_TOLERANCE_PX &&
      box.x + box.width <=
        containerBox.x + containerBox.width + OVERFLOW_TOLERANCE_PX &&
      box.y + box.height <=
        containerBox.y + containerBox.height + OVERFLOW_TOLERANCE_PX,
    code,
  );
}

async function assertNoFixedOrStickyOverlap(
  locator: Locator,
  code: string,
): Promise<void> {
  await expect(locator).toBeVisible();
  const hasOverlap = await locator.evaluate((element, tolerance) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const target = element as unknown as RuntimeElement & {
      contains: (candidate: RuntimeElement) => boolean;
    };
    const targetBox = target.getBoundingClientRect();
    for (const candidate of runtime.document.querySelectorAll('body *')) {
      if (candidate === target) continue;
      const candidateWithContains = candidate as RuntimeElement & {
        contains: (node: RuntimeElement) => boolean;
      };
      if (target.contains(candidate) || candidateWithContains.contains(target)) {
        continue;
      }
      const style = runtime.getComputedStyle(candidate);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const box = candidate.getBoundingClientRect();
      const rendered =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        box.width > 0 &&
        box.height > 0;
      const overlapWidth =
        Math.min(targetBox.right, box.right) - Math.max(targetBox.left, box.left);
      const overlapHeight =
        Math.min(targetBox.bottom, box.bottom) - Math.max(targetBox.top, box.top);
      if (rendered && overlapWidth > tolerance && overlapHeight > tolerance) {
        return true;
      }
    }
    return false;
  }, OVERFLOW_TOLERANCE_PX);
  safeInvariant(!hasOverlap, code);
}

function isSyntheticCartQuoteRequest(
  value: unknown,
): value is SyntheticCartQuoteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.items)) {
    return false;
  }
  return record.items.every((candidate) => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const item = candidate as Record<string, unknown>;
    return (
      Object.keys(item).length === 2 &&
      typeof item.menu_item_id === 'string' &&
      SYNTHETIC_CART_PRICE_BY_ID.has(item.menu_item_id) &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity >= 1 &&
      item.quantity <= 99
    );
  });
}

function captureSyntheticAuthRequest(request: Request): SyntheticAuthRequest {
  return {
    authorization: request.headers().authorization ?? null,
    postData: request.postData(),
  };
}

async function installSyntheticAuthRouting(
  page: Page,
  controller: SyntheticAuthController,
  firstLoginResponseGate: Promise<void>,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('auth-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(`auth-external-request:${parsed.hostname}`);
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_LOGIN_API_PATH &&
      parsed.search === '' &&
      method === 'POST'
    ) {
      controller.loginRequests.push(captureSyntheticAuthRequest(request));
      if (controller.loginRequests.length === 1) {
        await firstLoginResponseGate;
        controller.controlled401Count += 1;
        await route.fulfill({
          body: JSON.stringify({ detail: 'private synthetic authentication detail' }),
          contentType: 'application/json',
          status: 401,
        });
        return;
      }
      if (controller.loginRequests.length === 2) {
        await route.fulfill({
          body: JSON.stringify({
            access_token: AUTH_TOKEN,
            expires_in: 900,
            token_type: 'bearer',
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      controller.networkIssues.push('auth-duplicate-login-request');
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic login request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.meAuthorizations.push(request.headers().authorization ?? null);
      await route.fulfill({
        body: JSON.stringify({
          email: AUTH_EMAIL,
          id: AUTH_USER_ID,
          is_active: true,
          role: 'customer',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      parsed.pathname === AUTH_MENU_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.menuRequestCount += 1;
      await route.fulfill({
        body: JSON.stringify({ categories: [] }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      parsed.pathname === AUTH_REGISTER_API_PATH &&
      parsed.search === '' &&
      method === 'POST'
    ) {
      controller.registrationRequestCount += 1;
      await route.fulfill({
        body: JSON.stringify({ detail: 'private synthetic registration detail' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(`auth-unexpected-api:${method}:${parsed.pathname}`);
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function captureSyntheticAccountRequest(
  request: Request,
  mode: SyntheticAccountMode,
  search: string,
): SyntheticAccountRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    method: request.method(),
    mode,
    postData: request.postData(),
    search,
  };
}

function syntheticAccountPage(
  items: readonly unknown[],
  offset: number,
  total: number,
) {
  return { items, limit: 50, offset, total };
}

async function installSyntheticAccountRouting(
  page: Page,
  controller: SyntheticAccountController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('account-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(`account-external-request:${parsed.hostname}`);
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.meAuthorizations.push(request.headers().authorization ?? null);
      await route.fulfill({
        body: JSON.stringify({
          email: ACCOUNT_EMAIL,
          id: ACCOUNT_USER_ID,
          is_active: true,
          role: 'customer',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ACCOUNT_ORDERS_API_PATH && method === 'GET') {
      const mode = controller.mode;
      controller.orderRequests.push(
        captureSyntheticAccountRequest(request, mode, parsed.search),
      );
      const offset =
        parsed.search === '?limit=50&offset=0'
          ? 0
          : parsed.search === '?limit=50&offset=50'
            ? 50
            : null;
      if (offset === null) {
        controller.networkIssues.push(`account-query-invalid:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic account query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }

      if (mode === 'error') {
        await route.fulfill({
          body: JSON.stringify({
            ...syntheticAccountPage([], 0, 0),
            private_contract_detail: 'must never reach visible customer copy',
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }

      if (mode === 'paged') {
        if (offset === 0) {
          const retryResponseGate = controller.retryResponseGate;
          controller.retryResponseGate = null;
          if (retryResponseGate !== null) {
            await retryResponseGate;
          }
          await route.fulfill({
            body: JSON.stringify(syntheticAccountPage(SYNTHETIC_ACCOUNT_ORDERS, 0, 51)),
            contentType: 'application/json',
            status: 200,
          });
          return;
        }
        await route.fulfill({
          body: JSON.stringify(
            syntheticAccountPage([SYNTHETIC_ACCOUNT_FINAL_ORDER], 50, 51),
          ),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }

      if (offset !== 0) {
        controller.networkIssues.push(`account-mode-offset-invalid:${mode}:${offset}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic account page' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }

      await route.fulfill({
        body: JSON.stringify(
          mode === 'single'
            ? syntheticAccountPage([SYNTHETIC_ACCOUNT_FINAL_ORDER], 0, 1)
            : syntheticAccountPage([], 0, 0),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `account-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function captureSyntheticAdminHomeRequest(
  request: Request,
  parsed: URL,
): SyntheticAdminHomeRequest {
  return {
    authorization: request.headers().authorization ?? null,
    capability: request.headers()['x-order-access-token'] ?? null,
    method: request.method(),
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
  };
}

function syntheticAdminHomeOrders(mode: SyntheticAdminHomeMode) {
  return {
    items: mode === 'empty' ? [] : SYNTHETIC_ADMIN_HOME_ORDERS,
    limit: 6,
    offset: 0,
    total: mode === 'empty' ? 0 : 42,
  };
}

function syntheticAdminHomeMenu(mode: SyntheticAdminHomeMode, makeAvailable = false) {
  if (mode === 'empty') {
    return { items: [], limit: 100, offset: 0, total: 0 };
  }
  const items = makeAvailable
    ? SYNTHETIC_ADMIN_HOME_MENU_ITEMS.map((item) => ({
        ...item,
        is_available: true,
      }))
    : SYNTHETIC_ADMIN_HOME_MENU_ITEMS;
  return { items, limit: 100, offset: 0, total: items.length };
}

function syntheticAdminHomeAnalytics(
  mode: SyntheticAdminHomeMode,
  start: string,
  end: string,
) {
  return {
    currencies:
      mode === 'empty'
        ? []
        : [
            {
              average_order_value_amount: 18_450,
              collected_revenue_amount: 73_800,
              currency: 'NOK',
              succeeded_orders_count: 4,
            },
            {
              average_order_value_amount: 2_138,
              collected_revenue_amount: 4_275,
              currency: 'USD',
              succeeded_orders_count: 1,
            },
          ],
    range: { end, start, timezone: 'Europe/Oslo' },
  };
}

async function installSyntheticAdminHomeRouting(
  page: Page,
  controller: SyntheticAdminHomeController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-home-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(`admin-home-external-request:${parsed.hostname}`);
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.requests.push(captureSyntheticAdminHomeRequest(request, parsed));
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_HOME_EMAIL,
          id: ADMIN_HOME_USER_ID,
          is_active: true,
          role: 'super_admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_HOME_ORDERS_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminHomeRequest(request, parsed));
      if (parsed.search !== '?limit=6&offset=0') {
        controller.networkIssues.push(`admin-home-orders-query:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic orders query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(syntheticAdminHomeOrders(controller.mode)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_HOME_MENU_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminHomeRequest(request, parsed));
      controller.menuRequestCount += 1;
      if (parsed.search !== '?limit=100&offset=0') {
        controller.networkIssues.push(`admin-home-menu-query:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic menu query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      const menuResponseGate = controller.nextMenuResponseGate;
      controller.nextMenuResponseGate = null;
      if (menuResponseGate !== null) await menuResponseGate;
      const forcedFailure = controller.menuFailuresRemaining > 0;
      if (forcedFailure) controller.menuFailuresRemaining -= 1;
      if (
        forcedFailure ||
        (controller.mode === 'partial' && controller.menuRequestCount === 1)
      ) {
        await route.fulfill({
          body: JSON.stringify({
            items: [],
            private_contract_detail: 'must never reach administrator copy',
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(
          syntheticAdminHomeMenu(controller.mode, controller.mode === 'partial'),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_HOME_ANALYTICS_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminHomeRequest(request, parsed));
      const start = parsed.searchParams.get('start');
      const end = parsed.searchParams.get('end');
      const keys = [...parsed.searchParams.keys()].sort();
      if (
        start === null ||
        end === null ||
        keys.length !== 2 ||
        keys[0] !== 'end' ||
        keys[1] !== 'start'
      ) {
        controller.networkIssues.push(`admin-home-analytics-query:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic analytics query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(syntheticAdminHomeAnalytics(controller.mode, start, end)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `admin-home-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic admin-home request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function parseSyntheticAdminAnalyticsRequest(
  request: Request,
  parsed: URL,
  endpoint: SyntheticAdminAnalyticsEndpoint,
  mode: SyntheticAdminAnalyticsMode,
): SyntheticAdminAnalyticsRequest | null {
  const isBreakdown = endpoint === 'products' || endpoint === 'categories';
  const parameterNames = [...parsed.searchParams.keys()].sort();
  const expectedNames = [
    'end',
    ...(parsed.searchParams.has('currency') ? ['currency'] : []),
    ...(isBreakdown ? ['limit'] : []),
    'start',
  ].sort();
  if (
    parameterNames.length !== expectedNames.length ||
    parameterNames.some((name, index) => name !== expectedNames[index])
  ) {
    return null;
  }

  const start = parsed.searchParams.get('start');
  const end = parsed.searchParams.get('end');
  const currency = parsed.searchParams.get('currency');
  const rawLimit = parsed.searchParams.get('limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  const awareTimestampPattern = /(?:Z|[+-]\d{2}:\d{2})$/u;
  if (
    start === null ||
    end === null ||
    !awareTimestampPattern.test(start) ||
    !awareTimestampPattern.test(end) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end) ||
    (currency !== null && !/^[A-Z]{3}$/u.test(currency)) ||
    (isBreakdown &&
      (limit === null ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        rawLimit !== String(limit))) ||
    (!isBreakdown && limit !== null)
  ) {
    return null;
  }

  return {
    authorization: request.headers().authorization ?? null,
    capability: request.headers()['x-order-access-token'] ?? null,
    currency,
    end,
    endpoint,
    limit,
    method: request.method(),
    mode,
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
    start,
  };
}

function syntheticAdminAnalyticsRange(request: SyntheticAdminAnalyticsRequest) {
  return {
    end: request.end,
    start: request.start,
    timezone: 'Europe/Oslo',
  };
}

function syntheticAdminAnalyticsCurrencies(request: SyntheticAdminAnalyticsRequest) {
  if (request.mode === 'zero') return [];
  const rows =
    request.mode === 'healthy-filtered'
      ? [
          {
            average_order_value_amount: 184_500,
            collected_revenue_amount: 7_380_000,
            currency: 'NOK',
            succeeded_orders_count: 40,
          },
        ]
      : request.mode === 'partial-products'
        ? [
            {
              average_order_value_amount: 303_027,
              collected_revenue_amount: 9_999_900,
              currency: 'NOK',
              succeeded_orders_count: 33,
            },
            {
              average_order_value_amount: 2_138,
              collected_revenue_amount: 8_550,
              currency: 'USD',
              succeeded_orders_count: 4,
            },
          ]
        : [
            {
              average_order_value_amount: 257_200,
              collected_revenue_amount: 12_345_600,
              currency: 'NOK',
              succeeded_orders_count: 48,
            },
            {
              average_order_value_amount: 2_138,
              collected_revenue_amount: 42_750,
              currency: 'USD',
              succeeded_orders_count: 20,
            },
          ];
  return request.currency === null
    ? rows
    : rows.filter(({ currency }) => currency === request.currency);
}

function syntheticAdminAnalyticsProducts(request: SyntheticAdminAnalyticsRequest) {
  if (request.mode === 'zero') return [];
  const rows =
    request.mode === 'healthy-filtered'
      ? [
          {
            currency: 'NOK',
            item_name: ADMIN_ANALYTICS_FILTERED_PRODUCT_NAME,
            menu_item_id: '77777777-7777-4777-8777-777777777703',
            quantity_sold: 7,
            sales_amount: 1_234_500,
          },
        ]
      : [
          {
            currency: 'NOK',
            item_name: ADMIN_ANALYTICS_LONG_PRODUCT_NAME,
            menu_item_id: '77777777-7777-4777-8777-777777777701',
            quantity_sold: 31,
            sales_amount: 8_765_400,
          },
          {
            currency: 'USD',
            item_name: 'Cloudberry oat cake',
            menu_item_id: '77777777-7777-4777-8777-777777777702',
            quantity_sold: 20,
            sales_amount: 42_750,
          },
        ];
  return request.currency === null
    ? rows
    : rows.filter(({ currency }) => currency === request.currency);
}

function syntheticAdminAnalyticsCategories(request: SyntheticAdminAnalyticsRequest) {
  if (request.mode === 'zero') return [];
  const rows =
    request.mode === 'healthy-filtered'
      ? [
          {
            category_name: 'Applied range seasonal suppers',
            currency: 'NOK',
            quantity_sold: 7,
            sales_amount: 1_234_500,
          },
        ]
      : request.mode === 'partial-products'
        ? [
            {
              category_name: 'Partially refreshed authoritative category',
              currency: 'NOK',
              quantity_sold: 33,
              sales_amount: 9_999_900,
            },
          ]
        : [
            {
              category_name: ADMIN_ANALYTICS_LONG_CATEGORY_NAME,
              currency: 'NOK',
              quantity_sold: 31,
              sales_amount: 8_765_400,
            },
            {
              category_name: 'Desserts',
              currency: 'USD',
              quantity_sold: 20,
              sales_amount: 42_750,
            },
          ];
  return request.currency === null
    ? rows
    : rows.filter(({ currency }) => currency === request.currency);
}

function syntheticAdminAnalyticsOrderTypes(request: SyntheticAdminAnalyticsRequest) {
  if (request.mode === 'zero') return [];
  const rows =
    request.mode === 'healthy-filtered'
      ? [
          {
            collected_revenue_amount: 7_380_000,
            currency: 'NOK',
            order_type: 'dine_in',
            succeeded_orders_count: 40,
          },
        ]
      : request.mode === 'partial-products'
        ? [
            {
              collected_revenue_amount: 9_999_900,
              currency: 'NOK',
              order_type: 'takeaway',
              succeeded_orders_count: 33,
            },
          ]
        : [
            {
              collected_revenue_amount: 8_120_000,
              currency: 'NOK',
              order_type: 'dine_in',
              succeeded_orders_count: 30,
            },
            {
              collected_revenue_amount: 4_225_600,
              currency: 'NOK',
              order_type: 'takeaway',
              succeeded_orders_count: 18,
            },
            {
              collected_revenue_amount: 42_750,
              currency: 'USD',
              order_type: 'takeaway',
              succeeded_orders_count: 20,
            },
          ];
  return request.currency === null
    ? rows
    : rows.filter(({ currency }) => currency === request.currency);
}

function syntheticAdminAnalyticsResponse(request: SyntheticAdminAnalyticsRequest) {
  if (
    request.mode === 'all-malformed' ||
    (request.mode === 'partial-products' && request.endpoint === 'products')
  ) {
    return { private_contract_detail: ADMIN_ANALYTICS_PRIVATE_RESPONSE_COPY };
  }

  const range = syntheticAdminAnalyticsRange(request);
  if (request.endpoint === 'overview') {
    return { currencies: syntheticAdminAnalyticsCurrencies(request), range };
  }
  if (request.endpoint === 'products') {
    return {
      items: syntheticAdminAnalyticsProducts(request),
      limit_per_currency: request.limit,
      range,
    };
  }
  if (request.endpoint === 'categories') {
    return {
      items: syntheticAdminAnalyticsCategories(request),
      limit_per_currency: request.limit,
      range,
    };
  }
  return { items: syntheticAdminAnalyticsOrderTypes(request), range };
}

async function installSyntheticAdminAnalyticsRouting(
  page: Page,
  controller: SyntheticAdminAnalyticsController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-analytics-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        `admin-analytics-external-request:${request.method()}:${parsed.hostname}`,
      );
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_ANALYTICS_EMAIL,
          id: ADMIN_ANALYTICS_USER_ID,
          is_active: true,
          role: 'admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    const endpointDefinition = ADMIN_ANALYTICS_ENDPOINTS.find(
      ({ pathname }) => pathname === parsed.pathname,
    );
    if (endpointDefinition !== undefined && method === 'GET') {
      const mode = controller.mode;
      const captured = parseSyntheticAdminAnalyticsRequest(
        request,
        parsed,
        endpointDefinition.key,
        mode,
      );
      if (captured === null) {
        controller.networkIssues.push(
          `admin-analytics-query:${endpointDefinition.key}:${parsed.search}`,
        );
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic analytics query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      controller.requests.push(captured);
      const responseGate = controller.nextBatchResponseGate;
      if (responseGate !== null) await responseGate;
      await route.fulfill({
        body: JSON.stringify(syntheticAdminAnalyticsResponse(captured)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `admin-analytics-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic analytics request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function assertSyntheticAdminAnalyticsBatch(
  requests: readonly SyntheticAdminAnalyticsRequest[],
  expectation: {
    readonly currency: string | null;
    readonly end: string;
    readonly limit: number;
    readonly mode: SyntheticAdminAnalyticsMode;
    readonly start: string;
  },
): void {
  expect(requests).toHaveLength(ADMIN_ANALYTICS_ENDPOINTS.length);
  expect(requests.map(({ endpoint }) => endpoint).sort()).toEqual(
    ADMIN_ANALYTICS_ENDPOINTS.map(({ key }) => key).sort(),
  );
  for (const request of requests) {
    expect(request).toMatchObject({
      authorization: `Bearer ${ADMIN_ANALYTICS_TOKEN}`,
      capability: null,
      currency: expectation.currency,
      end: expectation.end,
      method: 'GET',
      mode: expectation.mode,
      postData: null,
      start: expectation.start,
    });
    expect(request.limit).toBe(
      request.endpoint === 'products' || request.endpoint === 'categories'
        ? expectation.limit
        : null,
    );
  }
}

function syntheticAdminExportsSearch(
  kind: SyntheticAdminExportKind,
  range: { readonly end: string; readonly start: string },
  currency: string | null,
  orderStatus: string | null = null,
  orderType: string | null = null,
): string {
  const query = new URLSearchParams({ end: range.end, start: range.start });
  if (currency !== null) query.set('currency', currency);
  if (kind === 'orders') {
    if (orderStatus !== null) query.set('status', orderStatus);
    if (orderType !== null) query.set('order_type', orderType);
  }
  return `?${query.toString()}`;
}

function parseSyntheticAdminExportRequest(
  request: Request,
  parsed: URL,
  kind: SyntheticAdminExportKind,
  mode: SyntheticAdminExportMode,
): SyntheticAdminExportRequest | null {
  const parameterNames = [...parsed.searchParams.keys()].sort();
  const expectedNames = [
    'end',
    ...(parsed.searchParams.has('currency') ? ['currency'] : []),
    ...(kind === 'orders' && parsed.searchParams.has('order_type')
      ? ['order_type']
      : []),
    ...(kind === 'orders' && parsed.searchParams.has('status') ? ['status'] : []),
    'start',
  ].sort();
  if (
    parameterNames.length !== expectedNames.length ||
    parameterNames.some((name, index) => name !== expectedNames[index])
  ) {
    return null;
  }

  const start = parsed.searchParams.get('start');
  const end = parsed.searchParams.get('end');
  const currency = parsed.searchParams.get('currency');
  const orderStatus = parsed.searchParams.get('status');
  const orderType = parsed.searchParams.get('order_type');
  const awareTimestampPattern = /(?:Z|[+-]\d{2}:\d{2})$/u;
  if (
    start === null ||
    end === null ||
    !awareTimestampPattern.test(start) ||
    !awareTimestampPattern.test(end) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end) ||
    (currency !== null && !/^[A-Z]{3}$/u.test(currency)) ||
    (kind !== 'orders' && (orderStatus !== null || orderType !== null)) ||
    (orderStatus !== null &&
      !/^(?:accepted|cancelled|completed|created|preparing|ready)$/u.test(
        orderStatus,
      )) ||
    (orderType !== null && !/^(?:dine_in|takeaway)$/u.test(orderType))
  ) {
    return null;
  }

  const headers = request.headers();
  return {
    accept: headers.accept ?? null,
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    contentType: headers['content-type'] ?? null,
    currency,
    end,
    kind,
    method: request.method(),
    mode,
    orderStatus,
    orderType,
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
    start,
  };
}

function syntheticAdminExportSafeFilename(kind: SyntheticAdminExportKind): string {
  if (kind === 'orders') return ADMIN_EXPORTS_LONG_FILENAME;
  if (kind === 'product-sales') {
    return 'product-sales_20260810T000000Z_20260817T000000Z_USD.csv';
  }
  return 'payments_20260810T000000Z_20260817T000000Z_USD.csv';
}

async function fulfillSyntheticAdminExport(
  route: Route,
  kind: SyntheticAdminExportKind,
  mode: SyntheticAdminExportMode,
): Promise<void> {
  if (mode === 'forbidden') {
    await route.fulfill({
      body: JSON.stringify({ detail: ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY }),
      contentType: 'application/json',
      status: 403,
    });
    return;
  }
  if (mode === 'invalid-parameters') {
    await route.fulfill({
      body: JSON.stringify({ detail: ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY }),
      contentType: 'application/json',
      status: 422,
    });
    return;
  }
  if (mode === 'server-error') {
    await route.fulfill({
      body: JSON.stringify({ detail: ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY }),
      contentType: 'application/json',
      status: 503,
    });
    return;
  }
  if (mode === 'invalid-mime') {
    await route.fulfill({
      body: `<!doctype html><title>${ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY}</title>`,
      headers: {
        'Content-Disposition': 'attachment; filename=error.csv',
        'Content-Type': 'text/html; charset=utf-8',
      },
      status: 200,
    });
    return;
  }

  const contentDisposition =
    mode === 'valid-fallback'
      ? `attachment; filename=${JSON.stringify('../private-export.csv')}`
      : `attachment; filename=${JSON.stringify(
          syntheticAdminExportSafeFilename(kind),
        )}`;
  await route.fulfill({
    body:
      String.fromCharCode(0xfeff) +
      ['column_one,column_two', 'value_one,value_two', ''].join(
        String.fromCharCode(13, 10),
      ),
    headers: {
      'Content-Disposition': contentDisposition,
      'Content-Type': 'text/csv; charset=utf-8',
    },
    status: 200,
  });
}

async function installSyntheticAdminExportsRouting(
  page: Page,
  controller: SyntheticAdminExportsController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-exports-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        `admin-exports-external-request:${request.method()}:${parsed.hostname}`,
      );
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_EXPORTS_EMAIL,
          id: ADMIN_EXPORTS_USER_ID,
          is_active: true,
          role: 'admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    const endpoint = ADMIN_EXPORTS_ENDPOINTS.find(
      ({ pathname }) => pathname === parsed.pathname,
    );
    if (endpoint !== undefined && method === 'GET') {
      const mode = controller.modes[endpoint.kind];
      const captured = parseSyntheticAdminExportRequest(
        request,
        parsed,
        endpoint.kind,
        mode,
      );
      if (captured === null) {
        controller.networkIssues.push(
          `admin-exports-query:${endpoint.kind}:${parsed.search}`,
        );
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic export query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      controller.requests.push(captured);
      const responseGate = controller.responseGates[endpoint.kind];
      if (responseGate !== null && responseGate !== undefined) {
        await responseGate;
      }
      await fulfillSyntheticAdminExport(route, endpoint.kind, mode);
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `admin-exports-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic export request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function assertSyntheticAdminExportRequest(
  request: SyntheticAdminExportRequest,
  expectation: {
    readonly currency: string | null;
    readonly end: string;
    readonly kind: SyntheticAdminExportKind;
    readonly mode: SyntheticAdminExportMode;
    readonly orderStatus?: string | null;
    readonly orderType?: string | null;
    readonly start: string;
  },
): void {
  expect(request).toMatchObject({
    accept: 'text/csv',
    authorization: `Bearer ${ADMIN_EXPORTS_TOKEN}`,
    capability: null,
    contentType: null,
    currency: expectation.currency,
    end: expectation.end,
    kind: expectation.kind,
    method: 'GET',
    mode: expectation.mode,
    orderStatus: expectation.orderStatus ?? null,
    orderType: expectation.orderType ?? null,
    postData: null,
    start: expectation.start,
  });
  expect(request.pathname).toBe(
    ADMIN_EXPORTS_ENDPOINTS.find(({ kind }) => kind === expectation.kind)?.pathname,
  );
  expect(request.search).toBe(
    syntheticAdminExportsSearch(
      expectation.kind,
      { end: expectation.end, start: expectation.start },
      expectation.currency,
      expectation.orderStatus ?? null,
      expectation.orderType ?? null,
    ),
  );
  expect(request.search).not.toContain(ADMIN_EXPORTS_TOKEN);
}

function captureSyntheticAdminUsersRequest(
  request: Request,
  parsed: URL,
): SyntheticAdminUsersRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    method: request.method(),
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
  };
}

function syntheticAdminUsersItems(customerRole: SyntheticAdminUsersOrdinaryRole) {
  return [
    {
      created_at: '2026-08-27T08:00:00Z',
      email: ADMIN_USERS_CUSTOMER_EMAIL,
      id: ADMIN_USERS_CUSTOMER_ID,
      is_active: true,
      role: customerRole,
      updated_at: '2026-08-27T08:10:00Z',
    },
    {
      created_at: '2026-08-27T08:20:00Z',
      email: ADMIN_USERS_CURRENT_EMAIL,
      id: ADMIN_USERS_CURRENT_ID,
      is_active: true,
      role: 'super_admin',
      updated_at: '2026-08-27T08:30:00Z',
    },
    {
      created_at: '2026-08-27T08:40:00Z',
      email: ADMIN_USERS_ADMIN_EMAIL,
      id: ADMIN_USERS_ADMIN_ID,
      is_active: false,
      role: 'admin',
      updated_at: '2026-08-27T08:50:00Z',
    },
  ] as const;
}

function syntheticAdminUsersResponse(
  controller: SyntheticAdminUsersController,
  offset: number,
) {
  if (controller.mode === 'malformed') {
    return { items: [] };
  }
  const allItems = syntheticAdminUsersItems(controller.authoritativeCustomerRole);
  const items =
    controller.mode === 'empty'
      ? []
      : controller.mode === 'paged' && offset === 50
        ? allItems.slice(0, 1)
        : allItems;
  return {
    items,
    limit: 50,
    offset,
    total: controller.mode === 'paged' ? 51 : items.length,
  };
}

function adminUsersRolePath(userId: string): string {
  return `${ADMIN_USERS_API_PATH}/${userId}/role`;
}

async function installSyntheticAdminUsersRouting(
  page: Page,
  controller: SyntheticAdminUsersController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-users-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        `admin-users-external-request:${request.method()}:${parsed.hostname}`,
      );
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.requests.push(captureSyntheticAdminUsersRequest(request, parsed));
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_USERS_CURRENT_EMAIL,
          id: ADMIN_USERS_CURRENT_ID,
          is_active: true,
          role: 'super_admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_USERS_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminUsersRequest(request, parsed));
      const offset = Number(parsed.searchParams.get('offset'));
      const validOffset =
        offset === 0 || (controller.mode === 'paged' && offset === 50);
      if (
        parsed.searchParams.get('limit') !== '50' ||
        !validOffset ||
        parsed.search !== `?limit=50&offset=${offset}`
      ) {
        controller.networkIssues.push(`admin-users-query:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic users query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      const responseGate = controller.nextUsersResponseGate;
      controller.nextUsersResponseGate = null;
      if (responseGate !== null) {
        await responseGate;
      }
      await route.fulfill({
        body: JSON.stringify(syntheticAdminUsersResponse(controller, offset)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    const ordinaryUser =
      parsed.pathname === adminUsersRolePath(ADMIN_USERS_CUSTOMER_ID)
        ? {
            email: ADMIN_USERS_CUSTOMER_EMAIL,
            id: ADMIN_USERS_CUSTOMER_ID,
          }
        : parsed.pathname === adminUsersRolePath(ADMIN_USERS_ADMIN_ID)
          ? { email: ADMIN_USERS_ADMIN_EMAIL, id: ADMIN_USERS_ADMIN_ID }
          : null;
    if (ordinaryUser !== null && parsed.search === '' && method === 'PATCH') {
      controller.requests.push(captureSyntheticAdminUsersRequest(request, parsed));
      const failureStatus = controller.failNextPatchStatus;
      controller.failNextPatchStatus = null;
      if (failureStatus !== null) {
        await route.fulfill({
          body: JSON.stringify({ detail: 'Synthetic role mutation rejected' }),
          contentType: 'application/json',
          status: failureStatus,
        });
        return;
      }

      const responseGate = controller.patchResponseGate;
      controller.patchResponseGate = null;
      if (responseGate !== null) {
        await responseGate;
      }
      const rawPayload = request.postData();
      let payload: unknown;
      try {
        payload = rawPayload === null ? null : JSON.parse(rawPayload);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        payload = null;
      }
      const requestedRole =
        typeof payload === 'object' &&
        payload !== null &&
        'role' in payload &&
        (payload.role === 'admin' || payload.role === 'customer')
          ? payload.role
          : null;
      if (requestedRole === null) {
        controller.networkIssues.push('admin-users-invalid-role-payload');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic role payload' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      if (ordinaryUser.id === ADMIN_USERS_CUSTOMER_ID) {
        controller.authoritativeCustomerRole = requestedRole;
      }
      await route.fulfill({
        body: JSON.stringify({
          email: ordinaryUser.email,
          id: ordinaryUser.id,
          role: requestedRole,
          updated_at: '2026-08-27T09:00:00Z',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `admin-users-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic Admin Users request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function adminUsersCollection(
  page: Page,
  viewport: (typeof ADMIN_USERS_VIEWPORTS)[number],
): Locator {
  return viewport.width < 1_024
    ? page.getByRole('list', { name: 'Registered users, oldest first' })
    : page.getByRole('table', { name: 'Registered users, oldest first' });
}

function adminUserContainer(
  page: Page,
  viewport: (typeof ADMIN_USERS_VIEWPORTS)[number],
  email: string,
): Locator {
  const collection = adminUsersCollection(page, viewport);
  return viewport.width < 1_024
    ? collection.getByRole('listitem').filter({ hasText: email })
    : collection.getByRole('row').filter({ hasText: email });
}

function adminUserIdentity(container: Locator, email: string): Locator {
  return container.getByText(email, { exact: true });
}

async function assertAdminUsersFeedbackFocused(
  page: Page,
  role: 'alert' | 'status',
  text: RegExp,
): Promise<void> {
  const feedback = page.getByRole(role).filter({ hasText: text }).first();
  await expect(feedback).toBeVisible();
  await expect
    .poll(
      () =>
        feedback.evaluate((element) => {
          const runtime = globalThis as typeof globalThis & BrowserRuntime;
          const activeElement = runtime.document.activeElement;
          return (
            activeElement === (element as unknown as RuntimeElement) ||
            element.parentElement === activeElement
          );
        }),
      { message: 'ADMIN_USERS_FEEDBACK_FOCUS_MISMATCH' },
    )
    .toBe(true);
}

async function assertAdminUsersCollectionLayout(
  page: Page,
  viewport: (typeof ADMIN_USERS_VIEWPORTS)[number],
): Promise<Locator> {
  const cards = page.getByRole('list', {
    name: 'Registered users, oldest first',
  });
  const table = page.getByRole('table', {
    name: 'Registered users, oldest first',
  });
  if (viewport.width < 1_024) {
    await expect(cards).toBeVisible();
    await expect(table).toBeHidden();
    return cards;
  }
  await expect(cards).toBeHidden();
  await expect(table).toBeVisible();
  const desktopTableFits = await table.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const tableElement = element as unknown as RuntimeElement;
    const wrapper = tableElement.parentElement;
    const finalCell = tableElement.querySelector('tbody tr > *:last-child');
    if (wrapper === null || finalCell === null) return false;
    const wrapperBox = wrapper.getBoundingClientRect();
    const finalCellBox = finalCell.getBoundingClientRect();
    return (
      wrapperBox.left >= -1 &&
      wrapperBox.right <= runtime.innerWidth + 1 &&
      finalCellBox.left >= wrapperBox.left - 1 &&
      finalCellBox.right <= wrapperBox.right + 1
    );
  });
  safeInvariant(desktopTableFits, 'ADMIN_USERS_DESKTOP_TABLE_CLIPPED');
  return table;
}

async function assertAdminUsersViewport(
  page: Page,
  viewport: (typeof ADMIN_USERS_VIEWPORTS)[number],
  controller: SyntheticAdminUsersController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const usersResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await page.goto('/admin/users');
  await Promise.all([
    assertResponseStatus(
      currentUserResponse,
      200,
      'ADMIN_USERS_CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(usersResponse, 200, 'ADMIN_USERS_LIST_STATUS_MISMATCH'),
  ]);
  await assertLocation(page, '/admin/users');
  const pageHeading = page.getByRole('heading', { level: 1, name: 'Users' });
  await expect(pageHeading).toHaveCount(1);
  await expect(pageHeading).toBeVisible();

  const collection = await assertAdminUsersCollectionLayout(page, viewport);
  const identityCells =
    viewport.width < 1_024
      ? collection.getByRole('heading', { level: 2 })
      : collection.locator('tbody th[scope=row]');
  await expect(identityCells).toHaveCount(3);
  const identities = await identityCells.allInnerTexts();
  safeInvariant(
    identities[0]?.includes(ADMIN_USERS_CUSTOMER_EMAIL) === true &&
      identities[1]?.includes(ADMIN_USERS_CURRENT_EMAIL) === true &&
      identities[2]?.includes(ADMIN_USERS_ADMIN_EMAIL) === true,
    'ADMIN_USERS_BACKEND_ORDER_MISMATCH',
  );

  let customer = adminUserContainer(page, viewport, ADMIN_USERS_CUSTOMER_EMAIL);
  const currentUser = adminUserContainer(page, viewport, ADMIN_USERS_CURRENT_EMAIL);
  let ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  await expect(customer.getByText('Customer', { exact: true })).toBeVisible();
  await expect(
    currentUser.getByText('Super administrator', { exact: true }),
  ).toBeVisible();
  await expect(currentUser.getByText('You', { exact: true })).toBeVisible();
  await expect(currentUser.getByText('Read only', { exact: true })).toBeVisible();
  await expect(currentUser.getByRole('button')).toHaveCount(0);
  await expect(ordinaryAdmin.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(ordinaryAdmin).toContainText('Inactive');
  await assertLongTextWraps(adminUserIdentity(customer, ADMIN_USERS_CUSTOMER_EMAIL));
  await assertTextNotClipped(
    adminUserIdentity(currentUser, ADMIN_USERS_CURRENT_EMAIL),
    'ADMIN_USERS_CURRENT_IDENTITY_CLIPPED',
  );

  const main = page.getByRole('main');
  await expect(
    main.getByRole('button', { name: /delete|deactivate|remove user/iu }),
  ).toHaveCount(0);
  await expect(main.getByText('super_admin', { exact: true })).toHaveCount(0);
  const refreshButton = main.getByRole('button', { exact: true, name: 'Refresh' });
  const customerAction = customer.getByRole('button', {
    exact: true,
    name: `Promote to admin for ${ADMIN_USERS_CUSTOMER_EMAIL}`,
  });
  await expect(customer.getByRole('button')).toHaveCount(1);
  await expect(ordinaryAdmin.getByRole('button')).toHaveCount(1);
  await assertMinimumTouchTarget(refreshButton, 'ADMIN_USERS_REFRESH_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(
    customerAction,
    'ADMIN_USERS_ROLE_ACTION_TARGET_TOO_SMALL',
  );
  await assertReducedMotionContract(page, [refreshButton, customerAction]);
  await assertResponsiveSurface(page);

  controller.mode = 'paged';
  const pagedRefresh = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await refreshButton.click();
  await assertResponseStatus(
    pagedRefresh,
    200,
    'G2_ADMIN_USERS_PAGED_REFRESH_STATUS_MISMATCH',
  );
  const nextButton = page.getByRole('button', { exact: true, name: 'Next' });
  await expect(nextButton).toBeEnabled();
  await nextButton.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(nextButton);
  let releaseNextPage = (): void => undefined;
  controller.nextUsersResponseGate = new Promise<void>((resolve) => {
    releaseNextPage = resolve;
  });
  const nextPageResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await page.keyboard.press('Enter');
  const movedUsersFocusTarget =
    viewport.width === 320
      ? page
          .getByRole('navigation', { name: 'Administrator navigation' })
          .getByRole('link', { exact: true, name: 'Analytics' })
      : null;
  if (movedUsersFocusTarget !== null) {
    await movedUsersFocusTarget.focus();
    await assertVisibleKeyboardFocus(movedUsersFocusTarget);
  }
  releaseNextPage();
  await assertResponseStatus(
    nextPageResponse,
    200,
    'G2_ADMIN_USERS_NEXT_STATUS_MISMATCH',
  );
  const secondPageSummary = page.getByText(/Showing 51.*51 of 51/u);
  const secondPageResults = secondPageSummary.locator('../..');
  if (movedUsersFocusTarget === null) {
    await expect(secondPageResults).toBeFocused();
    await assertVisibleKeyboardFocus(secondPageResults);
  } else {
    await expect(movedUsersFocusTarget).toBeFocused();
  }
  controller.mode = 'healthy';
  const previousButton = page.getByRole('button', {
    exact: true,
    name: 'Previous',
  });
  await previousButton.focus();
  const previousPageResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    previousPageResponse,
    200,
    'G2_ADMIN_USERS_PREVIOUS_STATUS_MISMATCH',
  );
  const firstPageResults = page.getByText(/Showing 1.*3 of 3/u).locator('../..');
  await expect(firstPageResults).toBeFocused();
  await assertVisibleKeyboardFocus(firstPageResults);

  await customerAction.focus();
  await assertVisibleKeyboardFocus(customerAction);
  await page.keyboard.press('Enter');
  let confirmation = page.getByRole('group', { name: 'Confirm role change' });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole('heading', { level: 2, name: 'Confirm role change' }),
  ).toBeFocused();
  await expect(
    confirmation.getByText(ADMIN_USERS_CUSTOMER_EMAIL, { exact: true }),
  ).toBeVisible();
  await expect(confirmation.getByText('Customer', { exact: true })).toBeVisible();
  await expect(confirmation.getByText('Administrator', { exact: true })).toBeVisible();
  const cancelButton = confirmation.getByRole('button', {
    exact: true,
    name: 'Cancel',
  });
  await assertMinimumTouchTarget(cancelButton, 'ADMIN_USERS_CANCEL_TARGET_TOO_SMALL');
  await cancelButton.click();
  await expect(customerAction).toBeFocused();

  await page.keyboard.press('Enter');
  confirmation = page.getByRole('group', { name: 'Confirm role change' });
  const confirmButton = confirmation.getByRole('button', {
    exact: true,
    name: 'Confirm',
  });
  await assertMinimumTouchTarget(confirmButton, 'ADMIN_USERS_CONFIRM_TARGET_TOO_SMALL');
  let releasePatch: () => void = () => undefined;
  let releaseUsersRefresh: () => void = () => undefined;
  controller.patchResponseGate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  controller.nextUsersResponseGate = new Promise<void>((resolve) => {
    releaseUsersRefresh = resolve;
  });
  const customerRolePath = adminUsersRolePath(ADMIN_USERS_CUSTOMER_ID);
  const successfulPatchResponse = waitForApiResponse(page, 'PATCH', customerRolePath);
  const successfulRefreshResponse = waitForApiResponse(
    page,
    'GET',
    ADMIN_USERS_API_PATH,
  );
  const usersGetCountBeforeMutation = controller.requests.filter(
    ({ method, pathname }) => method === 'GET' && pathname === ADMIN_USERS_API_PATH,
  ).length;
  await confirmButton.evaluate((element) => {
    const button = element as unknown as { click: () => void };
    button.click();
    button.click();
  });
  await expect
    .poll(
      () =>
        controller.requests.filter(
          ({ method, pathname }) => method === 'PATCH' && pathname === customerRolePath,
        ).length,
      { message: 'ADMIN_USERS_PATCH_DID_NOT_START' },
    )
    .toBe(1);
  await expect(confirmation).toHaveAttribute('aria-busy', 'true');
  const updatingButton = confirmation.getByRole('button', {
    exact: true,
    name: 'Updating role',
  });
  await expect(updatingButton).toBeDisabled();
  await expect(updatingButton).toHaveAttribute('aria-busy', 'true');
  await expect(
    confirmation.getByRole('button', { exact: true, name: 'Cancel' }),
  ).toBeDisabled();
  await expect(customer.getByText('Customer', { exact: true })).toBeVisible();
  releasePatch();
  await assertResponseStatus(
    successfulPatchResponse,
    200,
    'ADMIN_USERS_PATCH_STATUS_MISMATCH',
  );
  await expect
    .poll(
      () =>
        controller.requests.filter(
          ({ method, pathname }) =>
            method === 'GET' && pathname === ADMIN_USERS_API_PATH,
        ).length,
      { message: 'ADMIN_USERS_AUTHORITATIVE_GET_DID_NOT_START' },
    )
    .toBe(usersGetCountBeforeMutation + 1);
  await expect(customer.getByText('Customer', { exact: true })).toBeVisible();
  releaseUsersRefresh();
  await assertResponseStatus(
    successfulRefreshResponse,
    200,
    'ADMIN_USERS_AUTHORITATIVE_GET_STATUS_MISMATCH',
  );
  await assertAdminUsersFeedbackFocused(
    page,
    'status',
    /authoritative user list was loaded/iu,
  );
  await expect(confirmation).toHaveCount(0);
  customer = adminUserContainer(page, viewport, ADMIN_USERS_CUSTOMER_EMAIL);
  await expect(customer.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(
    customer.getByRole('button', {
      exact: true,
      name: `Demote to customer for ${ADMIN_USERS_CUSTOMER_EMAIL}`,
    }),
  ).toBeEnabled();
  const successfulPatch = controller.requests.filter(
    ({ method, pathname }) => method === 'PATCH' && pathname === customerRolePath,
  );
  expect(successfulPatch).toHaveLength(1);
  expect(JSON.parse(successfulPatch[0]?.postData ?? 'null')).toEqual({
    role: 'admin',
  });
  await assertResponsiveSurface(page);

  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  let adminAction = ordinaryAdmin.getByRole('button', {
    exact: true,
    name: `Demote to customer for ${ADMIN_USERS_ADMIN_EMAIL}`,
  });
  await adminAction.click();
  confirmation = page.getByRole('group', { name: 'Confirm role change' });
  await expect(
    confirmation.getByText(ADMIN_USERS_ADMIN_EMAIL, { exact: true }),
  ).toBeVisible();
  await expect(confirmation.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(confirmation.getByText('Customer', { exact: true })).toBeVisible();
  controller.failNextPatchStatus = 403;
  const adminRolePath = adminUsersRolePath(ADMIN_USERS_ADMIN_ID);
  const forbiddenResponse = waitForApiResponse(page, 'PATCH', adminRolePath);
  const forbiddenCurrentUserResponse = waitForApiResponse(
    page,
    'GET',
    AUTH_ME_API_PATH,
  );
  await confirmation.getByRole('button', { exact: true, name: 'Confirm' }).click();
  await Promise.all([
    assertResponseStatus(
      forbiddenResponse,
      403,
      'ADMIN_USERS_FORBIDDEN_STATUS_MISMATCH',
    ),
    assertResponseStatus(
      forbiddenCurrentUserResponse,
      200,
      'ADMIN_USERS_FORBIDDEN_ME_STATUS_MISMATCH',
    ),
  ]);
  await assertAdminUsersFeedbackFocused(page, 'alert', /role update was denied/iu);
  await expect(page.getByText('Refresh required', { exact: true })).toBeVisible();
  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  await expect(ordinaryAdmin.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(
    ordinaryAdmin.getByRole('button', {
      exact: true,
      name: `Demote to customer for ${ADMIN_USERS_ADMIN_EMAIL}`,
    }),
  ).toBeDisabled();
  const forbiddenRecovery = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await refreshButton.click();
  await assertResponseStatus(
    forbiddenRecovery,
    200,
    'ADMIN_USERS_FORBIDDEN_RECOVERY_STATUS_MISMATCH',
  );
  await expect(page.getByText('Refresh required', { exact: true })).toHaveCount(0);

  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  adminAction = ordinaryAdmin.getByRole('button', {
    exact: true,
    name: `Demote to customer for ${ADMIN_USERS_ADMIN_EMAIL}`,
  });
  await adminAction.click();
  controller.failNextPatchStatus = 409;
  const conflictResponse = waitForApiResponse(page, 'PATCH', adminRolePath);
  const conflictRefreshResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await page
    .getByRole('group', { name: 'Confirm role change' })
    .getByRole('button', { exact: true, name: 'Confirm' })
    .click();
  await Promise.all([
    assertResponseStatus(conflictResponse, 409, 'ADMIN_USERS_CONFLICT_STATUS_MISMATCH'),
    assertResponseStatus(
      conflictRefreshResponse,
      200,
      'ADMIN_USERS_CONFLICT_REFRESH_STATUS_MISMATCH',
    ),
  ]);
  await assertAdminUsersFeedbackFocused(
    page,
    'alert',
    /latest user state was loaded/iu,
  );
  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  await expect(ordinaryAdmin.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(page.getByText('Refresh required', { exact: true })).toHaveCount(0);

  adminAction = ordinaryAdmin.getByRole('button', {
    exact: true,
    name: `Demote to customer for ${ADMIN_USERS_ADMIN_EMAIL}`,
  });
  await adminAction.click();
  controller.failNextPatchStatus = 422;
  const rejectionResponse = waitForApiResponse(page, 'PATCH', adminRolePath);
  await page
    .getByRole('group', { name: 'Confirm role change' })
    .getByRole('button', { exact: true, name: 'Confirm' })
    .click();
  await assertResponseStatus(
    rejectionResponse,
    422,
    'ADMIN_USERS_REJECTION_STATUS_MISMATCH',
  );
  await assertAdminUsersFeedbackFocused(
    page,
    'alert',
    /requested role transition was not valid/iu,
  );
  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  await expect(ordinaryAdmin.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(page.getByText('Refresh required', { exact: true })).toBeVisible();
  const rejectionRecovery = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await refreshButton.click();
  await assertResponseStatus(
    rejectionRecovery,
    200,
    'ADMIN_USERS_REJECTION_RECOVERY_STATUS_MISMATCH',
  );
  await expect(page.getByText('Refresh required', { exact: true })).toHaveCount(0);

  controller.mode = 'empty';
  const emptyResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await refreshButton.click();
  await assertResponseStatus(emptyResponse, 200, 'ADMIN_USERS_EMPTY_STATUS_MISMATCH');
  await expect(
    page.getByRole('heading', { level: 2, name: 'No users found' }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Registered users, oldest first' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('table', { name: 'Registered users, oldest first' }),
  ).toHaveCount(0);
  await assertResponsiveSurface(page);

  controller.mode = 'malformed';
  const reloadCurrentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const malformedResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await page.reload();
  await Promise.all([
    assertResponseStatus(
      reloadCurrentUserResponse,
      200,
      'ADMIN_USERS_RELOAD_ME_STATUS_MISMATCH',
    ),
    assertResponseStatus(
      malformedResponse,
      200,
      'ADMIN_USERS_MALFORMED_STATUS_MISMATCH',
    ),
  ]);
  await expect(
    page.getByRole('alert').filter({ hasText: /Unable to load users/iu }),
  ).toBeVisible();
  const retryButton = page.getByRole('button', { exact: true, name: 'Retry' });
  await assertMinimumTouchTarget(retryButton, 'ADMIN_USERS_RETRY_TARGET_TOO_SMALL');
  controller.mode = 'healthy';
  const retryResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
  await retryButton.click();
  await assertResponseStatus(retryResponse, 200, 'ADMIN_USERS_RETRY_STATUS_MISMATCH');
  await assertAdminUsersCollectionLayout(page, viewport);
  customer = adminUserContainer(page, viewport, ADMIN_USERS_CUSTOMER_EMAIL);
  ordinaryAdmin = adminUserContainer(page, viewport, ADMIN_USERS_ADMIN_EMAIL);
  await expect(customer.getByText('Administrator', { exact: true })).toBeVisible();
  await expect(ordinaryAdmin.getByText('Administrator', { exact: true })).toBeVisible();

  const patchRequests = controller.requests.filter(
    ({ method, pathname }) => method === 'PATCH' && pathname === adminRolePath,
  );
  expect(patchRequests).toHaveLength(3);
  for (const request of patchRequests) {
    expect(JSON.parse(request.postData ?? 'null')).toEqual({ role: 'customer' });
  }
  expect(controller.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(
    0,
  );
  for (const request of controller.requests) {
    expect(request.authorization).toBe(`Bearer ${ADMIN_USERS_TOKEN}`);
    expect(request.capability).toBeNull();
  }
  const visibleCopy = await page.locator('body').innerText();
  expect(visibleCopy).not.toContain(ADMIN_USERS_TOKEN);
  expect(visibleCopy).not.toMatch(/Bearer\s/iu);
  expect(controller.networkIssues, 'ADMIN_USERS_SYNTHETIC_NETWORK_FAILURE').toEqual([]);

  const finalAction = customer.getByRole('button', {
    exact: true,
    name: `Demote to customer for ${ADMIN_USERS_CUSTOMER_EMAIL}`,
  });
  await assertReducedMotionContract(page, [finalAction]);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await blurActiveElement(page);
  await tabTo(page, finalAction, 40);
  await assertVisibleKeyboardFocus(finalAction);
  await assertResponsiveSurface(page);
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  expect(page.viewportSize()).toEqual({
    height: viewport.height,
    width: viewport.width,
  });
}

const ADMIN_MENU_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_MENU_EMAIL =
  'stage21-f3a-r1-catalog-administrator-with-a-long-identity@example.invalid';
const ADMIN_MENU_TOKEN = 'synthetic.stage21.f3a.r1.admin.token';
const ADMIN_MENU_USER_ID = '44444444-4444-4444-8444-444444444440';
const ADMIN_MENU_CATEGORIES_API_PATH = '/api/v1/admin/menu/categories';
const ADMIN_MENU_ITEMS_API_PATH = '/api/v1/admin/menu/items';
const ADMIN_MENU_PRIMARY_ITEM_ID = CART_IMAGE_ITEM_ID;
const ADMIN_MENU_SECONDARY_ITEM_ID = '55555555-5555-4555-8555-555555555552';
const ADMIN_MENU_STARTERS_CATEGORY_ID = '44444444-4444-4444-8444-444444444441';
const ADMIN_MENU_MAINS_CATEGORY_ID = '44444444-4444-4444-8444-444444444442';
const ADMIN_MENU_PRIMARY_ITEM_NAME = 'Roasted Root Vegetable Soup';
const ADMIN_MENU_SECONDARY_ITEM_NAME =
  'NordicForestMushroomBarleyFeastWithPickledShallotsAndRoastedJuniper';

interface SyntheticAdminMenuRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAdminMenuController {
  authoritativeCostAmount: number;
  authoritativePriceAmount: number;
  categoryMode: 'empty' | 'healthy';
  failNextPatch: boolean;
  itemMode: 'empty' | 'error' | 'healthy';
  readonly networkIssues: string[];
  readonly requests: SyntheticAdminMenuRequest[];
  saveResponseGate: Promise<void> | null;
}

function captureSyntheticAdminMenuRequest(
  request: Request,
  parsed: URL,
): SyntheticAdminMenuRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    method: request.method(),
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
  };
}

function syntheticAdminMenuCategories() {
  return {
    items: [
      {
        created_at: '2026-08-27T08:00:00Z',
        description: 'Small plates and seasonal starters.',
        display_order: 10,
        id: ADMIN_MENU_STARTERS_CATEGORY_ID,
        is_active: true,
        name: 'Starters',
        updated_at: '2026-08-27T08:10:00Z',
      },
      {
        created_at: '2026-08-27T08:20:00Z',
        description: 'Nordic main courses.',
        display_order: 20,
        id: ADMIN_MENU_MAINS_CATEGORY_ID,
        is_active: false,
        name: 'Main courses',
        updated_at: '2026-08-27T08:30:00Z',
      },
    ],
    limit: 50,
    offset: 0,
    total: 2,
  };
}

function syntheticAdminMenuPrimaryItem(priceAmount: number, costAmount: number) {
  return {
    allergens: ['celery'],
    category_id: ADMIN_MENU_STARTERS_CATEGORY_ID,
    cost_amount: costAmount,
    created_at: '2026-08-27T09:00:00Z',
    currency: 'NOK',
    description: 'A warm seasonal starter with roasted roots.',
    display_order: 10,
    id: ADMIN_MENU_PRIMARY_ITEM_ID,
    image_url: 'javascript:alert(1)',
    is_active: true,
    is_available: false,
    name: ADMIN_MENU_PRIMARY_ITEM_NAME,
    price_amount: priceAmount,
    updated_at: '2026-08-27T09:15:00Z',
  };
}

function syntheticAdminMenuItems(priceAmount: number, costAmount: number) {
  return {
    items: [
      syntheticAdminMenuPrimaryItem(priceAmount, costAmount),
      {
        allergens: [],
        category_id: ADMIN_MENU_MAINS_CATEGORY_ID,
        cost_amount: 0,
        created_at: '2026-08-27T09:20:00Z',
        currency: 'NOK',
        description:
          'A deliberately long catalog record used to prove resilient wrapping.',
        display_order: 20,
        id: ADMIN_MENU_SECONDARY_ITEM_ID,
        image_url: null,
        is_active: false,
        is_available: true,
        name: ADMIN_MENU_SECONDARY_ITEM_NAME,
        price_amount: 2_147_483_647,
        updated_at: '2026-08-27T09:30:00Z',
      },
    ],
    limit: 50,
    offset: 0,
    total: 2,
  };
}

async function installSyntheticAdminMenuRouting(
  page: Page,
  controller: SyntheticAdminMenuController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-menu-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        'admin-menu-external-request:' + request.method() + ':' + parsed.hostname,
      );
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.requests.push(captureSyntheticAdminMenuRequest(request, parsed));
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_MENU_EMAIL,
          id: ADMIN_MENU_USER_ID,
          is_active: true,
          role: 'super_admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_MENU_CATEGORIES_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminMenuRequest(request, parsed));
      if (parsed.search !== '?limit=50&offset=0') {
        controller.networkIssues.push('admin-menu-categories-query:' + parsed.search);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic category query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(
          controller.categoryMode === 'empty'
            ? { items: [], limit: 50, offset: 0, total: 0 }
            : syntheticAdminMenuCategories(),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    const itemPath = ADMIN_MENU_ITEMS_API_PATH + '/' + ADMIN_MENU_PRIMARY_ITEM_ID;
    if (parsed.pathname === itemPath && parsed.search === '' && method === 'PATCH') {
      controller.requests.push(captureSyntheticAdminMenuRequest(request, parsed));
      if (controller.failNextPatch) {
        controller.failNextPatch = false;
        await route.fulfill({
          body: JSON.stringify({ detail: 'Synthetic menu-item conflict' }),
          contentType: 'application/json',
          status: 409,
        });
        return;
      }
      const saveResponseGate = controller.saveResponseGate;
      controller.saveResponseGate = null;
      if (saveResponseGate !== null) {
        await saveResponseGate;
      }
      controller.authoritativePriceAmount = 10_200;
      controller.authoritativeCostAmount = 4_800;
      await route.fulfill({
        body: JSON.stringify(syntheticAdminMenuPrimaryItem(10_120, 4_670)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname === ADMIN_MENU_ITEMS_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminMenuRequest(request, parsed));
      if (parsed.search !== '?limit=50&offset=0') {
        controller.networkIssues.push('admin-menu-items-query:' + parsed.search);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic item query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      if (controller.itemMode === 'error') {
        await route.fulfill({
          body: JSON.stringify({ items: [] }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(
          controller.itemMode === 'empty'
            ? { items: [], limit: 50, offset: 0, total: 0 }
            : syntheticAdminMenuItems(
                controller.authoritativePriceAmount,
                controller.authoritativeCostAmount,
              ),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        'admin-menu-unexpected-api:' + method + ':' + parsed.pathname + parsed.search,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic Admin Menu request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function adminMenuItemContainer(
  page: Page,
  viewport: (typeof ADMIN_MENU_VIEWPORTS)[number],
  itemName: string,
): Locator {
  if (viewport.width < 1_024) {
    return page
      .getByRole('list', { name: 'Administrator menu items' })
      .getByRole('listitem')
      .filter({ hasText: itemName });
  }
  return page
    .getByRole('table', {
      name: 'Administrator menu items in backend order',
    })
    .getByRole('row')
    .filter({ hasText: itemName });
}

async function assertAdminMenuViewport(
  page: Page,
  viewport: (typeof ADMIN_MENU_VIEWPORTS)[number],
  controller: SyntheticAdminMenuController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  await page.goto('/admin/menu');
  await assertLocation(page, '/admin/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Menu' })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Menu' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Categories' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Menu items' }),
  ).toBeVisible();

  const categoryTable = page.getByRole('table', {
    name: 'Administrator categories in backend order',
  });
  const categoryCards = page.getByRole('list', {
    name: 'Administrator categories',
  });
  const itemTable = page.getByRole('table', {
    name: 'Administrator menu items in backend order',
  });
  const itemCards = page.getByRole('list', {
    name: 'Administrator menu items',
  });
  if (viewport.width < 1_024) {
    await expect(categoryCards).toBeVisible();
    await expect(itemCards).toBeVisible();
    await expect(categoryTable).toBeHidden();
    await expect(itemTable).toBeHidden();
  } else {
    await expect(categoryCards).toBeHidden();
    await expect(itemCards).toBeHidden();
    await expect(categoryTable).toBeVisible();
    await expect(itemTable).toBeVisible();
    await assertTableReachable(categoryTable);
    await assertTableReachable(itemTable);
  }

  const inventory = page.getByLabel('Current inventory summary');
  await expect(inventory).toContainText('Items2');
  await expect(inventory).toContainText('Active1');
  await expect(inventory).toContainText('Marked available1');

  let primaryItem = adminMenuItemContainer(
    page,
    viewport,
    ADMIN_MENU_PRIMARY_ITEM_NAME,
  );
  let secondaryItem = adminMenuItemContainer(
    page,
    viewport,
    ADMIN_MENU_SECONDARY_ITEM_NAME,
  );
  await expect(primaryItem).toBeVisible();
  await expect(primaryItem).toContainText('99.00 NOK');
  await expect(primaryItem).toContainText('45.00 NOK');
  await expect(primaryItem).toContainText('Active');
  await expect(primaryItem).toContainText('Unavailable');
  await expect(secondaryItem).toBeVisible();
  await expect(secondaryItem).toContainText('21474836.47 NOK');
  await expect(secondaryItem).toContainText('0.00 NOK');
  await expect(secondaryItem).toContainText('Inactive');
  await expect(secondaryItem).toContainText('Available');

  const categoryFilter = page.getByRole('navigation', {
    name: 'Filter menu items by category',
  });
  const allItemsFilter = categoryFilter.getByRole('button', {
    exact: true,
    name: 'All items',
  });
  const mainsFilter = categoryFilter.getByRole('button', {
    exact: true,
    name: 'Main courses',
  });
  await expect(allItemsFilter).toHaveAttribute('aria-pressed', 'true');
  await mainsFilter.click();
  await expect(mainsFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(
    adminMenuItemContainer(page, viewport, ADMIN_MENU_PRIMARY_ITEM_NAME),
  ).toHaveCount(0);
  await expect(
    adminMenuItemContainer(page, viewport, ADMIN_MENU_SECONDARY_ITEM_NAME),
  ).toBeVisible();
  await allItemsFilter.click();
  await expect(allItemsFilter).toHaveAttribute('aria-pressed', 'true');

  primaryItem = adminMenuItemContainer(page, viewport, ADMIN_MENU_PRIMARY_ITEM_NAME);
  secondaryItem = adminMenuItemContainer(
    page,
    viewport,
    ADMIN_MENU_SECONDARY_ITEM_NAME,
  );
  await expect(primaryItem).toBeVisible();
  await expect(secondaryItem).toBeVisible();
  await expect(page.locator('img[src^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText('price_amount', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /delete|remove/iu })).toHaveCount(0);
  await assertResponsiveSurface(page);

  const addItemButton = page.getByRole('button', {
    exact: true,
    name: 'Add menu item',
  });
  const editButton = primaryItem.getByRole('button', {
    exact: true,
    name:
      (viewport.width < 1_024 ? 'Edit menu item ' : 'Edit ') +
      ADMIN_MENU_PRIMARY_ITEM_NAME,
  });
  await assertMinimumTouchTarget(addItemButton, 'ADMIN_MENU_ADD_ITEM_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(editButton, 'ADMIN_MENU_EDIT_TARGET_TOO_SMALL');
  await assertReducedMotionContract(page, [addItemButton, editButton]);
  await editButton.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(editButton);
  await editButton.click();

  const editor = page.locator('form').filter({
    has: page.getByRole('heading', { level: 3, name: 'Edit menu item' }),
  });
  await expect(editor).toBeVisible();
  const priceInput = editor.getByLabel('Price (NOK)', { exact: true });
  const costInput = editor.getByLabel('Cost (NOK)', { exact: true });
  await expect(priceInput).toHaveValue('99.00');
  await expect(costInput).toHaveValue('45.00');
  await expect(priceInput).toHaveAttribute('maxlength', '11');
  await expect(costInput).toHaveAttribute('maxlength', '11');
  await expect(editor.getByLabel('Currency', { exact: true })).toHaveCount(0);
  await expect(
    editor.getByLabel('Active — visible in the menu lifecycle', {
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    editor.getByLabel('Available — currently orderable', { exact: true }),
  ).not.toBeChecked();
  await expect(
    editor.getByText('Preview unavailable for an unsafe or invalid image URL.', {
      exact: true,
    }),
  ).toBeVisible();

  const saveButton = editor.getByRole('button', {
    exact: true,
    name: 'Save changes',
  });
  await assertMinimumTouchTarget(saveButton, 'ADMIN_MENU_SAVE_TARGET_TOO_SMALL');
  await priceInput.fill('101.201');
  await saveButton.click();
  await expect(priceInput).toBeFocused();
  await expect(priceInput).toHaveAttribute('aria-invalid', 'true');
  expect(
    controller.requests.filter((request) => request.method === 'PATCH'),
  ).toHaveLength(0);

  await priceInput.fill('101.20');
  await costInput.fill('46.70');
  const saveGate: { release: () => void } = { release: () => undefined };
  controller.saveResponseGate = new Promise<void>((resolve) => {
    saveGate.release = resolve;
  });
  const itemPath = ADMIN_MENU_ITEMS_API_PATH + '/' + ADMIN_MENU_PRIMARY_ITEM_ID;
  const patchResponse = waitForApiResponse(page, 'PATCH', itemPath);
  const refreshResponse = waitForApiResponse(page, 'GET', ADMIN_MENU_ITEMS_API_PATH);
  await saveButton.click();
  await expect
    .poll(
      () => controller.requests.filter((request) => request.method === 'PATCH').length,
      { message: 'ADMIN_MENU_PATCH_DID_NOT_START' },
    )
    .toBe(1);
  const savingButton = editor.getByRole('button', {
    exact: true,
    name: 'Saving…',
  });
  await expect(editor).toHaveAttribute('aria-busy', 'true');
  await expect(savingButton).toBeDisabled();
  await expect(savingButton).toHaveAttribute('aria-busy', 'true');
  const movedSaveFocusTarget =
    viewport.width === 375
      ? page.getByRole('link', { exact: true, name: 'Admin home' })
      : null;
  try {
    if (movedSaveFocusTarget !== null) {
      await movedSaveFocusTarget.focus();
      await expect(movedSaveFocusTarget).toBeFocused();
    }
  } finally {
    saveGate.release();
  }
  await Promise.all([
    assertResponseStatus(patchResponse, 200, 'ADMIN_MENU_PATCH_STATUS_MISMATCH'),
    assertResponseStatus(refreshResponse, 200, 'ADMIN_MENU_REFRESH_STATUS_MISMATCH'),
  ]);
  await expect(editor).toHaveCount(0);
  if (movedSaveFocusTarget !== null) {
    await expect(movedSaveFocusTarget).toBeFocused();
  } else {
    await expect(
      page.getByRole('heading', { level: 2, name: 'Menu items' }),
    ).toBeFocused();
  }

  primaryItem = adminMenuItemContainer(page, viewport, ADMIN_MENU_PRIMARY_ITEM_NAME);
  await expect(primaryItem).toContainText('102.00 NOK');
  await expect(primaryItem).toContainText('48.00 NOK');
  await expect(primaryItem).not.toContainText('101.20 NOK');
  await expect(primaryItem).not.toContainText('46.70 NOK');
  await expect(page.locator('img[src^="javascript:"]')).toHaveCount(0);
  await assertResponsiveSurface(page);

  const successfulPatchRequests = controller.requests.filter(
    (request) =>
      request.method === 'PATCH' &&
      request.pathname === itemPath &&
      request.search === '',
  );
  expect(successfulPatchRequests).toHaveLength(1);
  const patchRequest = successfulPatchRequests[0];
  safeInvariant(patchRequest !== undefined, 'ADMIN_MENU_PATCH_NOT_CAPTURED');
  expect(JSON.parse(patchRequest.postData ?? 'null')).toEqual({
    cost_amount: 4_670,
    price_amount: 10_120,
  });

  const refreshedEditButton = primaryItem.getByRole('button', {
    exact: true,
    name:
      (viewport.width < 1_024 ? 'Edit menu item ' : 'Edit ') +
      ADMIN_MENU_PRIMARY_ITEM_NAME,
  });
  await refreshedEditButton.click();
  await expect(editor).toBeVisible();
  await expect(priceInput).toHaveValue('102.00');
  await expect(costInput).toHaveValue('48.00');
  await costInput.fill('49.99');
  controller.failNextPatch = true;
  const conflictResponse = waitForApiResponse(page, 'PATCH', itemPath);
  await saveButton.click();
  await assertResponseStatus(
    conflictResponse,
    409,
    'ADMIN_MENU_CONFLICT_STATUS_MISMATCH',
  );
  await expect(editor).toBeVisible();
  await expect(costInput).toHaveValue('49.99');
  await expect(
    page.getByText(
      'A menu item with this name already exists in the selected category.',
      { exact: true },
    ),
  ).toBeVisible();
  await editor.getByRole('button', { exact: true, name: 'Cancel' }).click();
  const keepEditingButton = editor.getByRole('button', {
    exact: true,
    name: 'Keep editing',
  });
  const discardButton = editor.getByRole('button', {
    exact: true,
    name: 'Discard changes',
  });
  await expect(keepEditingButton).toBeFocused();
  await assertMinimumTouchTarget(
    keepEditingButton,
    'G2_ADMIN_MENU_KEEP_EDITING_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(
    discardButton,
    'G2_ADMIN_MENU_DISCARD_TARGET_TOO_SMALL',
  );
  await discardButton.click();
  await expect(editor).toHaveCount(0);
  await expect(refreshedEditButton).toBeFocused();

  controller.categoryMode = 'empty';
  controller.itemMode = 'empty';
  await page.getByRole('button', { exact: true, name: 'Refresh categories' }).click();
  await expect(
    page.getByRole('heading', { level: 3, name: 'No categories yet' }),
  ).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Refresh menu items' }).click();
  await expect(
    page.getByRole('heading', { level: 3, name: 'No menu items yet' }),
  ).toBeVisible();
  await assertResponsiveSurface(page);

  controller.categoryMode = 'healthy';
  const categoriesRecovery = waitForApiResponse(
    page,
    'GET',
    ADMIN_MENU_CATEGORIES_API_PATH,
  );
  await page.getByRole('button', { exact: true, name: 'Refresh categories' }).click();
  await assertResponseStatus(
    categoriesRecovery,
    200,
    'ADMIN_MENU_CATEGORIES_RECOVERY_STATUS_MISMATCH',
  );
  controller.itemMode = 'error';
  await page.getByRole('button', { exact: true, name: 'Refresh menu items' }).click();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Unable to load menu items' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The menu items service returned an unexpected response. Try again later.',
      { exact: true },
    ),
  ).toBeVisible();
  let itemRetryButton = page.getByRole('button', { exact: true, name: 'Retry' });
  await itemRetryButton.focus();
  const repeatedFailure = waitForApiResponse(page, 'GET', ADMIN_MENU_ITEMS_API_PATH);
  await itemRetryButton.click();
  await assertResponseStatus(
    repeatedFailure,
    200,
    'G2_ADMIN_MENU_REPEATED_FAILURE_STATUS_MISMATCH',
  );
  itemRetryButton = page.getByRole('button', { exact: true, name: 'Retry' });
  await expect(itemRetryButton).toBeFocused();
  controller.itemMode = 'healthy';
  const itemRecovery = waitForApiResponse(page, 'GET', ADMIN_MENU_ITEMS_API_PATH);
  await itemRetryButton.click();
  await assertResponseStatus(
    itemRecovery,
    200,
    'G2_ADMIN_MENU_RETRY_RECOVERY_STATUS_MISMATCH',
  );
  primaryItem = adminMenuItemContainer(page, viewport, ADMIN_MENU_PRIMARY_ITEM_NAME);
  await expect(primaryItem).toContainText('102.00 NOK');
  await expect(primaryItem).toContainText('48.00 NOK');

  const addMenuItemButton = page.getByRole('button', {
    exact: true,
    name: 'Add menu item',
  });
  await addMenuItemButton.click();
  const createEditor = page.locator('form').filter({
    has: page.getByRole('heading', { level: 3, name: 'Add menu item' }),
  });
  await expect(createEditor).toBeVisible();
  const createName = createEditor.getByLabel('Name', { exact: true });
  const createPrice = createEditor.getByLabel('Price (NOK)', { exact: true });
  const createCost = createEditor.getByLabel('Cost (NOK)', { exact: true });
  await expect(createName).toBeFocused();
  await assertMinimumTouchTarget(
    createPrice,
    'ADMIN_MENU_CREATE_PRICE_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(createCost, 'ADMIN_MENU_CREATE_COST_TARGET_TOO_SMALL');
  await createName.fill('Seasonal Nordic Plate');
  await createPrice.fill('12.30');
  await createCost.fill('4.10');
  await expect(createEditor.getByLabel('Currency', { exact: true })).toHaveCount(0);
  await assertResponsiveSurface(page);
  await createEditor.getByRole('button', { exact: true, name: 'Cancel' }).click();
  const createKeepEditing = createEditor.getByRole('button', {
    exact: true,
    name: 'Keep editing',
  });
  const createDiscard = createEditor.getByRole('button', {
    exact: true,
    name: 'Discard changes',
  });
  await expect(createKeepEditing).toBeFocused();
  await assertMinimumTouchTarget(
    createKeepEditing,
    'G2_ADMIN_MENU_CREATE_KEEP_EDITING_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(
    createDiscard,
    'G2_ADMIN_MENU_CREATE_DISCARD_TARGET_TOO_SMALL',
  );
  await createDiscard.click();
  await expect(createEditor).toHaveCount(0);
  await expect(addMenuItemButton).toBeFocused();

  const patchRequests = controller.requests.filter(
    (request) =>
      request.method === 'PATCH' &&
      request.pathname === itemPath &&
      request.search === '',
  );
  expect(patchRequests).toHaveLength(2);
  const conflictRequest = patchRequests[1];
  safeInvariant(conflictRequest !== undefined, 'ADMIN_MENU_CONFLICT_NOT_CAPTURED');
  expect(JSON.parse(conflictRequest.postData ?? 'null')).toEqual({
    cost_amount: 4_999,
  });
  for (const request of controller.requests) {
    expect(request.authorization).toBe('Bearer ' + ADMIN_MENU_TOKEN);
    expect(request.capability).toBeNull();
  }
  expect(controller.authoritativeCostAmount).toBe(4_800);
  expect(controller.authoritativePriceAmount).toBe(10_200);
  expect(controller.networkIssues, 'ADMIN_MENU_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await addMenuItemButton.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(addMenuItemButton);
  await assertResponsiveSurface(page);
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  expect(page.viewportSize()).toEqual({
    height: viewport.height,
    width: viewport.width,
  });
}

function accountDetailApiPath(publicOrderNumber: string): string {
  return `${ACCOUNT_ORDERS_API_PATH}/${publicOrderNumber}`;
}

function captureSyntheticAccountDetailRequest(
  request: Request,
  pathname: string,
  search: string,
): SyntheticAccountDetailRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    method: request.method(),
    pathname,
    postData: request.postData(),
    search,
  };
}

function syntheticAccountDetailOrder(
  publicOrderNumber: string,
  status: SyntheticAccountDetailStatus,
) {
  return {
    created_at: '2026-08-27T08:15:00Z',
    currency: 'NOK',
    items: SYNTHETIC_ACCOUNT_DETAIL_ITEMS,
    order_type: 'takeaway',
    public_order_number: publicOrderNumber,
    status,
    subtotal_amount: 52_345,
    table_number: null,
    total_amount: 9_876_543,
    updated_at: '2026-08-27T09:05:00Z',
  };
}

async function installSyntheticAccountDetailRouting(
  page: Page,
  controller: SyntheticAccountDetailController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('account-detail-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        `account-detail-external-request:${request.method()}:${parsed.hostname}`,
      );
      await route.abort();
      return;
    }

    const method = request.method();
    if (parsed.pathname === AUTH_ME_API_PATH) {
      controller.meAuthorizations.push(request.headers().authorization ?? null);
      if (parsed.search !== '' || method !== 'GET' || request.postData() !== null) {
        controller.networkIssues.push('account-detail-current-user-contract-mismatch');
      }
      await route.fulfill({
        body: JSON.stringify({
          email: ACCOUNT_EMAIL,
          id: ACCOUNT_USER_ID,
          is_active: true,
          role: 'customer',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith(`${ACCOUNT_ORDERS_API_PATH}/`)) {
      controller.detailRequests.push(
        captureSyntheticAccountDetailRequest(request, parsed.pathname, parsed.search),
      );
      if (parsed.search !== '' || method !== 'GET' || request.postData() !== null) {
        controller.networkIssues.push('account-detail-request-contract-mismatch');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected account detail request' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }

      if (parsed.pathname === accountDetailApiPath(ACCOUNT_ACTIVE_ORDER_NUMBER)) {
        await route.fulfill({
          body: JSON.stringify(
            syntheticAccountDetailOrder(ACCOUNT_ACTIVE_ORDER_NUMBER, 'preparing'),
          ),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (parsed.pathname === accountDetailApiPath(ACCOUNT_LONG_ORDER_NUMBER)) {
        await route.fulfill({
          body: JSON.stringify(
            syntheticAccountDetailOrder(ACCOUNT_LONG_ORDER_NUMBER, 'completed'),
          ),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (parsed.pathname === accountDetailApiPath(ACCOUNT_CANCELLED_ORDER_NUMBER)) {
        await route.fulfill({
          body: JSON.stringify(
            syntheticAccountDetailOrder(ACCOUNT_CANCELLED_ORDER_NUMBER, 'cancelled'),
          ),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (
        parsed.pathname === accountDetailApiPath(ACCOUNT_DETAIL_ACCESS_ORDER_NUMBER)
      ) {
        await route.fulfill({
          body: JSON.stringify({ detail: ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY }),
          contentType: 'application/json',
          status: 404,
        });
        return;
      }
      if (parsed.pathname === accountDetailApiPath(ACCOUNT_DETAIL_RETRY_ORDER_NUMBER)) {
        controller.retryRequestCount += 1;
        if (controller.retryRequestCount === 1) {
          await route.fulfill({
            body: JSON.stringify({ detail: ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY }),
            contentType: 'application/json',
            status: 503,
          });
          return;
        }
        if (controller.retryRequestCount === 2) {
          const responseGate = controller.retryResponseGate;
          controller.retryResponseGate = null;
          if (responseGate !== null) {
            await responseGate;
          }
          await route.fulfill({
            body: JSON.stringify(
              syntheticAccountDetailOrder(
                ACCOUNT_DETAIL_RETRY_ORDER_NUMBER,
                'preparing',
              ),
            ),
            contentType: 'application/json',
            status: 200,
          });
          return;
        }
        controller.networkIssues.push('account-detail-retry-count-invalid');
      } else {
        controller.networkIssues.push(
          `account-detail-order-unexpected:${parsed.pathname}`,
        );
      }

      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic account detail' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `account-detail-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function createSyntheticCartQuote(request: SyntheticCartQuoteRequest) {
  const items = request.items.map((item) => {
    const unitPrice = SYNTHETIC_CART_PRICE_BY_ID.get(item.menu_item_id);
    const name = SYNTHETIC_CART_NAME_BY_ID.get(item.menu_item_id);
    safeInvariant(unitPrice !== undefined, 'SYNTHETIC_CART_PRICE_MISSING');
    safeInvariant(name !== undefined, 'SYNTHETIC_CART_NAME_MISSING');
    return {
      line_total_amount: unitPrice * item.quantity,
      menu_item_id: item.menu_item_id,
      name: `${name} snapshot`,
      quantity: item.quantity,
      unit_price_amount: unitPrice,
    };
  });
  const totalAmount = items.reduce((total, item) => total + item.line_total_amount, 0);
  return {
    currency: 'NOK',
    items,
    subtotal_amount: totalAmount,
    total_amount: totalAmount,
  };
}

async function installSyntheticCartRouting(
  page: Page,
  quoteRequests: SyntheticCartQuoteItem[][],
  networkIssues: string[],
  failureController?: SyntheticCartFailureController,
  orderFailureController?: SyntheticCartOrderFailureController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('external-or-invalid-request');
      await route.abort();
      return;
    }
    if (parsed.pathname === '/api/v1/menu' && request.method() === 'GET') {
      await route.fulfill({
        body: JSON.stringify(SYNTHETIC_CART_MENU),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname === '/api/v1/orders/quote' && request.method() === 'POST') {
      let body: unknown;
      try {
        body = request.postDataJSON();
      } catch (error: unknown) {
        void error;
        networkIssues.push('invalid-quote-json');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Invalid synthetic quote request' }),
          contentType: 'application/json',
          status: 422,
        });
        return;
      }
      if (!isSyntheticCartQuoteRequest(body)) {
        networkIssues.push('invalid-quote-contract');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Invalid synthetic quote request' }),
          contentType: 'application/json',
          status: 422,
        });
        return;
      }
      quoteRequests.push(body.items.map((item) => ({ ...item })));
      if (failureController?.failQuotes === true) {
        failureController.controlled503Count += 1;
        await route.fulfill({
          body: JSON.stringify({ detail: 'Synthetic recoverable quote failure' }),
          contentType: 'application/json',
          status: 503,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(createSyntheticCartQuote(body)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (
      parsed.pathname === '/api/v1/orders' &&
      request.method() === 'POST' &&
      orderFailureController !== undefined
    ) {
      if (parsed.search !== '' || request.postData() === null) {
        networkIssues.push('invalid-order-create-contract');
      }
      orderFailureController.createBodies.push(request.postData() ?? '');
      const responseGate = orderFailureController.createResponseGate;
      orderFailureController.createResponseGate = null;
      if (responseGate !== null) {
        await responseGate;
      }
      await route.fulfill({
        body: JSON.stringify({ detail: 'Synthetic table validation failure' }),
        contentType: 'application/json',
        status: 422,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push('unexpected-api-request');
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
}

function captureSyntheticCheckoutRequest(request: Request): SyntheticCheckoutRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    idempotencyKey: headers['idempotency-key'] ?? null,
    postData: request.postData(),
  };
}

function syntheticCheckoutResponse(checkoutUrl: string) {
  return {
    checkout_url: checkoutUrl,
    expires_at: '2026-08-26T13:00:00Z',
    payment_status: 'pending',
    public_order_number: CHECKOUT_PUBLIC_ORDER_NUMBER,
  };
}

async function installSyntheticCheckoutRouting(
  page: Page,
  trace: SyntheticCheckoutTrace,
  firstCheckoutResponseGate: Promise<void>,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      trace.networkIssues.push('external-or-invalid-request');
      await route.abort();
      return;
    }

    const method = request.method();
    trace.observedLocalRequests.push(`${method} ${parsed.pathname}${parsed.search}`);

    if (
      parsed.pathname === CHECKOUT_ORDER_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      trace.orderRequests.push(captureSyntheticCheckoutRequest(request));
      await route.fulfill({
        body: JSON.stringify(SYNTHETIC_CHECKOUT_ORDER),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      parsed.pathname === CHECKOUT_SESSION_API_PATH &&
      parsed.search === '' &&
      method === 'POST'
    ) {
      trace.checkoutRequests.push(captureSyntheticCheckoutRequest(request));
      const requestNumber = trace.checkoutRequests.length;
      if (requestNumber === 1) {
        await firstCheckoutResponseGate;
        await route.fulfill({
          body: JSON.stringify(syntheticCheckoutResponse('javascript:alert(1)')),
          contentType: 'application/json',
          status: 201,
        });
        return;
      }
      if (requestNumber === 2) {
        await route.fulfill({
          body: JSON.stringify(
            syntheticCheckoutResponse(`${baseOrigin}${CHECKOUT_PROVIDER_PATH}`),
          ),
          contentType: 'application/json',
          status: 201,
        });
        return;
      }
      trace.networkIssues.push('duplicate-checkout-request');
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic checkout request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    if (
      parsed.pathname === CHECKOUT_PROVIDER_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      trace.providerRequests.push(`${method} ${parsed.pathname}`);
      await route.fulfill({
        body:
          '<!doctype html><html lang=en><head><meta charset=utf-8>' +
          '<title>Synthetic provider boundary</title></head><body><main>' +
          '<h1>Test payment provider boundary</h1>' +
          '<p>Payment remains pending. No provider completion was performed.</p>' +
          '</main></body></html>',
        contentType: 'text/html; charset=utf-8',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      trace.networkIssues.push(`unexpected-api-request:${method}:${parsed.pathname}`);
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

function cartLineFor(page: Page, itemName: string): Locator {
  return page.getByRole('listitem').filter({
    has: page.getByRole('heading', { exact: true, level: 3, name: itemName }),
  });
}

function definitionValue(container: Locator, label: string): Locator {
  return container
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`, 'u') })
    .locator('..')
    .locator('dd');
}

async function assertMinimumTouchTarget(locator: Locator, code: string): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        return box === null ? 0 : Math.min(box.width, box.height);
      },
      { message: code },
    )
    .toBeGreaterThanOrEqual(44);
}

async function assertReducedMotionContract(
  page: Page,
  locators: readonly Locator[],
): Promise<void> {
  const pageRuntime = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    return {
      mediaMatches: runtime.matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollBehavior: runtime.getComputedStyle(runtime.document.documentElement)
        .scrollBehavior,
    };
  });
  safeInvariant(pageRuntime.mediaMatches, 'CART_REDUCED_MOTION_MEDIA_MISMATCH');
  safeInvariant(
    pageRuntime.scrollBehavior === 'auto',
    'CART_REDUCED_MOTION_SCROLL_MISMATCH',
  );

  for (const locator of locators) {
    const motion = await locator.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const maximumDurationMs = (value: string) =>
        Math.max(
          ...value.split(',').map((entry) => {
            const normalized = entry.trim();
            const numericValue = Number.parseFloat(normalized);
            if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
            return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
          }),
        );
      const iterationsAreFinite = style.animationIterationCount
        .split(',')
        .every((entry) => {
          const iterationCount = Number.parseFloat(entry.trim());
          return Number.isFinite(iterationCount) && iterationCount <= 1;
        });
      return {
        animationDelayMs: maximumDurationMs(style.animationDelay),
        animationDurationMs: maximumDurationMs(style.animationDuration),
        iterationsAreFinite,
        transitionDelayMs: maximumDurationMs(style.transitionDelay),
        transitionDurationMs: maximumDurationMs(style.transitionDuration),
      };
    });
    safeInvariant(
      motion.animationDelayMs <= 0.011 &&
        motion.animationDurationMs <= 0.011 &&
        motion.iterationsAreFinite &&
        motion.transitionDelayMs <= 0.011 &&
        motion.transitionDurationMs <= 0.011,
      'CART_REDUCED_MOTION_ELEMENT_MISMATCH',
    );
  }
}

async function assertSafeResponsiveCartThumbnail(line: Locator): Promise<void> {
  const frame = line.locator('[data-image-state]');
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute('aria-hidden', 'true');
  const picture = frame.locator('picture');
  const source = picture.locator('source');
  const thumbnail = picture.locator('img');
  await expect(picture).toHaveCount(1);
  await expect(source).toHaveCount(1);
  await expect(thumbnail).toHaveCount(1);
  await expect(frame).toHaveAttribute('data-image-state', 'ready');
  await expect(thumbnail).toBeVisible();
  const [sourceSizes, sourceSrcSet, sourceType, thumbnailSrc] = await Promise.all([
    source.getAttribute('sizes'),
    source.getAttribute('srcset'),
    source.getAttribute('type'),
    thumbnail.getAttribute('src'),
  ]);
  safeInvariant(
    sourceSizes === CART_IMAGE_SIZES &&
      sourceSrcSet === CART_IMAGE_WEBP_SRCSET &&
      sourceType === 'image/webp' &&
      thumbnailSrc === CART_IMAGE_PNG_PATH,
    'CART_THUMBNAIL_RESPONSIVE_CONTRACT_MISMATCH',
  );
  const imageRuntime = await thumbnail.evaluate(async (element) => {
    const image = element as unknown as RuntimeElement & {
      decode: () => Promise<void>;
    };
    await image.decode();
    return {
      alt: image.getAttribute('alt'),
      currentSrc: image.currentSrc ?? '',
      decoding: image.getAttribute('decoding'),
      fetchPriority: image.getAttribute('fetchpriority'),
      loading: image.getAttribute('loading'),
      naturalHeight: image.naturalHeight ?? 0,
      naturalWidth: image.naturalWidth ?? 0,
    };
  });
  const selectedImage = new URL(imageRuntime.currentSrc);
  safeInvariant(
    selectedImage.origin === baseOrigin &&
      selectedImage.pathname === CART_IMAGE_WEBP_480_PATH,
    'CART_THUMBNAIL_CANDIDATE_MISMATCH',
  );
  safeInvariant(
    imageRuntime.alt === '' &&
      imageRuntime.decoding === 'async' &&
      imageRuntime.fetchPriority !== 'high' &&
      imageRuntime.loading === 'lazy',
    'CART_THUMBNAIL_LOADING_CONTRACT_MISMATCH',
  );
  safeInvariant(
    imageRuntime.naturalWidth > 0 && imageRuntime.naturalHeight > 0,
    'CART_THUMBNAIL_NOT_DECODED',
  );
  await assertContainedWithin(thumbnail, line, 'CART_THUMBNAIL_CLIPPED');
}

interface LandingImageContract {
  readonly alt: string;
  readonly candidatePath: string;
  readonly fallbackPath: string;
  readonly height: string;
  readonly highPriority: boolean;
  readonly loading: 'eager' | 'lazy';
  readonly sizes: string;
  readonly srcSet: string;
  readonly width: string;
}

function waitForLocalImageResponse(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseUrl(response.url());
    return (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === pathname &&
      response.request().resourceType() === 'image'
    );
  });
}

async function assertLandingImageResponse(
  responsePromise: Promise<Response>,
  expectedPath: string,
  code: string,
): Promise<void> {
  const response = await responsePromise;
  const parsed = parseUrl(response.url());
  const responseBody = await response.body();
  const contentLengthHeader = response.headers()['content-length'];
  const contentLength =
    contentLengthHeader === undefined
      ? responseBody.byteLength
      : Number.parseInt(contentLengthHeader, 10);
  safeInvariant(
    parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === expectedPath &&
      response.status() === 200,
    code + '_STATUS_MISMATCH',
  );
  safeInvariant(
    (response.headers()['content-type'] ?? '').startsWith('image/webp'),
    code + '_CONTENT_TYPE_MISMATCH',
  );
  safeInvariant(
    responseBody.byteLength > 0 &&
      Number.isSafeInteger(contentLength) &&
      contentLength === responseBody.byteLength,
    code + '_BYTE_LENGTH_MISMATCH',
  );
}

async function assertLandingImageContract(
  page: Page,
  responsePromise: Promise<Response>,
  contract: LandingImageContract,
  code: string,
): Promise<Locator> {
  const image = page.getByRole('main').getByRole('img', {
    exact: true,
    name: contract.alt,
  });
  await expect(image).toHaveCount(1);
  await expect(image).toBeVisible();

  const picture = image.locator('..');
  const source = picture.locator('source');
  await expect(picture).toHaveCount(1);
  await expect(source).toHaveCount(1);
  const [sourceSizes, sourceSrcSet, sourceType] = await Promise.all([
    source.getAttribute('sizes'),
    source.getAttribute('srcset'),
    source.getAttribute('type'),
  ]);
  safeInvariant(
    sourceSizes === contract.sizes &&
      sourceSrcSet === contract.srcSet &&
      sourceType === 'image/webp',
    code + '_PICTURE_CONTRACT_MISMATCH',
  );

  const imageRuntime = await image.evaluate(async (element) => {
    const runtimeImage = element as unknown as RuntimeElement & {
      readonly complete: boolean;
      decode: () => Promise<void>;
    };
    await runtimeImage.decode();
    return {
      complete: runtimeImage.complete,
      currentSrc: runtimeImage.currentSrc ?? '',
      decoding: runtimeImage.getAttribute('decoding'),
      fetchPriority: runtimeImage.getAttribute('fetchpriority'),
      height: runtimeImage.getAttribute('height'),
      loading: runtimeImage.getAttribute('loading'),
      naturalHeight: runtimeImage.naturalHeight ?? 0,
      naturalWidth: runtimeImage.naturalWidth ?? 0,
      sizes: runtimeImage.getAttribute('sizes'),
      src: runtimeImage.getAttribute('src'),
      width: runtimeImage.getAttribute('width'),
    };
  });
  safeInvariant(
    imageRuntime.complete &&
      imageRuntime.naturalWidth > 0 &&
      imageRuntime.naturalHeight > 0,
    code + '_NOT_DECODED',
  );
  safeInvariant(
    Math.abs(
      imageRuntime.naturalWidth / imageRuntime.naturalHeight -
        Number(contract.width) / Number(contract.height),
    ) <=
      2 / imageRuntime.naturalHeight,
    code + '_RATIO_MISMATCH',
  );
  const selectedImage = parseUrl(imageRuntime.currentSrc);
  safeInvariant(
    selectedImage !== null &&
      selectedImage.origin === baseOrigin &&
      selectedImage.pathname === contract.candidatePath,
    code + '_CURRENT_SRC_MISMATCH',
  );
  safeInvariant(
    imageRuntime.decoding === 'async' &&
      imageRuntime.height === contract.height &&
      imageRuntime.loading === contract.loading &&
      imageRuntime.sizes === contract.sizes &&
      imageRuntime.src === contract.fallbackPath &&
      imageRuntime.width === contract.width &&
      (contract.highPriority
        ? imageRuntime.fetchPriority === 'high'
        : imageRuntime.fetchPriority !== 'high'),
    code + '_LOADING_CONTRACT_MISMATCH',
  );
  await assertLandingImageResponse(responsePromise, contract.candidatePath, code);
  return image;
}

async function assertLandingReducedMotion(
  page: Page,
  motionTargets: readonly Locator[],
): Promise<void> {
  const mediaPreferences = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    return {
      forcedColors: runtime.matchMedia('(forced-colors: active)').matches,
      reducedMotion: runtime.matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollBehavior: runtime.getComputedStyle(runtime.document.documentElement)
        .scrollBehavior,
    };
  });
  safeInvariant(
    mediaPreferences.forcedColors &&
      mediaPreferences.reducedMotion &&
      mediaPreferences.scrollBehavior === 'auto',
    'LANDING_MEDIA_PREFERENCE_MISMATCH',
  );

  for (const target of motionTargets) {
    const motion = await target.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const maximumDurationMs = (value: string) =>
        Math.max(
          ...value.split(',').map((entry) => {
            const normalized = entry.trim();
            const numericValue = Number.parseFloat(normalized);
            if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
            return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
          }),
        );
      return {
        animationDurationMs: maximumDurationMs(style.animationDuration),
        animationName: style.animationName,
        opacity: style.opacity,
        transform: style.transform,
        transitionDurationMs: maximumDurationMs(style.transitionDuration),
        visibility: style.visibility,
      };
    });
    safeInvariant(
      motion.animationDurationMs <= 0.011 &&
        motion.animationName === 'none' &&
        motion.opacity !== '0' &&
        motion.transform === 'none' &&
        motion.transitionDurationMs <= 0.011 &&
        motion.visibility !== 'hidden',
      'LANDING_REDUCED_MOTION_TARGET_MISMATCH',
    );
  }
}

async function openMenu(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.goto('/menu');
  await assertResponseStatus(response, 200, 'MENU_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();
}

async function assertLandingViewport(
  page: Page,
  viewport: (typeof LANDING_VIEWPORTS)[number],
): Promise<void> {
  const expectedHeroImagePath =
    '/images/brand/optimized/hero/restaurant-hero-' +
    String(viewport.candidateWidth) +
    'w.webp';
  const brandImageRequestPaths: string[] = [];
  page.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname.startsWith('/images/brand/') &&
      request.resourceType() === 'image'
    ) {
      brandImageRequestPaths.push(parsed.pathname);
    }
  });
  const logoResponse = waitForLocalImageResponse(page, LANDING_LOGO_WEBP_320_PATH);
  const heroResponse = waitForLocalImageResponse(page, expectedHeroImagePath);
  const storyResponse = waitForLocalImageResponse(page, LANDING_STORY_WEBP_640_PATH);

  await page.goto('/');

  const main = page.getByRole('main');
  const heroHeading = page.getByRole('heading', {
    level: 1,
    name: 'Fresh food, ordered your way',
  });
  const heroRegion = page.getByRole('region', {
    name: 'Fresh food, ordered your way',
  });
  await expect(heroHeading).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Customer navigation' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);

  const introduction = page.getByText(
    /Explore starters, main courses, burgers, desserts, and non-alcoholic drinks/u,
  );
  const menuLink = page
    .getByRole('navigation', { name: 'Start ordering' })
    .getByRole('link', { exact: true, name: 'View menu' });
  await expect(menuLink).toBeVisible();
  await menuLink.click({ trial: true });

  await waitForSettledLayout(page);
  await assertTextNotClipped(heroHeading, 'LANDING_HERO_HEADING_CLIPPED');
  await assertTextNotClipped(introduction, 'LANDING_HERO_INTRODUCTION_CLIPPED');
  await assertContainedWithin(
    heroHeading,
    heroRegion,
    'LANDING_HERO_HEADING_OUTSIDE_HERO',
  );
  await assertContainedWithin(
    introduction,
    heroRegion,
    'LANDING_HERO_INTRODUCTION_OUTSIDE_HERO',
  );

  const linkBox = await menuLink.boundingBox();
  safeInvariant(linkBox !== null, 'LANDING_MENU_LINK_BOX_MISSING');
  safeInvariant(
    linkBox.height >= 44 && linkBox.width >= 44,
    'LANDING_MENU_LINK_TOUCH_TARGET_TOO_SMALL',
  );
  safeInvariant(linkBox.y >= 0, 'LANDING_MENU_LINK_ABOVE_VIEWPORT');
  safeInvariant(
    linkBox.y + linkBox.height <= viewport.height + OVERFLOW_TOLERANCE_PX,
    'LANDING_MENU_LINK_BELOW_INITIAL_VIEWPORT',
  );
  safeInvariant(
    (await menuLink.getAttribute('href')) === '/menu',
    'LANDING_MENU_LINK_ROUTE_MISMATCH',
  );

  const logoImage = await assertLandingImageContract(
    page,
    logoResponse,
    {
      alt: 'Nordic Hearth',
      candidatePath: LANDING_LOGO_WEBP_320_PATH,
      fallbackPath: LANDING_LOGO_PNG_PATH,
      height: '724',
      highPriority: false,
      loading: 'eager',
      sizes: LANDING_LOGO_SIZES,
      srcSet: LANDING_LOGO_WEBP_SRCSET,
      width: '2172',
    },
    'LANDING_LOGO_IMAGE',
  );
  const heroImage = await assertLandingImageContract(
    page,
    heroResponse,
    {
      alt: 'A candlelit dining table set with Nordic-inspired dishes',
      candidatePath: expectedHeroImagePath,
      fallbackPath: LANDING_HERO_PNG_PATH,
      height: '941',
      highPriority: true,
      loading: 'eager',
      sizes: LANDING_HERO_SIZES,
      srcSet: LANDING_HERO_WEBP_SRCSET,
      width: '1672',
    },
    'LANDING_HERO_IMAGE',
  );
  const storyImageLocator = main.getByRole('img', {
    exact: true,
    name: 'A cook plating cod with greens',
  });
  await expect(storyImageLocator).toHaveAttribute('loading', 'lazy');
  const initialStoryBox = await storyImageLocator.boundingBox();
  safeInvariant(
    initialStoryBox !== null && initialStoryBox.y >= viewport.height,
    'LANDING_STORY_IMAGE_NOT_BELOW_FOLD',
  );
  await storyImageLocator.scrollIntoViewIfNeeded();
  const storyImage = await assertLandingImageContract(
    page,
    storyResponse,
    {
      alt: 'A cook plating cod with greens',
      candidatePath: LANDING_STORY_WEBP_640_PATH,
      fallbackPath: LANDING_STORY_PNG_PATH,
      height: '1024',
      highPriority: false,
      loading: 'lazy',
      sizes: LANDING_STORY_SIZES,
      srcSet: LANDING_STORY_WEBP_SRCSET,
      width: '1536',
    },
    'LANDING_STORY_IMAGE',
  );

  await expect(main.getByRole('img')).toHaveCount(3);
  await expect(main.locator('img[fetchpriority=high]')).toHaveCount(1);
  await expect(
    page.getByRole('link', { exact: true, name: 'Nordic Hearth home' }),
  ).toHaveCount(1);
  await expect(main.getByText('Nordic Hearth', { exact: true })).toHaveCount(0);
  const forbiddenBrandReferences = main.locator(
    'img[src*=mockups], source[srcset*=mockups], img[src*=project-hero], source[srcset*=project-hero], img[src*=customer-mobile-ordering], source[srcset*=customer-mobile-ordering]',
  );
  await expect(forbiddenBrandReferences).toHaveCount(0);
  expect(
    [...brandImageRequestPaths].sort(),
    'LANDING_BRAND_IMAGE_REQUEST_SET_MISMATCH',
  ).toEqual(
    [
      LANDING_LOGO_WEBP_320_PATH,
      expectedHeroImagePath,
      LANDING_STORY_WEBP_640_PATH,
    ].sort(),
  );

  const logoPicture = logoImage.locator('..');
  const forcedColorsLogo = await logoPicture.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      visible: style.opacity !== '0' && style.visibility !== 'hidden',
    };
  });
  safeInvariant(
    forcedColorsLogo.outlineStyle !== 'none' &&
      forcedColorsLogo.outlineWidth !== '0px' &&
      forcedColorsLogo.visible,
    'LANDING_FORCED_COLORS_LOGO_MISMATCH',
  );
  await assertLandingReducedMotion(page, [
    logoPicture,
    heroImage,
    storyImage,
    menuLink,
  ]);

  const imageBox = await heroImage.boundingBox();
  safeInvariant(imageBox !== null, 'LANDING_HERO_IMAGE_BOX_MISSING');
  const maximumHeroImageHeightRatio = viewport.width >= 1024 ? 0.8 : 0.75;
  safeInvariant(
    imageBox.height <=
      viewport.height * maximumHeroImageHeightRatio + OVERFLOW_TOLERANCE_PX,
    'LANDING_HERO_IMAGE_EXCESSIVE_HEIGHT',
  );
  await assertContainedWithin(logoImage, heroRegion, 'LANDING_LOGO_IMAGE_CLIPPED');
  await assertContainedWithin(heroImage, heroRegion, 'LANDING_HERO_IMAGE_CLIPPED');
  await assertContainedWithin(
    storyImage,
    page.getByRole('region', { name: 'A taste of the menu' }),
    'LANDING_STORY_IMAGE_CLIPPED',
  );
  await assertResponsiveSurface(page);

  await menuLink.scrollIntoViewIfNeeded();
  await blurActiveElement(page);
  await tabTo(page, menuLink);
  await assertVisibleKeyboardFocus(menuLink);
  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.keyboard.press('Enter');
  await assertResponseStatus(menuResponse, 200, 'LANDING_MENU_STATUS_MISMATCH');
  await assertLocation(page, '/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();
}

async function assertCartViewport(
  page: Page,
  viewport: (typeof CART_VIEWPORTS)[number],
  quoteRequests: SyntheticCartQuoteItem[][],
): Promise<void> {
  await page.goto('/cart');
  const cartHeading = page.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Your cart',
  });
  const cartItemsHeading = page.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'Cart items',
  });
  const summaryHeading = page.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'Server quote',
  });
  const summary = page.getByRole('complementary', {
    exact: true,
    name: 'Server quote',
  });
  const firstLine = cartLineFor(page, MENU_ITEM_NAME);
  const fallbackLine = cartLineFor(page, CART_FALLBACK_ITEM_NAME);
  const placeOrder = page.getByRole('button', {
    exact: true,
    name: 'Place order and continue to payment',
  });

  await expect(cartHeading).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(cartItemsHeading).toBeVisible();
  await expect(summaryHeading).toBeVisible();
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(2);
  await expect(firstLine).toHaveCount(1);
  await expect(fallbackLine).toHaveCount(1);
  await expect(summary).toContainText(/(?:NOK|kr)/iu);
  await expect(placeOrder).toBeEnabled();
  await expect.poll(() => quoteRequests.length).toBe(1);
  expect(quoteRequests[0]).toEqual([
    { menu_item_id: CART_IMAGE_ITEM_ID, quantity: 1 },
    { menu_item_id: CART_FALLBACK_ITEM_ID, quantity: 1 },
  ]);

  await assertSafeResponsiveCartThumbnail(firstLine);
  const fallbackThumbnail = fallbackLine.locator('[data-image-state]');
  await expect(fallbackThumbnail).toHaveAttribute('data-image-state', 'placeholder');
  await expect(fallbackThumbnail.locator('img')).toHaveCount(0);

  const quantityControl = firstLine.locator(
    `[aria-label='Quantity for ${MENU_ITEM_NAME}']`,
  );
  const quantityValue = firstLine.getByLabel(`${MENU_ITEM_NAME} quantity`, {
    exact: true,
  });
  const decrease = firstLine.getByRole('button', {
    exact: true,
    name: `Decrease quantity for ${MENU_ITEM_NAME}`,
  });
  const increase = firstLine.getByRole('button', {
    exact: true,
    name: `Increase quantity for ${MENU_ITEM_NAME}`,
  });
  const removeFirst = firstLine.getByRole('button', {
    exact: true,
    name: `Remove ${MENU_ITEM_NAME} from cart`,
  });
  const clearCart = page.getByRole('button', {
    exact: true,
    name: 'Clear cart',
  });
  const initialUnitPrice = definitionValue(firstLine, 'Quoted unit price');
  const initialLineTotal = definitionValue(firstLine, 'Quoted line total');
  const total = definitionValue(summary, 'Total');

  await expect(quantityControl).toHaveCount(1);
  await expect(quantityValue).toHaveText('1');
  await expect(decrease).toBeDisabled();
  await expect(total).toHaveText(/288[,.]00/u);
  await expect(initialUnitPrice).toHaveText(/129[,.]00/u);
  await expect(initialLineTotal).toHaveText(/129[,.]00/u);
  await assertMinimumTouchTarget(decrease, 'CART_DECREASE_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(increase, 'CART_INCREASE_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(removeFirst, 'CART_REMOVE_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(clearCart, 'CART_CLEAR_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(placeOrder, 'CART_CTA_TARGET_TOO_SMALL');

  await assertTextNotClipped(cartHeading, 'CART_HEADING_CLIPPED');
  await assertTextNotClipped(
    fallbackLine.getByRole('heading', {
      exact: true,
      level: 3,
      name: CART_FALLBACK_ITEM_NAME,
    }),
    'CART_LONG_ITEM_NAME_CLIPPED',
  );
  await assertTextNotClipped(initialUnitPrice, 'CART_UNIT_PRICE_CLIPPED');
  await assertTextNotClipped(initialLineTotal, 'CART_LINE_TOTAL_CLIPPED');
  await assertTextNotClipped(total, 'CART_TOTAL_CLIPPED');
  await assertTextNotClipped(placeOrder, 'CART_CTA_LABEL_CLIPPED');
  const main = page.locator('#main-content');
  await assertContainedWithin(firstLine, main, 'CART_FIRST_LINE_OUTSIDE_MAIN');
  await assertContainedWithin(fallbackLine, main, 'CART_FALLBACK_LINE_OUTSIDE_MAIN');
  await assertContainedWithin(
    quantityControl,
    firstLine,
    'CART_QUANTITY_CONTROL_CLIPPED',
  );
  await assertContainedWithin(removeFirst, firstLine, 'CART_REMOVE_CONTROL_CLIPPED');
  await assertContainedWithin(summary, main, 'CART_SUMMARY_OUTSIDE_MAIN');
  await assertContainedWithin(placeOrder, summary, 'CART_CTA_OUTSIDE_SUMMARY');
  await assertResponsiveSurface(page);

  const summaryRuntime = await summary.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const box = (element as unknown as RuntimeElement).getBoundingClientRect();
    return {
      height: box.height,
      position: runtime.getComputedStyle(element as unknown as RuntimeElement).position,
    };
  });
  safeInvariant(summaryRuntime.position !== 'fixed', 'CART_SUMMARY_FIXED');
  if (viewport.width === 375) {
    safeInvariant(
      summaryRuntime.height <= viewport.height * 1.5,
      'CART_MOBILE_SUMMARY_EXCESSIVE_HEIGHT',
    );
  }
  await assertReducedMotionContract(page, [
    firstLine,
    increase,
    removeFirst,
    clearCart,
    total,
    placeOrder,
  ]);

  await blurActiveElement(page);
  await tabTo(page, increase, 48);
  await assertVisibleKeyboardFocus(increase);
  await page.keyboard.press('Enter');
  await expect(quantityValue).toHaveText('2');
  await expect(increase).toBeFocused();
  await expect.poll(() => quoteRequests.length).toBe(2);
  expect(quoteRequests[1]).toEqual([
    { menu_item_id: CART_IMAGE_ITEM_ID, quantity: 2 },
    { menu_item_id: CART_FALLBACK_ITEM_ID, quantity: 1 },
  ]);
  await expect(total).toHaveText(/417[,.]00/u);
  await expect(definitionValue(firstLine, 'Quoted line total')).toHaveText(
    /258[,.]00/u,
  );
  await assertTextNotClipped(total, 'CART_UPDATED_TOTAL_CLIPPED');
  await assertResponsiveSurface(page);

  await blurActiveElement(page);
  await tabTo(page, placeOrder, 48);
  await assertVisibleKeyboardFocus(placeOrder);
  const ctaBox = await placeOrder.boundingBox();
  safeInvariant(
    ctaBox !== null &&
      ctaBox.y >= -OVERFLOW_TOLERANCE_PX &&
      ctaBox.y + ctaBox.height <= viewport.height + OVERFLOW_TOLERANCE_PX,
    'CART_CTA_NOT_REACHABLE_IN_VIEWPORT',
  );

  await blurActiveElement(page);
  await tabTo(page, removeFirst, 48);
  await assertVisibleKeyboardFocus(removeFirst);
  await page.keyboard.press('Enter');
  await expect(firstLine).toHaveCount(0);
  await expect(fallbackLine).toHaveCount(1);
  const removeRemaining = fallbackLine.getByRole('button', {
    exact: true,
    name: `Remove ${CART_FALLBACK_ITEM_NAME} from cart`,
  });
  await assertVisibleKeyboardFocus(removeRemaining);
  await expect.poll(() => quoteRequests.length).toBe(3);
  expect(quoteRequests[2]).toEqual([
    { menu_item_id: CART_FALLBACK_ITEM_ID, quantity: 1 },
  ]);
  await expect(total).toHaveText(/159[,.]00/u);
  await assertResponsiveSurface(page);

  const remainingClearCart = page.getByRole('button', {
    exact: true,
    name: 'Clear cart',
  });
  await blurActiveElement(page);
  await tabTo(page, remainingClearCart, 48);
  await assertVisibleKeyboardFocus(remainingClearCart);
  await page.keyboard.press('Enter');
  const cancelClear = page.getByRole('button', {
    exact: true,
    name: 'Cancel clear cart',
  });
  const confirmClear = page.getByRole('button', {
    exact: true,
    name: 'Confirm clear cart',
  });
  await expect(cancelClear).toBeVisible();
  await expect(confirmClear).toBeVisible();
  await assertMinimumTouchTarget(cancelClear, 'CART_CLEAR_CANCEL_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(confirmClear, 'CART_CLEAR_CONFIRM_TARGET_TOO_SMALL');
  await assertVisibleKeyboardFocus(cancelClear);
  await page.keyboard.press('Enter');
  await expect(fallbackLine).toHaveCount(1);
  await expect(cancelClear).toHaveCount(0);
  await assertVisibleKeyboardFocus(remainingClearCart);

  await page.keyboard.press('Enter');
  await assertVisibleKeyboardFocus(cancelClear);
  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(confirmClear);
  await page.keyboard.press('Enter');

  const emptyHeading = page.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Your cart',
  });
  const browseMenu = page.getByRole('link', {
    exact: true,
    name: 'Browse the menu',
  });
  await expect(page.getByText('Your cart is empty.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2, name: 'Cart items' })).toHaveCount(
    0,
  );
  await expect(summary).toHaveCount(0);
  await expect(placeOrder).toHaveCount(0);
  await assertVisibleKeyboardFocus(emptyHeading);
  await expect(browseMenu).toHaveAttribute('href', '/menu');
  await assertMinimumTouchTarget(browseMenu, 'CART_EMPTY_MENU_TARGET_TOO_SMALL');
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(browseMenu);
  await assertResponsiveSurface(page);

  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.keyboard.press('Enter');
  await assertResponseStatus(menuResponse, 200, 'CART_EMPTY_MENU_STATUS_MISMATCH');
  await assertLocation(page, '/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();
}

async function assertCartDelayedValidationFocus(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  await context.addInitScript(
    ({ storageKey, storageValue }) => {
      globalThis.sessionStorage.setItem(storageKey, storageValue);
    },
    {
      storageKey: CART_STORAGE_KEY,
      storageValue: JSON.stringify({
        items: [{ menuItemId: CART_IMAGE_ITEM_ID, quantity: 1 }],
        version: 1,
      }),
    },
  );
  const page = await context.newPage();
  const quoteRequests: SyntheticCartQuoteItem[][] = [];
  const networkIssues: string[] = [];
  let releaseCreateResponse = (): void => undefined;
  const controller: SyntheticCartOrderFailureController = {
    createBodies: [],
    createResponseGate: new Promise<void>((resolve) => {
      releaseCreateResponse = resolve;
    }),
  };
  const guard = new BrowserSafetyGuard(
    page,
    [],
    [],
    [{ method: 'POST', pathname: '/api/v1/orders', status: 422 }],
  );
  await installSyntheticCartRouting(
    page,
    quoteRequests,
    networkIssues,
    undefined,
    controller,
  );

  try {
    const initialQuote = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.goto('/cart');
    await assertResponseStatus(initialQuote, 200, 'CART_FOCUS_INITIAL_QUOTE_MISMATCH');
    await page.getByRole('radio', { exact: true, name: 'Dine in' }).click();
    const tableInput = page.getByLabel('Table number', { exact: true });
    await tableInput.fill('7');
    const placeOrder = page.getByRole('button', {
      exact: true,
      name: 'Place order and continue to payment',
    });
    await expect(placeOrder).toBeEnabled();

    const freshQuote = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    const createResponse = waitForApiResponse(page, 'POST', '/api/v1/orders');
    await placeOrder.focus();
    await page.keyboard.press('Enter');
    await assertResponseStatus(freshQuote, 200, 'CART_FOCUS_FRESH_QUOTE_MISMATCH');
    await expect.poll(() => controller.createBodies.length).toBe(1);
    const menuLink = page.getByRole('link', { exact: true, name: 'Menu' }).first();
    await menuLink.focus();
    await expect(menuLink).toBeFocused();

    releaseCreateResponse();
    await assertResponseStatus(
      createResponse,
      422,
      'CART_FOCUS_CREATE_STATUS_MISMATCH',
    );
    await expect(tableInput).toHaveAttribute('aria-invalid', 'true');
    await expect(menuLink).toBeFocused();
    await expect(tableInput).not.toBeFocused();
    expect(JSON.parse(controller.createBodies[0] ?? '{}')).toEqual({
      items: [{ menu_item_id: CART_IMAGE_ITEM_ID, quantity: 1 }],
      order_type: 'dine_in',
      table_number: 7,
    });
    expect(quoteRequests).toHaveLength(2);
    expect(networkIssues, 'CART_FOCUS_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

function syntheticOrderStatusResponse(status: SyntheticOrderStatus) {
  const updatedAtByStatus: Record<SyntheticOrderStatus, string> = {
    cancelled: '2026-08-26T12:18:00Z',
    preparing: '2026-08-26T12:08:00Z',
    ready: '2026-08-26T12:14:00Z',
  };
  return {
    created_at: '2026-08-26T12:00:00Z',
    currency: 'NOK',
    items: [
      {
        line_total_amount: 25_800,
        menu_item_id: CART_IMAGE_ITEM_ID,
        name: 'Roasted Root Vegetable Soup',
        quantity: 2,
        unit_price_amount: 12_900,
      },
      {
        line_total_amount: 15_900,
        menu_item_id: CART_FALLBACK_ITEM_ID,
        name: ORDER_STATUS_LONG_ITEM_NAME,
        quantity: 1,
        unit_price_amount: 15_900,
      },
    ],
    order_type: 'takeaway',
    public_order_number: ORDER_STATUS_PUBLIC_ORDER_NUMBER,
    status,
    subtotal_amount: 41_700,
    table_number: null,
    total_amount: 41_700,
    updated_at: updatedAtByStatus[status],
  };
}

async function installSyntheticOrderStatusRouting(
  page: Page,
  controller: SyntheticOrderStatusController,
): Promise<void> {
  const expectedBaseUrl = new URL(baseOrigin);
  page.on('websocket', (socket) => {
    const parsed = parseUrl(socket.url());
    if (
      parsed === null ||
      parsed.hostname !== expectedBaseUrl.hostname ||
      parsed.port !== expectedBaseUrl.port
    ) {
      controller.networkIssues.push('order-status-external-websocket');
    }
  });
  page.on('requestfailed', (request) => {
    const parsed = parseUrl(request.url());
    if (parsed !== null && parsed.origin === baseOrigin) {
      controller.networkIssues.push(
        `order-status-local-request-failed:${request.method()}:${parsed.pathname}`,
      );
    }
  });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('order-status-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(
        `order-status-external-request:${request.method()}:${parsed.hostname}`,
      );
      await route.abort();
      return;
    }
    if (parsed.pathname === ORDER_STATUS_API_PATH) {
      const headers = request.headers();
      controller.requests.push({
        authorization: headers.authorization ?? null,
        capability: headers['x-order-access-token'] ?? null,
        method: request.method(),
        postData: request.postData(),
      });
      if (
        request.method() !== 'GET' ||
        parsed.search !== '' ||
        request.postData() !== null ||
        headers.authorization !== undefined ||
        headers['x-order-access-token'] !== ORDER_STATUS_CAPABILITY
      ) {
        controller.networkIssues.push('order-status-request-contract-mismatch');
      }
      if (controller.failNext) {
        controller.failNext = false;
        controller.controlled503Count += 1;
        await route.fulfill({
          body: JSON.stringify({ detail: 'Synthetic recoverable failure' }),
          contentType: 'application/json',
          status: 503,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(syntheticOrderStatusResponse(controller.status)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `order-status-unexpected-api:${request.method()}:${parsed.pathname}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
}

async function assertOrderStatusSensitiveMaterialAbsent(page: Page): Promise<void> {
  const documentMarkup = await page.locator('html').evaluate((element) => {
    return (element as unknown as { outerHTML: string }).outerHTML;
  });
  safeInvariant(
    !documentMarkup.includes(ORDER_STATUS_CAPABILITY) &&
      !page.url().includes(ORDER_STATUS_CAPABILITY),
    'ORDER_STATUS_CAPABILITY_RENDERED',
  );
}

async function assertPurposefulOrderStatusMotion(
  statusPanel: Locator,
  primaryAction: Locator,
): Promise<void> {
  const [panelMotion, actionMotion] = await Promise.all([
    statusPanel.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.animationDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.animationDuration.split(',').map(durationMs)),
        iterationCount: style.animationIterationCount,
      };
    }),
    primaryAction.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.transitionDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.transitionDuration.split(',').map(durationMs)),
      };
    }),
  ]);
  safeInvariant(
    panelMotion.delayMs <= 0.011 &&
      panelMotion.durationMs >= 120 &&
      panelMotion.durationMs <= 240 &&
      panelMotion.iterationCount
        .split(',')
        .every((entry) => Number.parseFloat(entry.trim()) === 1),
    'ORDER_STATUS_PANEL_MOTION_MISMATCH',
  );
  safeInvariant(
    actionMotion.delayMs <= 0.011 &&
      actionMotion.durationMs >= 120 &&
      actionMotion.durationMs <= 240,
    'ORDER_STATUS_ACTION_MOTION_MISMATCH',
  );
}

async function assertPurposefulNeutralStateMotion(
  panel: Locator,
  primaryAction: Locator,
): Promise<void> {
  const [panelMotion, actionMotion] = await Promise.all([
    panel.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.animationDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.animationDuration.split(',').map(durationMs)),
        iterationCount: style.animationIterationCount,
      };
    }),
    primaryAction.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.transitionDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.transitionDuration.split(',').map(durationMs)),
      };
    }),
  ]);

  safeInvariant(
    panelMotion.delayMs <= 0.011 &&
      panelMotion.durationMs >= 120 &&
      panelMotion.durationMs <= 240 &&
      panelMotion.iterationCount
        .split(',')
        .every((entry) => Number.parseFloat(entry.trim()) === 1),
    'NEUTRAL_STATE_PANEL_MOTION_MISMATCH',
  );
  safeInvariant(
    actionMotion.delayMs <= 0.011 &&
      actionMotion.durationMs >= 120 &&
      actionMotion.durationMs <= 240,
    'NEUTRAL_STATE_ACTION_MOTION_MISMATCH',
  );
}

async function assertOrderStatusPresentation(
  page: Page,
  viewport: (typeof ORDER_STATUS_VIEWPORTS)[number],
  status: SyntheticOrderStatus,
  label: string,
  variant: 'info' | 'warning' | 'danger',
): Promise<{ backgroundColor: string; borderLeftColor: string }> {
  const main = page.getByRole('main');
  const statusPanel = main.getByRole('region', { exact: true, name: label });
  const statusHeading = statusPanel.getByRole('heading', {
    exact: true,
    level: 2,
    name: label,
  });
  const currentStatus = statusPanel.getByRole('list', {
    exact: true,
    name: 'Current order status',
  });
  const currentStep = currentStatus.getByRole('listitem');
  const brandName = main.getByText('Nordic Hearth', { exact: true });
  const brandMark = brandName.locator('..').locator('svg');
  const orderNumber = main.getByText(ORDER_STATUS_PUBLIC_ORDER_NUMBER, {
    exact: true,
  });
  const longItem = main.getByText(ORDER_STATUS_LONG_ITEM_NAME, { exact: true });
  const freshness = main.getByRole('region', {
    exact: true,
    name: 'Order update information',
  });
  const summary = main.getByRole('region', {
    exact: true,
    name: 'Order summary',
  });
  const primaryAction = main.locator('[data-action-priority="primary"]');

  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    main.getByRole('heading', { exact: true, level: 1, name: 'Order status' }),
  ).toBeVisible();
  await expect(brandName).toHaveCount(1);
  await expect(brandMark).toHaveCount(1);
  await expect(brandMark).toHaveAttribute('aria-hidden', 'true');
  await expect(brandMark).toHaveAttribute('focusable', 'false');
  await expect(brandMark).toHaveAttribute('height', '24');
  await expect(brandMark).toHaveAttribute('width', '24');
  await expect(main.getByRole('img')).toHaveCount(0);
  await expect(statusPanel).toHaveAttribute('data-order-status', status);
  await expect(statusHeading).toBeVisible();
  await expect(currentStep).toHaveCount(1);
  await expect(currentStep).toHaveAttribute('aria-current', 'step');
  await expect(currentStep).toHaveAttribute('data-order-status', status);
  await expect(currentStep.locator('[data-variant]')).toHaveAttribute(
    'data-variant',
    variant,
  );
  await expect(
    main.getByRole('status').filter({ hasText: `Current status: ${label}` }),
  ).toHaveCount(1);
  await expect(orderNumber).toBeVisible();
  safeInvariant(
    await orderNumber.evaluate((number) => {
      const status = number
        .closest('main')
        ?.querySelector('section[data-order-status]');
      // The DOM compare-position bit for a node following the reference node.
      const documentPositionFollowing = 4;
      return (
        status !== null &&
        status !== undefined &&
        (status.compareDocumentPosition(number) & documentPositionFollowing) !== 0
      );
    }),
    'ORDER_STATUS_HIERARCHY_MISMATCH',
  );
  await expect(longItem).toBeVisible();
  await expect(freshness.getByText('Order updated', { exact: true })).toBeVisible();
  await expect(freshness.locator('time')).toHaveAttribute(
    'datetime',
    syntheticOrderStatusResponse(status).updated_at,
  );
  await expect(summary).toBeVisible();
  await expect(primaryAction).toHaveCount(1);
  await expect(primaryAction).toHaveAccessibleName('Browse the menu');
  await expect(primaryAction).toHaveAttribute('href', '/menu');
  await expect(main.getByRole('progressbar')).toHaveCount(0);
  await expect(
    main.getByRole('heading', { exact: true, name: 'Order timeline' }),
  ).toHaveCount(0);
  await expect(main.getByText('Completed step', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Upcoming step', { exact: true })).toHaveCount(0);

  const customerCopy = await main.innerText();
  safeInvariant(
    !/\b(?:successful|succeeded|failed|pending|confirmed|paid|charged)\b|\bno charge\b|\bpayment went through\b/iu.test(
      customerCopy,
    ),
    'ORDER_STATUS_PAYMENT_CLAIM_RENDERED',
  );
  await assertMinimumTouchTarget(
    primaryAction,
    'ORDER_STATUS_PRIMARY_TARGET_TOO_SMALL',
  );
  await assertTextNotClipped(statusHeading, 'ORDER_STATUS_HEADING_CLIPPED');
  await assertTextNotClipped(orderNumber, 'ORDER_STATUS_NUMBER_CLIPPED');
  await assertTextNotClipped(longItem, 'ORDER_STATUS_LONG_ITEM_CLIPPED');
  await assertTextNotClipped(primaryAction, 'ORDER_STATUS_PRIMARY_LABEL_CLIPPED');
  await assertLongTextWraps(orderNumber);
  await assertLongTextWraps(longItem);
  await assertContainedWithin(statusPanel, main, 'ORDER_STATUS_PANEL_OUTSIDE_MAIN');
  await assertContainedWithin(summary, main, 'ORDER_STATUS_SUMMARY_OUTSIDE_MAIN');
  await assertContainedWithin(primaryAction, main, 'ORDER_STATUS_PRIMARY_OUTSIDE_MAIN');
  await assertNoFixedOrStickyOverlap(
    statusPanel,
    'ORDER_STATUS_PANEL_FIXED_OR_STICKY_OVERLAP',
  );
  await assertNoFixedOrStickyOverlap(
    primaryAction,
    'ORDER_STATUS_PRIMARY_FIXED_OR_STICKY_OVERLAP',
  );
  await assertResponsiveSurface(page);
  await assertOrderStatusSensitiveMaterialAbsent(page);
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ORDER_STATUS_VIEWPORT_CHANGED',
  );

  return statusPanel.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
    return {
      backgroundColor: style.backgroundColor,
      borderLeftColor: style.borderLeftColor,
    };
  });
}

async function assertOrderStatusViewport(
  page: Page,
  viewport: (typeof ORDER_STATUS_VIEWPORTS)[number],
  controller: SyntheticOrderStatusController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  controller.status = 'preparing';
  controller.failNext = true;
  const initialResponse = waitForApiResponse(page, 'GET', ORDER_STATUS_API_PATH);
  await page.goto(
    `${ORDER_STATUS_ROUTE}?payment_status=succeeded&redirect_status=failed&charged=true`,
  );
  await assertResponseStatus(
    initialResponse,
    503,
    'ORDER_STATUS_CONTROLLED_503_MISMATCH',
  );

  const alert = page.getByRole('alert');
  const retry = alert.getByRole('button', { exact: true, name: 'Retry status' });
  await expect(alert).toContainText('We could not refresh the order');
  await expect(retry).toBeEnabled();
  await assertMinimumTouchTarget(retry, 'ORDER_STATUS_RETRY_TARGET_TOO_SMALL');
  await blurActiveElement(page);
  await tabTo(page, retry, 64);
  await assertVisibleKeyboardFocus(retry);
  controller.failNext = true;
  const repeatedFailureResponse = waitForApiResponse(
    page,
    'GET',
    ORDER_STATUS_API_PATH,
  );
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    repeatedFailureResponse,
    503,
    'ORDER_STATUS_REPEATED_503_MISMATCH',
  );
  const remountedRetry = alert.getByRole('button', {
    exact: true,
    name: 'Retry status',
  });
  await expect(remountedRetry).toBeFocused();
  await assertVisibleKeyboardFocus(remountedRetry);

  const retryResponse = waitForApiResponse(page, 'GET', ORDER_STATUS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(retryResponse, 200, 'ORDER_STATUS_RETRY_STATUS_MISMATCH');

  const preparingTreatment = await assertOrderStatusPresentation(
    page,
    viewport,
    'preparing',
    'Preparing',
    'info',
  );
  const preparingPanel = page.getByRole('region', {
    exact: true,
    name: 'Preparing',
  });
  const primaryAction = page.locator('[data-action-priority="primary"]');
  await assertPurposefulOrderStatusMotion(preparingPanel, primaryAction);
  await blurActiveElement(page);
  await tabTo(page, primaryAction, 64);
  await assertVisibleKeyboardFocus(primaryAction);

  controller.status = 'ready';
  await page.reload();
  const readyTreatment = await assertOrderStatusPresentation(
    page,
    viewport,
    'ready',
    'Ready',
    'info',
  );
  safeInvariant(
    preparingTreatment.backgroundColor !== readyTreatment.backgroundColor ||
      preparingTreatment.borderLeftColor !== readyTreatment.borderLeftColor,
    'ORDER_STATUS_READY_NOT_VISUALLY_DISTINCT',
  );

  controller.status = 'cancelled';
  await page.reload();
  const cancelledTreatment = await assertOrderStatusPresentation(
    page,
    viewport,
    'cancelled',
    'Cancelled',
    'danger',
  );
  safeInvariant(
    cancelledTreatment.backgroundColor !== readyTreatment.backgroundColor ||
      cancelledTreatment.borderLeftColor !== readyTreatment.borderLeftColor,
    'ORDER_STATUS_CANCELLED_NOT_VISUALLY_DISTINCT',
  );
  await expect(
    page.getByText('Automatic updates have stopped for this final fulfilment state.', {
      exact: true,
    }),
  ).toBeVisible();

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  const cancelledPanel = page.getByRole('region', {
    exact: true,
    name: 'Cancelled',
  });
  const cancelledStep = cancelledPanel.getByRole('listitem');
  const cancelledPrimaryAction = page.locator('[data-action-priority="primary"]');
  await cancelledPrimaryAction.focus();
  await assertVisibleKeyboardFocus(cancelledPrimaryAction);
  await cancelledPrimaryAction.hover();
  const reducedPrimaryTransform = await cancelledPrimaryAction.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    return runtime.getComputedStyle(element as unknown as RuntimeElement).transform;
  });
  safeInvariant(
    reducedPrimaryTransform === 'none',
    'ORDER_STATUS_REDUCED_MOTION_TRANSFORM_MISMATCH',
  );
  await expect(cancelledStep.locator('[data-variant]')).toHaveAttribute(
    'data-variant',
    'danger',
  );
  await assertReducedMotionContract(page, [
    page.locator('main header'),
    cancelledPanel,
    page.getByRole('region', { name: 'Order update information' }),
    page.getByRole('region', { name: 'Order summary' }),
    cancelledPrimaryAction,
  ]);
  await assertResponsiveSurface(page);
}

async function assertNeutralPaymentStatePage(
  page: Page,
  viewport: (typeof CHECKOUT_VIEWPORTS)[number],
  expectation: (typeof NEUTRAL_PAYMENT_PAGES)[number],
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await page.goto(`${expectation.pathname}${expectation.search}`);
  await expect
    .poll(() => {
      const current = new URL(page.url());
      return { pathname: current.pathname, search: current.search };
    })
    .toEqual({ pathname: expectation.pathname, search: expectation.search });

  const main = page.getByRole('main');
  const panel = main.getByRole('region', { name: expectation.heading });
  const heading = panel.getByRole('heading', {
    level: 1,
    name: expectation.heading,
  });
  const brandName = panel.getByText('Nordic Hearth', { exact: true });
  const brandMark = panel.locator('svg');
  const orderNumber = panel.getByText(CHECKOUT_PUBLIC_ORDER_NUMBER, { exact: true });
  const primaryAction = panel.locator('[data-action-priority="primary"]');
  const secondaryAction = panel.getByRole('link', {
    name: expectation.secondaryActionName,
  });
  const menuAction = panel.getByRole('link', { name: 'Browse the menu' });

  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(panel).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(brandName).toHaveCount(1);
  await expect(brandMark).toHaveCount(1);
  await expect(brandMark).toHaveAttribute('aria-hidden', 'true');
  await expect(brandMark).toHaveAttribute('focusable', 'false');
  await expect(brandMark).toHaveAttribute('height', '24');
  await expect(brandMark).toHaveAttribute('width', '24');
  await expect(panel.getByRole('img')).toHaveCount(0);
  await expect(orderNumber).toBeVisible();
  await expect(primaryAction).toHaveCount(1);
  await expect(primaryAction).toHaveAccessibleName(expectation.primaryActionName);
  await expect(primaryAction).toHaveAttribute('href', expectation.primaryActionPath);
  await expect(secondaryAction).toHaveAttribute(
    'href',
    expectation.secondaryActionPath,
  );
  await expect(menuAction).toHaveAttribute('href', '/menu');
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0);
  if (expectation.kind === 'cancelled') {
    await expect(panel.getByRole('alert')).toHaveCount(0);
  }

  const customerCopy = await panel.innerText();
  safeInvariant(
    !/\b(?:successful|succeeded|failed|pending|confirmed|paid|charged)\b|\bno charge\b|\bpayment went through\b/iu.test(
      customerCopy,
    ),
    'NEUTRAL_STATE_PAYMENT_CLAIM_RENDERED',
  );
  await assertMinimumTouchTarget(
    primaryAction,
    'NEUTRAL_STATE_PRIMARY_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(
    secondaryAction,
    'NEUTRAL_STATE_SECONDARY_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(menuAction, 'NEUTRAL_STATE_MENU_TARGET_TOO_SMALL');
  await assertTextNotClipped(heading, 'NEUTRAL_STATE_HEADING_CLIPPED');
  await assertTextNotClipped(orderNumber, 'NEUTRAL_STATE_ORDER_NUMBER_CLIPPED');
  await assertTextNotClipped(primaryAction, 'NEUTRAL_STATE_PRIMARY_LABEL_CLIPPED');
  await assertContainedWithin(panel, main, 'NEUTRAL_STATE_PANEL_OUTSIDE_MAIN');
  await assertContainedWithin(
    primaryAction,
    panel,
    'NEUTRAL_STATE_PRIMARY_OUTSIDE_PANEL',
  );
  await assertResponsiveSurface(page);
  await assertPurposefulNeutralStateMotion(panel, primaryAction);

  await blurActiveElement(page);
  await tabTo(page, primaryAction, 64);
  await assertVisibleKeyboardFocus(primaryAction);
  await page.keyboard.press('Tab');
  await expect(secondaryAction).toBeFocused();
  await assertVisibleKeyboardFocus(secondaryAction);
  await page.keyboard.press('Tab');
  await expect(menuAction).toBeFocused();
  await assertVisibleKeyboardFocus(menuAction);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await primaryAction.focus();
  await assertVisibleKeyboardFocus(primaryAction);
  await primaryAction.hover();
  const reducedPrimaryTransform = await primaryAction.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    return runtime.getComputedStyle(element as unknown as RuntimeElement).transform;
  });
  safeInvariant(
    reducedPrimaryTransform === 'none',
    'NEUTRAL_STATE_REDUCED_MOTION_TRANSFORM_MISMATCH',
  );
  await assertReducedMotionContract(page, [
    panel,
    primaryAction,
    secondaryAction,
    menuAction,
  ]);
  await assertResponsiveSurface(page);
  await assertCheckoutSensitiveValuesAbsent(page);
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'NEUTRAL_STATE_VIEWPORT_CHANGED',
  );
}

async function assertCheckoutSensitiveValuesAbsent(page: Page): Promise<void> {
  const documentMarkup = await page.locator('html').evaluate((element) => {
    return (element as unknown as { outerHTML: string }).outerHTML;
  });
  const currentUrl = page.url();
  safeInvariant(
    !documentMarkup.includes(CHECKOUT_CAPABILITY) &&
      !documentMarkup.includes(CHECKOUT_ATTEMPT_ID) &&
      !currentUrl.includes(CHECKOUT_CAPABILITY) &&
      !currentUrl.includes(CHECKOUT_ATTEMPT_ID),
    'CHECKOUT_SENSITIVE_MATERIAL_RENDERED',
  );
}

async function assertCheckoutViewport(
  page: Page,
  viewport: (typeof CHECKOUT_VIEWPORTS)[number],
  trace: SyntheticCheckoutTrace,
  releaseFirstCheckoutResponse: () => void,
): Promise<void> {
  const orderResponse = waitForApiResponse(page, 'GET', CHECKOUT_ORDER_API_PATH);
  await page.goto(CHECKOUT_ROUTE);
  await assertResponseStatus(orderResponse, 200, 'CHECKOUT_ORDER_STATUS_MISMATCH');

  const heading = page.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Order created',
  });
  const summaryHeading = page.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'Order summary',
  });
  const paymentHeading = page.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'Continue to payment',
  });
  const summary = page.getByRole('region', {
    exact: true,
    name: 'Order summary',
  });
  const payment = page.getByRole('region', {
    exact: true,
    name: 'Continue to payment',
  });
  const orderItems = page.getByRole('list', {
    exact: true,
    name: 'Order items',
  });
  const checkoutButton = page.getByRole('button', {
    exact: true,
    name: CHECKOUT_CTA_NAME,
  });
  const returnToCart = page.getByRole('link', {
    exact: true,
    name: 'Return to cart',
  });
  const browseMenu = page.getByRole('link', {
    exact: true,
    name: 'Browse the menu',
  });
  const brandText = page.getByRole('main').getByText('Nordic Hearth', { exact: true });
  const brandLockup = brandText.locator('..');
  const brandMark = brandLockup.locator('svg');

  await expect(heading).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(2);
  await expect(summaryHeading).toBeVisible();
  await expect(paymentHeading).toBeVisible();
  await expect(brandText).toHaveCount(1);
  await expect(brandMark).toHaveCount(1);
  await expect(brandMark).toHaveAttribute('aria-hidden', 'true');
  await expect(brandMark).toHaveAttribute('focusable', 'false');
  await expect(brandMark).not.toHaveAttribute('role', 'img');
  await expect(summary).toHaveAttribute('aria-busy', 'false');
  await expect(orderItems.getByRole('listitem')).toHaveCount(2);
  const firstItem = orderItems
    .getByRole('listitem')
    .filter({ hasText: 'Roasted Root Vegetable Soup' });
  await expect(firstItem).toContainText('Qty 2');
  const longItem = orderItems
    .getByRole('listitem')
    .filter({ hasText: CHECKOUT_LONG_ITEM_NAME });
  await expect(longItem).toContainText('Qty 1');
  await expect(definitionValue(summary, 'Order type')).toHaveText('Takeaway');
  const subtotal = definitionValue(summary, 'Subtotal');
  const total = definitionValue(summary, 'Total');
  await expect(subtotal).toHaveText(/417[,.]00/u);
  await expect(total).toHaveText(/417[,.]00/u);
  await expect(summary).toContainText(/(?:NOK|kr)/iu);
  await expect(
    page.getByText('Payment is still required.', { exact: true }),
  ).toBeVisible();
  await expect(payment).toContainText(
    'Your order is not paid until payment is confirmed.',
  );
  for (const unexpectedLabel of ['Delivery fee', 'Discount', 'Fees', 'Tax', 'Tip']) {
    await expect(
      summary.locator('dt').filter({
        hasText: new RegExp(`^${unexpectedLabel}$`, 'u'),
      }),
    ).toHaveCount(0);
  }

  await expect(checkoutButton).toBeEnabled();
  await expect(checkoutButton).toHaveAccessibleName(CHECKOUT_CTA_NAME);
  await expect(returnToCart).toHaveAttribute('href', '/cart');
  await expect(browseMenu).toHaveAttribute('href', '/menu');
  await assertMinimumTouchTarget(checkoutButton, 'CHECKOUT_CTA_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(returnToCart, 'CHECKOUT_CART_LINK_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(browseMenu, 'CHECKOUT_MENU_LINK_TARGET_TOO_SMALL');
  await assertTextNotClipped(heading, 'CHECKOUT_HEADING_CLIPPED');
  await assertTextNotClipped(summaryHeading, 'CHECKOUT_SUMMARY_HEADING_CLIPPED');
  await assertTextNotClipped(paymentHeading, 'CHECKOUT_PAYMENT_HEADING_CLIPPED');
  await assertTextNotClipped(
    longItem.getByText(CHECKOUT_LONG_ITEM_NAME, { exact: true }),
    'CHECKOUT_LONG_ITEM_NAME_CLIPPED',
  );
  await assertTextNotClipped(
    firstItem.locator(':scope > span').last(),
    'CHECKOUT_FIRST_LINE_AMOUNT_CLIPPED',
  );
  await assertTextNotClipped(
    longItem.locator(':scope > span').last(),
    'CHECKOUT_LONG_LINE_AMOUNT_CLIPPED',
  );
  await assertTextNotClipped(subtotal, 'CHECKOUT_SUBTOTAL_CLIPPED');
  await assertTextNotClipped(total, 'CHECKOUT_TOTAL_CLIPPED');
  await assertTextNotClipped(checkoutButton, 'CHECKOUT_CTA_LABEL_CLIPPED');
  const main = page.locator('#main-content');
  await assertContainedWithin(summary, main, 'CHECKOUT_SUMMARY_OUTSIDE_MAIN');
  await assertContainedWithin(payment, main, 'CHECKOUT_PAYMENT_OUTSIDE_MAIN');
  await assertContainedWithin(orderItems, summary, 'CHECKOUT_ITEMS_OUTSIDE_SUMMARY');
  await assertContainedWithin(checkoutButton, payment, 'CHECKOUT_CTA_OUTSIDE_PAYMENT');
  await assertResponsiveSurface(page);
  await assertNoFixedOrStickyOverlap(
    checkoutButton,
    'CHECKOUT_CTA_FIXED_OR_STICKY_OVERLAP',
  );
  await assertNoFixedOrStickyOverlap(
    summary,
    'CHECKOUT_SUMMARY_FIXED_OR_STICKY_OVERLAP',
  );
  await assertNoFixedOrStickyOverlap(
    payment,
    'CHECKOUT_PAYMENT_FIXED_OR_STICKY_OVERLAP',
  );
  await assertReducedMotionContract(page, [
    brandLockup,
    heading,
    summary,
    payment,
    checkoutButton,
    returnToCart,
  ]);
  await assertCheckoutSensitiveValuesAbsent(page);

  await expect.poll(() => trace.orderRequests.length).toBe(1);
  expect(trace.orderRequests).toEqual([
    {
      authorization: null,
      capability: CHECKOUT_CAPABILITY,
      idempotencyKey: null,
      postData: null,
    },
  ]);

  await blurActiveElement(page);
  await tabTo(page, returnToCart, 64);
  await assertVisibleKeyboardFocus(returnToCart);
  await blurActiveElement(page);
  await tabTo(page, checkoutButton, 64);
  await assertVisibleKeyboardFocus(checkoutButton);
  const readyButtonBox = await checkoutButton.boundingBox();
  safeInvariant(readyButtonBox !== null, 'CHECKOUT_READY_CTA_BOX_MISSING');

  await checkoutButton.click();
  await expect.poll(() => trace.checkoutRequests.length).toBe(1);
  await expect(checkoutButton).toBeDisabled();
  await expect(checkoutButton).toHaveAttribute('aria-busy', 'true');
  await expect(checkoutButton).toHaveAccessibleName(CHECKOUT_CTA_NAME);
  const pendingStatus = page.getByRole('status').filter({
    hasText: /Creating secure checkout/u,
  });
  await expect(pendingStatus).toBeVisible();
  const pendingButtonBox = await checkoutButton.boundingBox();
  safeInvariant(pendingButtonBox !== null, 'CHECKOUT_PENDING_CTA_BOX_MISSING');
  safeInvariant(
    Math.abs(pendingButtonBox.x - readyButtonBox.x) <= OVERFLOW_TOLERANCE_PX &&
      Math.abs(pendingButtonBox.y - readyButtonBox.y) <= OVERFLOW_TOLERANCE_PX &&
      Math.abs(pendingButtonBox.width - readyButtonBox.width) <=
        OVERFLOW_TOLERANCE_PX &&
      Math.abs(pendingButtonBox.height - readyButtonBox.height) <=
        OVERFLOW_TOLERANCE_PX,
    'CHECKOUT_LOADING_CTA_GEOMETRY_SHIFTED',
  );
  await checkoutButton.evaluate((element) => {
    (element as unknown as { click: () => void }).click();
  });
  await page.keyboard.press('Enter');
  await waitForSettledLayout(page);
  await expect.poll(() => trace.checkoutRequests.length).toBe(1);
  await assertTextNotClipped(pendingStatus, 'CHECKOUT_PENDING_STATUS_CLIPPED');
  await assertResponsiveSurface(page);
  await assertNoFixedOrStickyOverlap(
    checkoutButton,
    'CHECKOUT_PENDING_CTA_FIXED_OR_STICKY_OVERLAP',
  );
  await assertReducedMotionContract(page, [checkoutButton, pendingStatus]);

  const unsafeResponse = waitForApiResponse(page, 'POST', CHECKOUT_SESSION_API_PATH);
  const preserveMovedCheckoutFocus = viewport.width === 1280 && viewport.height === 800;
  if (preserveMovedCheckoutFocus) {
    await returnToCart.focus();
    await expect(returnToCart).toBeFocused();
  }
  releaseFirstCheckoutResponse();
  await assertResponseStatus(
    unsafeResponse,
    201,
    'CHECKOUT_UNSAFE_RESPONSE_STATUS_MISMATCH',
  );
  const alert = page.getByRole('alert').filter({
    hasText: 'Checkout could not continue',
  });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(
    'The checkout service returned an unsafe or invalid response. No redirect was attempted.',
  );
  await waitForSettledLayout(page);
  const alertFocusTarget = alert.locator('..');
  if (preserveMovedCheckoutFocus) {
    await expect(returnToCart).toBeFocused();
    await assertVisibleKeyboardFocus(returnToCart);
  } else {
    await assertVisibleKeyboardFocus(alertFocusTarget);
  }
  await expect(checkoutButton).toBeEnabled();
  await expect(checkoutButton).not.toHaveAttribute('aria-busy', 'true');
  await expect(checkoutButton).toHaveAccessibleName(CHECKOUT_CTA_NAME);
  await assertLocation(page, CHECKOUT_ROUTE);
  expect(trace.providerRequests, 'CHECKOUT_UNSAFE_RESPONSE_REDIRECTED').toEqual([]);
  await expect(
    page.getByText(/Payment successful|Payment complete|Order confirmed/u),
  ).toHaveCount(0);
  await assertTextNotClipped(alert, 'CHECKOUT_ERROR_ALERT_CLIPPED');
  await assertContainedWithin(alert, payment, 'CHECKOUT_ERROR_ALERT_OUTSIDE_PAYMENT');
  await assertResponsiveSurface(page);
  await assertNoFixedOrStickyOverlap(alert, 'CHECKOUT_ALERT_FIXED_OR_STICKY_OVERLAP');
  await assertReducedMotionContract(page, [alertFocusTarget, alert, checkoutButton]);
  await assertCheckoutSensitiveValuesAbsent(page);

  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(checkoutButton);
  const retryResponse = waitForApiResponse(page, 'POST', CHECKOUT_SESSION_API_PATH);
  const providerResponse = waitForApiResponse(page, 'GET', CHECKOUT_PROVIDER_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    retryResponse,
    201,
    'CHECKOUT_RETRY_RESPONSE_STATUS_MISMATCH',
  );
  await assertResponseStatus(
    providerResponse,
    200,
    'CHECKOUT_PROVIDER_BOUNDARY_STATUS_MISMATCH',
  );
  await assertLocation(page, CHECKOUT_PROVIDER_PATH);
  await expect(
    page.getByRole('heading', {
      exact: true,
      level: 1,
      name: 'Test payment provider boundary',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Payment remains pending.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(/Payment successful|Payment complete|Order confirmed/u),
  ).toHaveCount(0);

  await expect.poll(() => trace.checkoutRequests.length).toBe(2);
  expect(trace.checkoutRequests).toEqual([
    {
      authorization: null,
      capability: CHECKOUT_CAPABILITY,
      idempotencyKey: CHECKOUT_ATTEMPT_ID,
      postData: null,
    },
    {
      authorization: null,
      capability: CHECKOUT_CAPABILITY,
      idempotencyKey: CHECKOUT_ATTEMPT_ID,
      postData: null,
    },
  ]);
  expect(trace.providerRequests).toEqual([`GET ${CHECKOUT_PROVIDER_PATH}`]);
  expect(
    trace.observedLocalRequests.filter((entry) =>
      entry.includes(CHECKOUT_COMPLETION_PATH),
    ),
    'CHECKOUT_PROVIDER_COMPLETION_CALLED',
  ).toEqual([]);
  expect(
    trace.observedLocalRequests.filter((entry) =>
      entry.includes('/api/v1/stripe/webhook'),
    ),
    'CHECKOUT_WEBHOOK_CALLED',
  ).toEqual([]);
  expect(
    trace.observedLocalRequests.filter(
      (entry) =>
        /^(?:DELETE|PATCH|POST|PUT) /u.test(entry) &&
        entry !== `POST ${CHECKOUT_SESSION_API_PATH}`,
    ),
    'CHECKOUT_UNEXPECTED_MUTATION_CALLED',
  ).toEqual([]);
  await assertCheckoutSensitiveValuesAbsent(page);
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'CHECKOUT_VIEWPORT_CHANGED',
  );
}

async function assertPublicLayouts(page: Page): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    await openMenu(page);
    await expect(
      page.getByRole('complementary', { name: 'Cart summary' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);
    await assertCategoryNavigationReachable(page);

    await page.goto('/login');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);

    await page.goto('/register');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Create account' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);
  }
}

async function assertCustomerKeyboardContracts(page: Page): Promise<void> {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto('/');
  await blurActiveElement(page);
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(skipLink);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect.poll(() => new URL(page.url()).hash).toBe('#main-content');

  await page.goto('/');
  await blurActiveElement(page);
  const menuLink = page
    .getByRole('navigation', { name: 'Start ordering' })
    .getByRole('link', { exact: true, name: 'View menu' });
  await tabTo(page, menuLink);
  await assertVisibleKeyboardFocus(menuLink);
  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.keyboard.press('Enter');
  await assertResponseStatus(menuResponse, 200, 'KEYBOARD_MENU_STATUS_MISMATCH');
  await assertLocation(page, '/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();

  const categoryButton = page
    .getByRole('navigation', { name: 'Menu categories' })
    .getByRole('button', { exact: true, name: 'Desserts' });
  await expect(categoryButton).toBeVisible();
  await blurActiveElement(page);
  await tabTo(page, categoryButton);
  await assertVisibleKeyboardFocus(categoryButton);
  await page.keyboard.press('Enter');
  await expect(categoryButton).toHaveAttribute('aria-pressed', 'true');

  const unavailableCard = page.getByRole('article', {
    exact: true,
    name: UNAVAILABLE_MENU_ITEM_NAME,
  });
  const unavailableButton = unavailableCard.getByRole('button', {
    name: 'Unavailable',
  });
  await expect(unavailableButton).toBeDisabled();
  await blurActiveElement(page);
  const disabledCouldFocus = await unavailableButton.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    (element as unknown as RuntimeElement).focus?.();
    return runtime.document.activeElement === (element as unknown as RuntimeElement);
  });
  safeInvariant(!disabledCouldFocus, 'DISABLED_CONTROL_KEYBOARD_FOCUSABLE');
  await page.keyboard.press('Enter');
  await expect(
    page
      .getByRole('complementary', { name: 'Cart summary' })
      .getByText('0 items in cart'),
  ).toBeVisible();
}

async function openSyntheticAccount(page: Page, reload = false): Promise<void> {
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const accountResponse = waitForApiResponse(page, 'GET', ACCOUNT_ORDERS_API_PATH);
  if (reload) {
    await page.reload();
  } else {
    await page.goto('/account');
  }
  await Promise.all([
    assertResponseStatus(
      currentUserResponse,
      200,
      'ACCOUNT_CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(accountResponse, 200, 'ACCOUNT_LIST_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByRole('heading', { exact: true, level: 1, name: 'My orders' }),
  ).toBeVisible();
}

function accountOrderSurface(orders: Locator, publicOrderNumber: string): Locator {
  return orders.locator(`li[data-order-number="${publicOrderNumber}"]`);
}

async function assertAccountStatusVariant(
  orderSurface: Locator,
  label: string,
  variant: string,
): Promise<Locator> {
  const labelNode = orderSurface.getByText(label, { exact: true });
  await expect(labelNode).toBeVisible();
  const badge = labelNode.locator('..');
  await expect(badge).toHaveAttribute('data-variant', variant);
  return badge;
}

async function assertAccountViewport(
  page: Page,
  viewport: (typeof ACCOUNT_VIEWPORTS)[number],
  controller: SyntheticAccountController,
  releaseRetryResponse: () => void,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await openSyntheticAccount(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole('main').getByText('Nordic Hearth', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { exact: true, name: 'Nordic Hearth' }),
  ).toHaveCount(0);

  const errorNotice = page.getByRole('alert');
  await expect(errorNotice).toContainText('Unable to load your orders');
  await expect(errorNotice).toContainText(/unexpected response/iu);
  await expect(errorNotice).not.toContainText('must never reach visible customer copy');
  const retryButton = errorNotice.locator('button');
  await expect(retryButton).toHaveAccessibleName('Retry');
  await assertMinimumTouchTarget(retryButton, 'ACCOUNT_RETRY_TARGET_TOO_SMALL');
  await assertResponsiveSurface(page);

  controller.mode = 'paged';
  await blurActiveElement(page);
  await tabTo(page, retryButton);
  await assertVisibleKeyboardFocus(retryButton);
  const retryResponse = waitForApiResponse(page, 'GET', ACCOUNT_ORDERS_API_PATH);
  await page.keyboard.press('Enter');
  await expect(errorNotice).toHaveCount(0);
  await expect(retryButton).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({
      hasText: 'Loading your orders',
    }),
  ).toBeVisible();
  const preserveMovedAccountFocus = viewport.width === 1280 && viewport.height === 800;
  const accountMenuLink = page.getByRole('link', { exact: true, name: 'Menu' }).first();
  if (preserveMovedAccountFocus) {
    await accountMenuLink.focus();
    await expect(accountMenuLink).toBeFocused();
  }
  releaseRetryResponse();
  await assertResponseStatus(retryResponse, 200, 'ACCOUNT_RETRY_STATUS_MISMATCH');

  const firstPageSummary = page.getByText(/^Showing 1.+3 of 51$/u);
  await expect(firstPageSummary).toBeVisible();
  await expect(firstPageSummary).toHaveAttribute('tabindex', '-1');
  await waitForSettledLayout(page);
  if (preserveMovedAccountFocus) {
    await expect(accountMenuLink).toBeFocused();
    await assertVisibleKeyboardFocus(accountMenuLink);
  } else {
    await expect(firstPageSummary).toBeFocused();
  }
  const orders = await assertAccountCollectionLayout(page);
  const orderNumbers = await orders
    .locator('a[href^="/account/orders/"]')
    .allTextContents();
  expect(orderNumbers.map((value) => value.trim())).toEqual([
    ACCOUNT_LONG_ORDER_NUMBER,
    ACCOUNT_CANCELLED_ORDER_NUMBER,
    ACCOUNT_ACTIVE_ORDER_NUMBER,
  ]);

  const longOrderLink = orders.getByRole('link', {
    exact: true,
    name: ACCOUNT_LONG_ORDER_NUMBER,
  });
  await expect(longOrderLink).toHaveCount(1);
  await expect(longOrderLink).toHaveAttribute(
    'href',
    `/account/orders/${ACCOUNT_LONG_ORDER_NUMBER}`,
  );
  await assertMinimumTouchTarget(
    longOrderLink,
    'ACCOUNT_ORDER_ACTION_TARGET_TOO_SMALL',
  );
  await assertLongTextWraps(longOrderLink);
  const longOrder = accountOrderSurface(orders, ACCOUNT_LONG_ORDER_NUMBER);
  await expect(longOrder).toContainText(/98(?:[,.\s]*)765/u);
  await expect(longOrder).toContainText('NOK');
  await expect(
    longOrder.locator('time[datetime="2026-08-26T08:15:00Z"]'),
  ).toBeVisible();
  await expect(
    longOrder.locator('time[datetime="2026-08-26T09:05:00Z"]'),
  ).toBeVisible();
  const completedBadge = await assertAccountStatusVariant(
    longOrder,
    'Completed',
    'success',
  );

  const cancelledOrder = accountOrderSurface(orders, ACCOUNT_CANCELLED_ORDER_NUMBER);
  const cancelledBadge = await assertAccountStatusVariant(
    cancelledOrder,
    'Cancelled',
    'danger',
  );
  await expect(cancelledBadge).not.toHaveAttribute('data-variant', 'success');
  const activeOrder = accountOrderSurface(orders, ACCOUNT_ACTIVE_ORDER_NUMBER);
  await assertAccountStatusVariant(activeOrder, 'Preparing', 'warning');

  const mainText = await page.locator('#main-content').innerText();
  expect(mainText).not.toMatch(/\b(?:paid|payment|stripe)\b/iu);
  expect(mainText).not.toContain(ACCOUNT_TOKEN);
  expect(mainText).not.toContain('must never reach visible customer copy');
  await assertTextNotClipped(completedBadge, 'ACCOUNT_COMPLETED_STATUS_CLIPPED');
  await assertTextNotClipped(cancelledBadge, 'ACCOUNT_CANCELLED_STATUS_CLIPPED');
  await assertResponsiveSurface(page);

  const pagination = page.getByRole('navigation', {
    name: 'Your orders pagination',
  });
  await expect(pagination).toBeVisible();
  const previousButton = pagination.getByRole('button', {
    exact: true,
    name: 'Previous',
  });
  const nextButton = pagination.getByRole('button', {
    exact: true,
    name: 'Next',
  });
  await expect(previousButton).toBeDisabled();
  await expect(nextButton).toBeEnabled();
  await assertMinimumTouchTarget(previousButton, 'ACCOUNT_PREVIOUS_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(nextButton, 'ACCOUNT_NEXT_TARGET_TOO_SMALL');

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await assertReducedMotionContract(page, [
    page.locator('#main-content > section').first(),
    orders,
    completedBadge,
    cancelledBadge,
    pagination,
    nextButton,
  ]);
  await assertResponsiveSurface(page);

  await blurActiveElement(page);
  await tabTo(page, nextButton);
  await assertVisibleKeyboardFocus(nextButton);
  const nextResponse = waitForApiResponse(page, 'GET', ACCOUNT_ORDERS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(nextResponse, 200, 'ACCOUNT_NEXT_STATUS_MISMATCH');
  const secondPageSummary = page.getByText(/^Showing 51.+51 of 51$/u);
  await expect(secondPageSummary).toBeFocused();
  const secondPageOrders = await assertAccountCollectionLayout(page);
  const readyOrder = accountOrderSurface(secondPageOrders, ACCOUNT_FINAL_ORDER_NUMBER);
  const readyBadge = await assertAccountStatusVariant(readyOrder, 'Ready', 'info');
  await expect(readyBadge).not.toHaveAttribute('data-variant', 'success');
  const secondPagePagination = page.getByRole('navigation', {
    name: 'Your orders pagination',
  });
  const secondPagePrevious = secondPagePagination.getByRole('button', {
    exact: true,
    name: 'Previous',
  });
  const secondPageNext = secondPagePagination.getByRole('button', {
    exact: true,
    name: 'Next',
  });
  await expect(secondPagePrevious).toBeEnabled();
  await expect(secondPageNext).toBeDisabled();
  const disabledNextFocused = await secondPageNext.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    (element as unknown as RuntimeElement).focus?.();
    return runtime.document.activeElement === (element as unknown as RuntimeElement);
  });
  safeInvariant(!disabledNextFocused, 'ACCOUNT_DISABLED_NEXT_FOCUSABLE');
  await assertResponsiveSurface(page);

  await blurActiveElement(page);
  await tabTo(page, secondPagePrevious);
  await assertVisibleKeyboardFocus(secondPagePrevious);
  const previousResponse = waitForApiResponse(page, 'GET', ACCOUNT_ORDERS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(previousResponse, 200, 'ACCOUNT_PREVIOUS_STATUS_MISMATCH');
  await expect(page.getByText(/^Showing 1.+3 of 51$/u)).toBeFocused();

  controller.mode = 'single';
  await openSyntheticAccount(page, true);
  const singlePageSummary = page.getByText(/^Showing 1.+1 of 1$/u);
  await expect(singlePageSummary).toBeVisible();
  const singlePageOrders = await assertAccountCollectionLayout(page);
  await assertAccountStatusVariant(
    accountOrderSurface(singlePageOrders, ACCOUNT_FINAL_ORDER_NUMBER),
    'Ready',
    'info',
  );
  await expect(
    page.getByRole('navigation', { name: 'Your orders pagination' }),
  ).toHaveCount(0);
  await assertResponsiveSurface(page);

  controller.mode = 'empty';
  await openSyntheticAccount(page, true);
  const emptyHeading = page.getByRole('heading', {
    exact: true,
    name: 'No orders yet',
  });
  await expect(emptyHeading).toBeVisible();
  const emptyState = emptyHeading.locator('..');
  const menuLink = emptyState.getByRole('link', { name: /menu/iu });
  await expect(menuLink).toHaveAttribute('href', '/menu');
  await assertMinimumTouchTarget(menuLink, 'ACCOUNT_EMPTY_MENU_TARGET_TOO_SMALL');
  await expect(
    page.getByRole('navigation', { name: 'Your orders pagination' }),
  ).toHaveCount(0);
  await blurActiveElement(page);
  await tabTo(page, menuLink);
  await assertVisibleKeyboardFocus(menuLink);
  await assertResponsiveSurface(page);
  await assertReducedMotionContract(page, [
    page.locator('#main-content > section').first(),
    emptyState,
    menuLink,
  ]);

  expect(
    controller.orderRequests.map(({ mode, search }) => ({ mode, search })),
  ).toEqual([
    { mode: 'error', search: '?limit=50&offset=0' },
    { mode: 'paged', search: '?limit=50&offset=0' },
    { mode: 'paged', search: '?limit=50&offset=50' },
    { mode: 'paged', search: '?limit=50&offset=0' },
    { mode: 'single', search: '?limit=50&offset=0' },
    { mode: 'empty', search: '?limit=50&offset=0' },
  ]);
  for (const request of controller.orderRequests) {
    expect(request).toMatchObject({
      authorization: `Bearer ${ACCOUNT_TOKEN}`,
      capability: null,
      method: 'GET',
      postData: null,
    });
  }
  expect(controller.meAuthorizations).toEqual([
    `Bearer ${ACCOUNT_TOKEN}`,
    `Bearer ${ACCOUNT_TOKEN}`,
    `Bearer ${ACCOUNT_TOKEN}`,
  ]);
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ACCOUNT_VIEWPORT_CHANGED',
  );
}

async function openSyntheticAccountDetail(
  page: Page,
  publicOrderNumber: string,
  expectedStatus: number,
): Promise<void> {
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const detailResponse = waitForApiResponse(
    page,
    'GET',
    accountDetailApiPath(publicOrderNumber),
  );
  await page.goto(`/account/orders/${publicOrderNumber}`);
  await Promise.all([
    assertResponseStatus(
      currentUserResponse,
      200,
      'ACCOUNT_DETAIL_CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(
      detailResponse,
      expectedStatus,
      'ACCOUNT_DETAIL_RESPONSE_STATUS_MISMATCH',
    ),
  ]);
}

async function assertAccountDetailNavigation(page: Page): Promise<{
  backLink: Locator;
  menuLink: Locator;
}> {
  const main = page.locator('#main-content');
  const backLink = main.getByRole('link', {
    exact: true,
    name: 'Back to orders',
  });
  const menuLink = main.getByRole('link', { exact: true, name: 'View menu' });
  await expect(backLink).toHaveCount(1);
  await expect(backLink).toHaveAttribute('href', '/account');
  await expect(menuLink).toHaveCount(1);
  await expect(menuLink).toHaveAttribute('href', '/menu');
  await assertMinimumTouchTarget(
    backLink,
    'ACCOUNT_DETAIL_BACK_ACTION_TARGET_TOO_SMALL',
  );
  await assertMinimumTouchTarget(
    menuLink,
    'ACCOUNT_DETAIL_MENU_ACTION_TARGET_TOO_SMALL',
  );
  const positions = await Promise.all(
    [backLink, menuLink].map((locator) =>
      locator.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return runtime.getComputedStyle(element as unknown as RuntimeElement).position;
      }),
    ),
  );
  safeInvariant(
    positions.every((position) => position !== 'fixed' && position !== 'sticky'),
    'ACCOUNT_DETAIL_ACTION_OVERLAY_POSITION_FORBIDDEN',
  );
  return { backLink, menuLink };
}

async function assertAccountDetailStatus(
  page: Page,
  status: SyntheticAccountDetailStatus,
  label: string,
  variant: string,
): Promise<{ statusBadge: Locator; statusSurface: Locator }> {
  const main = page.locator('#main-content');
  const statusSurface = main.locator(`[data-order-status="${status}"]`);
  await expect(statusSurface).toHaveCount(1);
  await expect(
    statusSurface.getByRole('heading', { exact: true, level: 2, name: label }),
  ).toBeVisible();
  const statusBadge = statusSurface.locator(`[data-variant="${variant}"]`);
  await expect(statusBadge).toHaveCount(1);
  await expect(statusBadge).toBeVisible();
  await expect(statusBadge).toContainText(label);
  await assertTextNotClipped(
    statusBadge,
    'ACCOUNT_DETAIL_CURRENT_STATUS_BADGE_CLIPPED',
  );
  return { statusBadge, statusSurface };
}

async function assertAccountDetailSuccessSurface(
  page: Page,
  publicOrderNumber: string,
  status: SyntheticAccountDetailStatus,
  label: string,
  variant: string,
) {
  const main = page.locator('#main-content');
  const heading = main.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Order details',
  });
  await expect(heading).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(main.getByText('Nordic Hearth', { exact: true })).toBeVisible();
  await expect(
    main.getByRole('img', { exact: true, name: 'Nordic Hearth' }),
  ).toHaveCount(0);

  const orderNumber = main.getByText(publicOrderNumber, { exact: true });
  await expect(orderNumber).toHaveCount(1);
  await expect(orderNumber).toBeVisible();
  await assertLongTextWraps(orderNumber);
  const createdTimes = main.locator('time[datetime="2026-08-27T08:15:00Z"]');
  await expect(createdTimes).toHaveCount(2);
  await expect(createdTimes.first()).toBeVisible();

  const { statusBadge, statusSurface } = await assertAccountDetailStatus(
    page,
    status,
    label,
    variant,
  );
  await expect(
    main.getByRole('heading', { exact: true, name: 'Order timeline' }),
  ).toHaveCount(0);

  const orderedItems = main.getByRole('list', { exact: true, name: 'Ordered items' });
  await expect(orderedItems).toBeVisible();
  const itemRows = orderedItems.getByRole('listitem');
  await expect(itemRows).toHaveCount(2);
  await expect(itemRows.nth(0)).toContainText(ACCOUNT_DETAIL_LONG_ITEM_NAME);
  await expect(itemRows.nth(0)).toContainText(/Quantity\s*:?\s*2/u);
  await expect(itemRows.nth(0)).toContainText(/129[,.]00/u);
  await expect(itemRows.nth(0)).toContainText(/258[,.]00/u);
  await expect(itemRows.nth(1)).toContainText(ACCOUNT_DETAIL_SECOND_ITEM_NAME);
  await expect(itemRows.nth(1)).toContainText(/Quantity\s*:?\s*1/u);
  const longItemName = itemRows
    .nth(0)
    .getByText(ACCOUNT_DETAIL_LONG_ITEM_NAME, { exact: true });
  await assertLongTextWraps(longItemName);

  const summaryHeading = main.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'What you ordered',
  });
  await expect(summaryHeading).toBeVisible();
  const summary = main.getByRole('region', {
    exact: true,
    name: 'What you ordered',
  });
  await expect(summary).toHaveCount(1);
  const subtotalValue = definitionValue(summary, 'Subtotal');
  const totalValue = definitionValue(summary, 'Total');
  await expect(subtotalValue).toContainText(/523[,.]45/u);
  await expect(totalValue).toContainText(/98[\s\u00a0\u202f.,]*765[,.]43/u);
  await expect(totalValue).not.toContainText(/417[,.]00/u);
  await assertTextNotClipped(totalValue, 'ACCOUNT_DETAIL_TOTAL_CLIPPED');

  const mainText = await main.innerText();
  expect(mainText).not.toMatch(/\b(?:owner|ownership|paid|payment|stripe)\b/iu);
  expect(mainText).not.toContain(ACCOUNT_TOKEN);
  expect(mainText).not.toContain(ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY);

  const { backLink, menuLink } = await assertAccountDetailNavigation(page);
  await assertResponsiveSurface(page);
  return {
    backLink,
    heading,
    itemRows,
    menuLink,
    orderedItems,
    statusBadge,
    statusSurface,
    summary,
    totalValue,
  };
}

async function assertAccountDetailViewport(
  page: Page,
  viewport: (typeof ACCOUNT_VIEWPORTS)[number],
  controller: SyntheticAccountDetailController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

  await openSyntheticAccountDetail(page, ACCOUNT_ACTIVE_ORDER_NUMBER, 200);
  const activeSurface = await assertAccountDetailSuccessSurface(
    page,
    ACCOUNT_ACTIVE_ORDER_NUMBER,
    'preparing',
    'Preparing',
    'warning',
  );
  await blurActiveElement(page);
  await tabTo(page, activeSurface.backLink);
  await assertVisibleKeyboardFocus(activeSurface.backLink);
  await blurActiveElement(page);
  await tabTo(page, activeSurface.menuLink);
  await assertVisibleKeyboardFocus(activeSurface.menuLink);

  await openSyntheticAccountDetail(page, ACCOUNT_LONG_ORDER_NUMBER, 200);
  await assertAccountDetailSuccessSurface(
    page,
    ACCOUNT_LONG_ORDER_NUMBER,
    'completed',
    'Completed',
    'success',
  );

  await openSyntheticAccountDetail(page, ACCOUNT_CANCELLED_ORDER_NUMBER, 200);
  const cancelledSurface = await assertAccountDetailSuccessSurface(
    page,
    ACCOUNT_CANCELLED_ORDER_NUMBER,
    'cancelled',
    'Cancelled',
    'danger',
  );
  await expect(cancelledSurface.statusBadge).not.toHaveAttribute(
    'data-variant',
    'success',
  );

  await openSyntheticAccountDetail(page, ACCOUNT_DETAIL_ACCESS_ORDER_NUMBER, 404);
  const main = page.locator('#main-content');
  await expect(
    main.getByRole('heading', {
      exact: true,
      level: 1,
      name: 'Order unavailable',
    }),
  ).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    main.getByText('This order is unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole('button', { exact: true, name: 'Retry order details' }),
  ).toHaveCount(0);
  await expect(main).not.toContainText(ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY);
  const accessBackLink = main.getByRole('link', {
    exact: true,
    name: 'Back to orders',
  });
  await expect(accessBackLink).toHaveAttribute('href', '/account');
  await assertMinimumTouchTarget(
    accessBackLink,
    'ACCOUNT_DETAIL_ACCESS_BACK_TARGET_TOO_SMALL',
  );
  await assertResponsiveSurface(page);

  await openSyntheticAccountDetail(page, ACCOUNT_DETAIL_RETRY_ORDER_NUMBER, 503);
  await expect(
    main.getByRole('heading', {
      exact: true,
      level: 1,
      name: 'Unable to load order details',
    }),
  ).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(main).not.toContainText(ACCOUNT_DETAIL_PRIVATE_RESPONSE_COPY);
  const retryButton = main.getByRole('button', {
    exact: true,
    name: 'Retry order details',
  });
  await assertMinimumTouchTarget(retryButton, 'ACCOUNT_DETAIL_RETRY_TARGET_TOO_SMALL');
  await blurActiveElement(page);
  await tabTo(page, retryButton);
  await assertVisibleKeyboardFocus(retryButton);
  const preserveMovedDetailFocus = viewport.width === 375 && viewport.height === 812;
  let releaseRetryResponse = (): void => undefined;
  if (preserveMovedDetailFocus) {
    controller.retryResponseGate = new Promise<void>((resolve) => {
      releaseRetryResponse = resolve;
    });
  }
  const retryResponse = waitForApiResponse(
    page,
    'GET',
    accountDetailApiPath(ACCOUNT_DETAIL_RETRY_ORDER_NUMBER),
  );
  await page.keyboard.press('Enter');
  const accountMenuLink = page.getByRole('link', { exact: true, name: 'Menu' }).first();
  if (preserveMovedDetailFocus) {
    await expect.poll(() => controller.retryRequestCount).toBe(2);
    await expect(
      main.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Order details',
      }),
    ).toBeFocused();
    await accountMenuLink.focus();
    await expect(accountMenuLink).toBeFocused();
    releaseRetryResponse();
  }
  await assertResponseStatus(
    retryResponse,
    200,
    'ACCOUNT_DETAIL_RETRY_STATUS_MISMATCH',
  );
  const retryHeading = main.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Order details',
  });
  await expect(retryHeading).toHaveAttribute('tabindex', '-1');
  if (preserveMovedDetailFocus) {
    await expect(accountMenuLink).toBeFocused();
    await expect(retryHeading).not.toBeFocused();
  } else {
    await expect(retryHeading).toBeFocused();
  }
  const recoveredSurface = await assertAccountDetailSuccessSurface(
    page,
    ACCOUNT_DETAIL_RETRY_ORDER_NUMBER,
    'preparing',
    'Preparing',
    'warning',
  );

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await assertReducedMotionContract(page, [
    recoveredSurface.statusSurface,
    recoveredSurface.statusBadge,
    recoveredSurface.orderedItems,
    recoveredSurface.itemRows.first(),
    recoveredSurface.summary,
    recoveredSurface.backLink,
    recoveredSurface.menuLink,
  ]);
  await assertResponsiveSurface(page);
  await blurActiveElement(page);
  await tabTo(page, recoveredSurface.backLink);
  await assertVisibleKeyboardFocus(recoveredSurface.backLink);

  expect(controller.detailRequests.map(({ pathname }) => pathname)).toEqual([
    accountDetailApiPath(ACCOUNT_ACTIVE_ORDER_NUMBER),
    accountDetailApiPath(ACCOUNT_LONG_ORDER_NUMBER),
    accountDetailApiPath(ACCOUNT_CANCELLED_ORDER_NUMBER),
    accountDetailApiPath(ACCOUNT_DETAIL_ACCESS_ORDER_NUMBER),
    accountDetailApiPath(ACCOUNT_DETAIL_RETRY_ORDER_NUMBER),
    accountDetailApiPath(ACCOUNT_DETAIL_RETRY_ORDER_NUMBER),
  ]);
  for (const request of controller.detailRequests) {
    expect(request).toMatchObject({
      authorization: `Bearer ${ACCOUNT_TOKEN}`,
      capability: null,
      method: 'GET',
      postData: null,
      search: '',
    });
  }
  expect(controller.meAuthorizations).toEqual(
    Array.from({ length: 5 }, () => `Bearer ${ACCOUNT_TOKEN}`),
  );
  expect(controller.retryRequestCount).toBe(2);
  expect(controller.networkIssues, 'ACCOUNT_DETAIL_SYNTHETIC_NETWORK_FAILURE').toEqual(
    [],
  );
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ACCOUNT_DETAIL_VIEWPORT_CHANGED',
  );
}

async function assertAuthViewport(
  page: Page,
  viewport: (typeof AUTH_VIEWPORTS)[number],
  controller: SyntheticAuthController,
  releaseFirstLoginResponse: () => void,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await page.goto('/register?next=%2Fmenu');
  const registerHeading = page.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Create account',
  });
  await expect(registerHeading).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole('main').getByText('Nordic Hearth', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { exact: true, name: 'Nordic Hearth' }),
  ).toHaveCount(0);

  const registerEmail = page.getByLabel('Email', { exact: true });
  const registerPassword = page.getByLabel('Password', { exact: true });
  const registerConfirm = page.getByLabel('Confirm password', { exact: true });
  const confirmationToggle = page.locator(
    'button[aria-controls=register-confirm-password]',
  );
  const registerToggle = page.locator('button[aria-controls=register-password]');
  const registerSubmit = page.getByRole('button', {
    exact: true,
    name: 'Create account',
  });
  const loginLink = page.getByRole('link', { exact: true, name: 'Sign in' });
  await expect(registerEmail).toHaveAttribute('autocomplete', 'email');
  await expect(registerPassword).toHaveAttribute('autocomplete', 'new-password');
  await expect(registerConfirm).toHaveAttribute('autocomplete', 'new-password');
  await expect(registerToggle).toHaveAccessibleName('Show password');
  await expect(confirmationToggle).toHaveAccessibleName('Show password confirmation');
  await expect(loginLink).toHaveAttribute('href', '/login?next=%2Fmenu');
  await assertMinimumTouchTarget(registerToggle, 'AUTH_REGISTER_TOGGLE_TOO_SMALL');
  await assertMinimumTouchTarget(
    confirmationToggle,
    'AUTH_REGISTER_CONFIRM_TOGGLE_TOO_SMALL',
  );
  await assertMinimumTouchTarget(registerSubmit, 'AUTH_REGISTER_CTA_TOO_SMALL');
  await assertMinimumTouchTarget(loginLink, 'AUTH_LOGIN_LINK_TOO_SMALL');
  await assertResponsiveSurface(page);

  await registerPassword.fill(AUTH_PASSWORD);
  await blurActiveElement(page);
  await tabTo(page, registerToggle);
  await assertVisibleKeyboardFocus(registerToggle);
  await page.keyboard.press('Space');
  await expect(registerToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(registerToggle).toHaveAccessibleName('Hide password');
  await expect(registerPassword).toHaveAttribute('type', 'text');
  await expect(registerPassword).toHaveValue(AUTH_PASSWORD);
  await page.keyboard.press('Space');
  await expect(registerToggle).toHaveAccessibleName('Show password');
  await expect(registerToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(registerPassword).toHaveAttribute('type', 'password');
  await expect(registerPassword).toHaveValue(AUTH_PASSWORD);

  await registerEmail.fill(AUTH_EMAIL);
  await registerPassword.fill('short');
  await registerSubmit.click();
  await expect(registerPassword).toBeFocused();
  await expect(registerPassword).toHaveAttribute('aria-invalid', 'true');
  const registerError = page.locator('#register-password-error');
  await expect(registerError).toBeVisible();
  await assertTextNotClipped(registerError, 'AUTH_REGISTER_ERROR_CLIPPED');
  safeInvariant(
    controller.registrationRequestCount === 0,
    'AUTH_INVALID_REGISTRATION_POSTED',
  );
  await assertResponsiveSurface(page);

  await registerPassword.fill(AUTH_PASSWORD);
  await registerConfirm.fill(AUTH_PASSWORD);
  const registrationResponse = waitForApiResponse(page, 'POST', AUTH_REGISTER_API_PATH);
  await registerSubmit.focus();
  await registerSubmit.press('Enter');
  await assertResponseStatus(registrationResponse, 503, 'AUTH_REGISTER_503_MISMATCH');
  await expect(page.getByRole('alert')).not.toContainText(
    'private synthetic registration detail',
  );
  await expect(registerSubmit).toBeFocused();
  await assertVisibleKeyboardFocus(registerSubmit);

  await blurActiveElement(page);
  await tabTo(page, loginLink);
  await assertVisibleKeyboardFocus(loginLink);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => {
      const current = new URL(page.url());
      return { pathname: current.pathname, search: current.search };
    })
    .toEqual({ pathname: '/login', search: '?next=%2Fmenu' });

  const loginHeading = page.getByRole('heading', {
    exact: true,
    level: 1,
    name: 'Sign in',
  });
  await expect(loginHeading).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole('main').getByText('Nordic Hearth', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { exact: true, name: 'Nordic Hearth' }),
  ).toHaveCount(0);

  const loginEmail = page.getByLabel('Email', { exact: true });
  const loginPassword = page.getByLabel('Password', { exact: true });
  const loginToggle = page.locator('button[aria-controls=login-password]');
  const loginSubmit = page.getByRole('button', {
    exact: true,
    name: 'Sign in',
  });
  const registerLink = page.getByRole('link', {
    exact: true,
    name: 'Create an account',
  });
  await expect(loginEmail).toHaveAttribute('autocomplete', 'username');
  await expect(loginPassword).toHaveAttribute('autocomplete', 'current-password');
  await expect(loginToggle).toHaveAccessibleName('Show password');
  await expect(registerLink).toHaveAttribute('href', '/register?next=%2Fmenu');
  await assertMinimumTouchTarget(loginToggle, 'AUTH_LOGIN_TOGGLE_TOO_SMALL');
  await assertMinimumTouchTarget(loginSubmit, 'AUTH_LOGIN_CTA_TOO_SMALL');
  await assertMinimumTouchTarget(registerLink, 'AUTH_REGISTER_LINK_TOO_SMALL');

  await loginSubmit.click();
  await expect(loginEmail).toBeFocused();
  await expect(loginEmail).toHaveAttribute('aria-invalid', 'true');
  const loginFieldError = page.locator('#login-email-error');
  await expect(loginFieldError).toBeVisible();
  await assertTextNotClipped(loginFieldError, 'AUTH_LOGIN_FIELD_ERROR_CLIPPED');
  safeInvariant(controller.loginRequests.length === 0, 'AUTH_INVALID_LOGIN_POSTED');

  await loginEmail.fill(AUTH_EMAIL);
  await loginPassword.fill(AUTH_PASSWORD);
  await blurActiveElement(page);
  await tabTo(page, loginToggle);
  await assertVisibleKeyboardFocus(loginToggle);
  await page.keyboard.press('Space');
  await expect(loginToggle).toHaveAccessibleName('Hide password');
  await expect(loginToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(loginPassword).toHaveAttribute('type', 'text');
  await expect(loginPassword).toHaveValue(AUTH_PASSWORD);
  await page.keyboard.press('Space');
  await expect(loginToggle).toHaveAccessibleName('Show password');
  await expect(loginToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(loginPassword).toHaveAttribute('type', 'password');
  await expect(loginPassword).toHaveValue(AUTH_PASSWORD);

  const idleButtonBox = await loginSubmit.boundingBox();
  safeInvariant(idleButtonBox !== null, 'AUTH_LOGIN_IDLE_CTA_BOX_MISSING');
  const firstLoginResponse = waitForApiResponse(page, 'POST', AUTH_LOGIN_API_PATH);
  await loginSubmit.click();
  const loadingButton = page.getByRole('button', { name: /Signing in/u });
  await expect(loadingButton).toBeDisabled();
  await expect(loadingButton).toHaveAttribute('aria-busy', 'true');
  const loadingButtonBox = await loadingButton.boundingBox();
  safeInvariant(
    loadingButtonBox !== null &&
      Math.abs(loadingButtonBox.width - idleButtonBox.width) <= OVERFLOW_TOLERANCE_PX,
    'AUTH_LOGIN_LOADING_WIDTH_SHIFTED',
  );
  await assertResponsiveSurface(page);

  releaseFirstLoginResponse();
  await assertResponseStatus(firstLoginResponse, 401, 'AUTH_LOGIN_401_MISMATCH');
  const requestError = page.getByRole('alert');
  await expect(requestError).toContainText('The email or password is incorrect.');
  await expect(requestError).not.toContainText(
    'private synthetic authentication detail',
  );
  await expect(loginPassword).toHaveAttribute('type', 'password');
  await expect(loginPassword).toHaveValue(AUTH_PASSWORD);
  await expect(loginSubmit).toBeEnabled();
  await expect(loginSubmit).toBeFocused();
  await assertVisibleKeyboardFocus(loginSubmit);
  await assertTextNotClipped(requestError, 'AUTH_LOGIN_REQUEST_ERROR_CLIPPED');

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await blurActiveElement(page);
  await tabTo(page, loginToggle);
  await assertVisibleKeyboardFocus(loginToggle);
  await tabTo(page, loginSubmit);
  await assertVisibleKeyboardFocus(loginSubmit);
  await assertReducedMotionContract(page, [
    page.locator('main > section').first(),
    loginToggle,
    loginSubmit,
    requestError,
  ]);
  await assertResponsiveSurface(page);

  const retryLoginResponse = waitForApiResponse(page, 'POST', AUTH_LOGIN_API_PATH);
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const menuResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
  await loginSubmit.click();
  await Promise.all([
    assertResponseStatus(retryLoginResponse, 200, 'AUTH_LOGIN_RETRY_MISMATCH'),
    assertResponseStatus(currentUserResponse, 200, 'AUTH_ME_STATUS_MISMATCH'),
    assertResponseStatus(menuResponse, 200, 'AUTH_MENU_STATUS_MISMATCH'),
  ]);
  await assertLocation(page, '/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();

  expect(controller.loginRequests).toHaveLength(2);
  for (const request of controller.loginRequests) {
    safeInvariant(request.postData !== null, 'AUTH_LOGIN_BODY_MISSING');
    expect(JSON.parse(request.postData)).toEqual({
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
    });
    expect(request.authorization).toBeNull();
  }
  expect(controller.meAuthorizations).toEqual([`Bearer ${AUTH_TOKEN}`]);
  // Development StrictMode replays the menu mount effect once; production performs one
  // idempotent read, while this local proof may observe two and must never observe more.
  expect(
    controller.menuRequestCount,
    'AUTH_MENU_REQUEST_COUNT_BELOW_MOUNT_CONTRACT',
  ).toBeGreaterThanOrEqual(1);
  expect(
    controller.menuRequestCount,
    'AUTH_MENU_REQUEST_COUNT_ABOVE_STRICT_MODE_CONTRACT',
  ).toBeLessThanOrEqual(2);
  expect(
    controller.registrationRequestCount,
    'AUTH_REGISTRATION_REQUEST_COUNT_MISMATCH',
  ).toBe(1);
  const visibleText = await page.locator('body').innerText();
  safeInvariant(!visibleText.includes(AUTH_PASSWORD), 'AUTH_PASSWORD_RENDERED');
  safeInvariant(!visibleText.includes(AUTH_TOKEN), 'AUTH_TOKEN_RENDERED');
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'AUTH_VIEWPORT_CHANGED',
  );
}

async function assertAuthKeyboardContracts(page: Page): Promise<void> {
  await page.goto('/login');
  const email = page.getByLabel('Email', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  const passwordToggle = page.locator('button[aria-controls=login-password]');
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  const register = page.getByRole('link', {
    exact: true,
    name: 'Create an account',
  });
  const back = page.getByRole('link', { name: 'Back to home' });
  await expect(passwordToggle).toHaveAccessibleName('Show password');
  await expect(register).toHaveAttribute('href', '/register');
  await blurActiveElement(page);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(email);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(password);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(passwordToggle);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(submit);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(register);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(back);
  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(register);
  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(submit);

  let loginPostCount = 0;
  page.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === '/api/v1/auth/login' &&
      request.method() === 'POST'
    ) {
      loginPostCount += 1;
    }
  });
  await page.keyboard.press('Enter');
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#login-email-error')).toBeVisible();
  await expect(email).toHaveAttribute('aria-describedby', 'login-email-error');
  safeInvariant(loginPostCount === 0, 'INVALID_LOGIN_POSTED');

  await page.goto('/register');
  const registerEmail = page.getByLabel('Email', { exact: true });
  const registerPassword = page.getByLabel('Password', { exact: true });
  const registerToggle = page.locator('button[aria-controls=register-password]');
  const registerConfirm = page.getByLabel('Confirm password', { exact: true });
  const confirmationToggle = page.locator(
    'button[aria-controls=register-confirm-password]',
  );
  const registerSubmit = page.getByRole('button', {
    exact: true,
    name: 'Create account',
  });
  const login = page.getByRole('link', { exact: true, name: 'Sign in' });
  const registerBack = page.getByRole('link', { name: 'Back to home' });
  await expect(registerToggle).toHaveAccessibleName('Show password');
  await expect(confirmationToggle).toHaveAccessibleName('Show password confirmation');
  await expect(login).toHaveAttribute('href', '/login');
  await blurActiveElement(page);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerEmail);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerPassword);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerToggle);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerConfirm);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(confirmationToggle);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerSubmit);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(login);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(registerBack);
  let registerPostCount = 0;
  page.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === '/api/v1/auth/register' &&
      request.method() === 'POST'
    ) {
      registerPostCount += 1;
    }
  });
  await registerEmail.fill(`stage18-form-${runId}@example.com`);
  await registerEmail.press('Enter');
  await expect(registerPassword).toBeFocused();
  await expect(registerPassword).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#register-password-error')).toBeVisible();
  await expect(registerPassword).toHaveAttribute(
    'aria-describedby',
    'register-password-guidance register-password-error',
  );
  safeInvariant(registerPostCount === 0, 'INVALID_REGISTRATION_POSTED');
}

async function loginAdministrator(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  await page.goto('/login?next=%2Faccount');
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);
  const loginResponse = waitForApiResponse(page, 'POST', '/api/v1/auth/login');
  const currentUserResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await Promise.all([
    assertResponseStatus(loginResponse, 200, 'ADMIN_LOGIN_STATUS_MISMATCH'),
    assertResponseStatus(currentUserResponse, 200, 'ADMIN_ME_STATUS_MISMATCH'),
  ]);
  await assertLocation(page, '/account');
}

async function createOwnedOrder(page: Page): Promise<void> {
  await openMenu(page);
  const item = page.getByRole('article', { exact: true, name: MENU_ITEM_NAME });
  await item.getByRole('button', { name: 'Add to cart' }).click();
  await expect(item.getByText('1 in cart', { exact: true })).toBeVisible();

  const cartMenuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  const quoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  await page.getByRole('link', { name: 'View cart', exact: true }).click();
  await Promise.all([
    assertResponseStatus(cartMenuResponse, 200, 'CART_MENU_STATUS_MISMATCH'),
    assertResponseStatus(quoteResponse, 200, 'QUOTE_STATUS_MISMATCH'),
  ]);
  const placeOrderButton = page.getByRole('button', {
    name: 'Place order and continue to payment',
  });
  await expect(placeOrderButton).toBeEnabled();
  const freshQuoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  const orderResponse = waitForApiResponse(page, 'POST', '/api/v1/orders');
  await placeOrderButton.click();
  await Promise.all([
    assertResponseStatus(freshQuoteResponse, 200, 'FRESH_QUOTE_STATUS_MISMATCH'),
    assertResponseStatus(orderResponse, 201, 'ORDER_CREATE_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order created' }),
  ).toBeVisible();
}

async function openAccount(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/account/orders');
  await page.goto('/account');
  await assertResponseStatus(response, 200, 'ACCOUNT_ORDERS_STATUS_MISMATCH');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
}

async function openAdminOrders(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/orders');
  await page.goto('/admin/orders');
  await assertResponseStatus(response, 200, 'ADMIN_ORDERS_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
}

async function openAdminUsers(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/users');
  await page.goto('/admin/users');
  await assertResponseStatus(response, 200, 'ADMIN_USERS_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
}

async function assertAuthenticatedLayouts(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    await assertLongTextWraps(
      page.locator('main strong').filter({ hasText: identity.email }),
    );
    await assertResponsiveSurface(page);

    await openAccount(page);
    await assertAccountCollectionLayout(page);
    await assertResponsiveSurface(page);
    await expect(
      page.getByRole('navigation', { name: 'Your orders pagination' }),
    ).toHaveCount(0);

    await openAdminOrders(page);
    await assertCollectionLayout(
      page,
      'Administrator orders, newest first',
      viewport.width,
    );
    await assertResponsiveSurface(page);

    await openAdminUsers(page);
    await assertCollectionLayout(
      page,
      'Registered users, oldest first',
      viewport.width,
    );
    await assertLongTextWraps(
      page.locator('header').getByText(identity.email, { exact: true }),
    );
    if (viewport.width < 768) {
      await assertLongTextWraps(
        page
          .getByRole('heading', { level: 2, name: identity.email })
          .getByText(identity.email, { exact: true }),
      );
    }
    await assertResponsiveSurface(page);
  }
}

async function assertAdministratorKeyboardContracts(page: Page): Promise<void> {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Administrator workspace' }),
  ).toBeVisible();
  await blurActiveElement(page);
  const skipLink = page.getByRole('link', {
    name: 'Skip to administrator content',
  });
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(skipLink);
  await page.keyboard.press('Enter');
  await expect(page.locator('#admin-main-content')).toBeFocused();
  await expect.poll(() => new URL(page.url()).hash).toBe('#admin-main-content');

  await page.goto('/admin');
  await blurActiveElement(page);
  const ordersLink = page
    .getByRole('navigation', { name: 'Administrator navigation' })
    .getByRole('link', { name: 'Orders', exact: true });
  await tabTo(page, ordersLink);
  await assertVisibleKeyboardFocus(ordersLink);
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/orders');
  await page.keyboard.press('Enter');
  await assertResponseStatus(response, 200, 'ADMIN_KEYBOARD_ORDERS_STATUS_MISMATCH');
  await assertLocation(page, '/admin/orders');
}

async function openSyntheticAdminHome(
  page: Page,
  controller: SyntheticAdminHomeController,
  mode: SyntheticAdminHomeMode,
): Promise<void> {
  controller.mode = mode;
  controller.menuRequestCount = 0;
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const ordersResponse = waitForApiResponse(page, 'GET', ADMIN_HOME_ORDERS_API_PATH);
  const menuResponse = waitForApiResponse(page, 'GET', ADMIN_HOME_MENU_API_PATH);
  const analyticsResponse = waitForApiResponse(
    page,
    'GET',
    ADMIN_HOME_ANALYTICS_API_PATH,
  );
  await page.goto('/admin');
  await Promise.all([
    assertResponseStatus(
      currentUserResponse,
      200,
      'ADMIN_HOME_CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(ordersResponse, 200, 'ADMIN_HOME_ORDERS_STATUS_MISMATCH'),
    assertResponseStatus(menuResponse, 200, 'ADMIN_HOME_MENU_STATUS_MISMATCH'),
    assertResponseStatus(
      analyticsResponse,
      200,
      'ADMIN_HOME_ANALYTICS_STATUS_MISMATCH',
    ),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Administrator workspace' }),
  ).toBeVisible();
}

async function assertPurposefulAdminHomeMotion(
  dashboard: Locator,
  shortcut: Locator,
): Promise<void> {
  const [dashboardMotion, shortcutMotion] = await Promise.all([
    dashboard.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.animationDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.animationDuration.split(',').map(durationMs)),
        iterationCount: style.animationIterationCount,
      };
    }),
    shortcut.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      const durationMs = (value: string) => {
        const normalized = value.trim();
        const numericValue = Number.parseFloat(normalized);
        if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
        return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
      };
      return {
        delayMs: Math.max(...style.transitionDelay.split(',').map(durationMs)),
        durationMs: Math.max(...style.transitionDuration.split(',').map(durationMs)),
      };
    }),
  ]);
  safeInvariant(
    dashboardMotion.delayMs <= 0.011 &&
      dashboardMotion.durationMs >= 120 &&
      dashboardMotion.durationMs <= 220 &&
      dashboardMotion.iterationCount
        .split(',')
        .every((entry) => Number.parseFloat(entry.trim()) === 1),
    'ADMIN_HOME_REVEAL_MOTION_MISMATCH',
  );
  safeInvariant(
    shortcutMotion.delayMs <= 0.011 &&
      shortcutMotion.durationMs >= 120 &&
      shortcutMotion.durationMs <= 220,
    'ADMIN_HOME_SHORTCUT_MOTION_MISMATCH',
  );
}

async function assertAdminHomeViewport(
  page: Page,
  viewport: (typeof ADMIN_HOME_VIEWPORTS)[number],
  controller: SyntheticAdminHomeController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await openSyntheticAdminHome(page, controller, 'healthy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  const main = page.locator('#admin-main-content');
  const dashboard = main.locator('> section').first();
  const recentOrders = page.getByRole('list', {
    name: 'Newest administrator orders',
  });
  const orderLinks = recentOrders.locator('a[href^="/admin/orders/ROA-"]');
  expect((await orderLinks.allTextContents()).map((value) => value.trim())).toEqual(
    SYNTHETIC_ADMIN_HOME_ORDERS.map((order) => order.public_order_number),
  );
  await expect(definitionValue(main, 'All orders')).toHaveText('42');
  await expect(definitionValue(main, 'Menu items')).toHaveText('2');
  await assertMinimumTouchTarget(
    orderLinks.first(),
    'ADMIN_HOME_ORDER_LINK_TARGET_TOO_SMALL',
  );
  await expect(page.getByText('3 signals', { exact: true })).toBeVisible();
  await expect(
    page.getByText('1 active menu item is unavailable', { exact: true }),
  ).toBeVisible();

  const expectedStatusVariants = [
    ['Created', 'warning'],
    ['Accepted', 'info'],
    ['Preparing', 'info'],
    ['Ready', 'success'],
    ['Completed', 'neutral'],
    ['Cancelled', 'danger'],
  ] as const;
  for (const [label, variant] of expectedStatusVariants) {
    const labelNode = recentOrders
      .locator('[data-variant] > span:last-child')
      .filter({ hasText: new RegExp(`^${label}$`, 'u') });
    await expect(labelNode).toBeVisible();
    await expect(labelNode.locator('..')).toHaveAttribute('data-variant', variant);
  }

  const shortcuts = page.getByRole('region', { name: 'Workspace shortcuts' });
  const ordersShortcut = shortcuts.getByRole('link', { name: /^Orders/u });
  await expect(ordersShortcut).toHaveAttribute('href', '/admin/orders');
  await expect(shortcuts.getByRole('link', { name: /^Menu/u })).toHaveAttribute(
    'href',
    '/admin/menu',
  );
  await expect(shortcuts.getByRole('link', { name: /^Analytics/u })).toHaveAttribute(
    'href',
    '/admin/analytics',
  );
  await expect(shortcuts.getByRole('link', { name: /^Exports/u })).toHaveAttribute(
    'href',
    '/admin/exports',
  );
  await expect(shortcuts.getByRole('link', { name: /^Users/u })).toHaveAttribute(
    'href',
    '/admin/users',
  );
  await assertMinimumTouchTarget(
    ordersShortcut,
    'ADMIN_HOME_SHORTCUT_TARGET_TOO_SMALL',
  );
  await assertLongTextWraps(
    page.locator('header').getByText(ADMIN_HOME_EMAIL, { exact: true }),
  );
  const largestTotal = definitionValue(
    recentOrders.locator('li').filter({ hasText: 'ROA-3456789ABCDE' }),
    'Total',
  );
  await assertTextNotClipped(largestTotal, 'ADMIN_HOME_LONG_TOTAL_CLIPPED');
  const mainText = await main.innerText();
  expect(mainText).not.toMatch(
    /\b(?:reservation|inventory|staffing|delivery|forecast)\b/iu,
  );
  expect(mainText).not.toMatch(/payment (?:status|pending|failed|succeeded|expired)/iu);
  expect(mainText).not.toContain('must never reach administrator copy');
  await assertPurposefulAdminHomeMotion(dashboard, ordersShortcut);
  await assertResponsiveSurface(page);

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await blurActiveElement(page);
  await tabTo(page, ordersShortcut, 32);
  await assertVisibleKeyboardFocus(ordersShortcut);
  await assertReducedMotionContract(page, [
    dashboard,
    page.getByRole('region', { name: 'Needs attention' }),
    recentOrders.locator('li').first(),
    ordersShortcut,
  ]);
  await assertResponsiveSurface(page);

  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await openSyntheticAdminHome(page, controller, 'empty');
  await expect(
    page.getByText('No attention signals in the available snapshot', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('No orders have been created yet.')).toBeVisible();
  await expect(page.getByText('No paid sales')).toHaveCount(2);
  await assertResponsiveSurface(page);

  await openSyntheticAdminHome(page, controller, 'partial');
  const menuError = page.getByText('Menu availability unavailable', {
    exact: true,
  });
  await expect(menuError).toBeVisible();
  await expect(
    definitionValue(page.locator('#admin-main-content'), 'All orders'),
  ).toHaveText('42');
  await expect(
    page.getByRole('list', { name: 'Newest administrator orders' }),
  ).toBeVisible();
  const retryButton = page.getByRole('button', {
    name: 'Retry menu availability',
  });
  await assertMinimumTouchTarget(retryButton, 'ADMIN_HOME_RETRY_TARGET_TOO_SMALL');
  await blurActiveElement(page);
  await tabTo(page, retryButton, 32);
  await assertVisibleKeyboardFocus(retryButton);
  controller.menuFailuresRemaining = 1;
  const repeatedFailureResponse = waitForApiResponse(
    page,
    'GET',
    ADMIN_HOME_MENU_API_PATH,
  );
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    repeatedFailureResponse,
    200,
    'G2_ADMIN_HOME_REPEATED_FAILURE_STATUS_MISMATCH',
  );
  const restoredRetryButton = page.getByRole('button', {
    name: 'Retry menu availability',
  });
  await expect(restoredRetryButton).toBeFocused();
  await assertVisibleKeyboardFocus(restoredRetryButton);
  let releaseRetryResponse = (): void => undefined;
  controller.nextMenuResponseGate = new Promise<void>((resolve) => {
    releaseRetryResponse = resolve;
  });
  const retryResponse = waitForApiResponse(page, 'GET', ADMIN_HOME_MENU_API_PATH);
  await page.keyboard.press('Enter');
  const movedFocusTarget =
    viewport.width === 320
      ? page
          .getByRole('navigation', { name: 'Administrator navigation' })
          .getByRole('link', { exact: true, name: 'Orders' })
      : null;
  if (movedFocusTarget !== null) {
    await movedFocusTarget.focus();
    await assertVisibleKeyboardFocus(movedFocusTarget);
  }
  releaseRetryResponse();
  controller.nextMenuResponseGate = null;
  await assertResponseStatus(
    retryResponse,
    200,
    'ADMIN_HOME_MENU_RETRY_STATUS_MISMATCH',
  );
  await expect(
    page.getByText('All active items available', { exact: true }),
  ).toBeVisible();
  const menuHeading = page.getByRole('heading', {
    level: 2,
    name: 'Menu availability',
  });
  if (movedFocusTarget === null) {
    await expect(menuHeading).toBeFocused();
    await assertVisibleKeyboardFocus(menuHeading);
  } else {
    await expect(movedFocusTarget).toBeFocused();
  }
  await expect(menuError).toHaveCount(0);
  await assertResponsiveSurface(page);

  const dashboardRequests = controller.requests.filter(
    ({ pathname }) => pathname !== AUTH_ME_API_PATH,
  );
  expect(
    dashboardRequests.filter(({ pathname }) => pathname === ADMIN_HOME_ORDERS_API_PATH),
  ).toHaveLength(3);
  expect(
    dashboardRequests.filter(({ pathname }) => pathname === ADMIN_HOME_MENU_API_PATH),
  ).toHaveLength(5);
  expect(
    dashboardRequests.filter(
      ({ pathname }) => pathname === ADMIN_HOME_ANALYTICS_API_PATH,
    ),
  ).toHaveLength(3);
  for (const request of controller.requests) {
    expect(request).toMatchObject({
      authorization: `Bearer ${ADMIN_HOME_TOKEN}`,
      capability: null,
      method: 'GET',
      postData: null,
    });
  }
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ADMIN_HOME_VIEWPORT_CHANGED',
  );
}

function adminAnalyticsSection(page: Page, heading: string): Locator {
  return page
    .locator('#admin-main-content section')
    .filter({
      has: page.getByRole('heading', { exact: true, level: 2, name: heading }),
    })
    .last();
}

function formatSyntheticAnalyticsMoney(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-NO', { currency, style: 'currency' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return formatter.format(amount / 10 ** digits);
}

async function assertPurposefulAdminAnalyticsMotion(
  pageHeader: Locator,
  filters: Locator,
  resultBody: Locator,
  appliedContext: Locator,
): Promise<void> {
  const motion = await Promise.all(
    [pageHeader, filters, resultBody, appliedContext].map((locator) =>
      locator.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
        const maximumDurationMs = (value: string) =>
          Math.max(
            ...value.split(',').map((entry) => {
              const normalized = entry.trim();
              const numericValue = Number.parseFloat(normalized);
              if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
              return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
            }),
          );
        return {
          animationDelayMs: maximumDurationMs(style.animationDelay),
          animationDurationMs: maximumDurationMs(style.animationDuration),
          animationName: style.animationName,
          iterationsAreFinite: style.animationIterationCount
            .split(',')
            .every((entry) => Number.parseFloat(entry.trim()) === 1),
          transitionDelayMs: maximumDurationMs(style.transitionDelay),
          transitionDurationMs: maximumDurationMs(style.transitionDuration),
        };
      }),
    ),
  );
  const [headerMotion, filterMotion, resultMotion, contextMotion] = motion;
  safeInvariant(
    headerMotion !== undefined &&
      headerMotion.animationName !== 'none' &&
      headerMotion.animationDelayMs <= 0.011 &&
      headerMotion.animationDurationMs >= 120 &&
      headerMotion.animationDurationMs <= 220 &&
      headerMotion.iterationsAreFinite,
    'ADMIN_ANALYTICS_HEADER_MOTION_MISMATCH',
  );
  safeInvariant(
    filterMotion !== undefined &&
      filterMotion.animationName !== 'none' &&
      filterMotion.animationDelayMs <= 50 &&
      filterMotion.animationDurationMs >= 120 &&
      filterMotion.animationDurationMs <= 220 &&
      filterMotion.iterationsAreFinite,
    'ADMIN_ANALYTICS_FILTER_MOTION_MISMATCH',
  );
  safeInvariant(
    resultMotion !== undefined &&
      resultMotion.animationName !== 'none' &&
      resultMotion.animationDelayMs <= 0.011 &&
      resultMotion.animationDurationMs >= 120 &&
      resultMotion.animationDurationMs <= 220 &&
      resultMotion.iterationsAreFinite,
    'ADMIN_ANALYTICS_RESULT_MOTION_MISMATCH',
  );
  safeInvariant(
    contextMotion !== undefined &&
      contextMotion.transitionDelayMs <= 0.011 &&
      contextMotion.transitionDurationMs >= 120 &&
      contextMotion.transitionDurationMs <= 220,
    'ADMIN_ANALYTICS_CONTEXT_MOTION_MISMATCH',
  );
}

async function visibleExactText(
  container: Locator,
  value: string,
  code: string,
): Promise<Locator> {
  const matches = container.getByText(value, { exact: true });
  for (let index = 0; index < (await matches.count()); index += 1) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error(code);
}

async function assertAppliedAnalyticsContext(
  page: Page,
  expectation: {
    readonly currency: string;
    readonly endDate: string;
    readonly limit: string;
    readonly startDate: string;
  },
): Promise<Locator> {
  const context = page.getByRole('region', { name: 'Applied analytics context' });
  await expect(context).toBeVisible();
  const period = definitionValue(context, 'Period');
  await expect(period).toContainText(expectation.startDate);
  await expect(period).toContainText(expectation.endDate);
  await expect(definitionValue(context, 'Timezone')).toHaveText('Europe/Oslo');
  await expect(definitionValue(context, 'Currency')).toHaveText(expectation.currency);
  await expect(definitionValue(context, 'Breakdown limit')).toHaveText(
    expectation.limit,
  );
  return context;
}

function nextDateOnly(value: string): string {
  const instant = new Date(`${value}T00:00:00Z`);
  safeInvariant(Number.isFinite(instant.getTime()), 'ADMIN_ANALYTICS_DATE_INVALID');
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function adminAnalyticsModeRequests(
  controller: SyntheticAdminAnalyticsController,
  mode: SyntheticAdminAnalyticsMode,
): SyntheticAdminAnalyticsRequest[] {
  return controller.requests.filter((request) => request.mode === mode);
}

function adminAnalyticsCollection(
  page: Page,
  caption: string,
  viewportWidth: number,
): Locator {
  return viewportWidth < 1_024
    ? page.getByRole('list', { name: caption })
    : page.getByRole('table', { name: caption });
}

async function assertAdminAnalyticsCollectionLayout(
  page: Page,
  caption: string,
  viewportWidth: number,
): Promise<void> {
  const cards = page.getByRole('list', { name: caption });
  const table = page.getByRole('table', { name: caption });
  if (viewportWidth < 1_024) {
    await expect(cards).toBeVisible();
    await expect(table).toBeHidden();
    const cardsFit = await cards.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const box = (element as unknown as RuntimeElement).getBoundingClientRect();
      return box.left >= -1 && box.right <= runtime.innerWidth + 1;
    });
    safeInvariant(cardsFit, 'ADMIN_ANALYTICS_CARD_COLLECTION_CLIPPED');
    return;
  }
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await assertTableReachable(table);
}

async function assertAdminAnalyticsViewport(
  page: Page,
  viewport: (typeof ADMIN_ANALYTICS_VIEWPORTS)[number],
  controller: SyntheticAdminAnalyticsController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  controller.mode = 'healthy-multi';
  let releaseInitialResponses = (): void => undefined;
  controller.nextBatchResponseGate = new Promise<void>((resolve) => {
    releaseInitialResponses = resolve;
  });
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const initialAnalyticsResponses = waitForAdminAnalyticsResponses(page);
  let initialStartDate: string;
  let initialEndDate: string;
  try {
    await page.goto('/admin/analytics');
    await assertResponseStatus(
      currentUserResponse,
      200,
      'ADMIN_ANALYTICS_CURRENT_USER_STATUS_MISMATCH',
    );
    await assertLocation(page, '/admin/analytics');
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Analytics' }),
    ).toHaveCount(1);
    const main = page.locator('#admin-main-content');
    const loadingStatus = main
      .getByRole('status')
      .filter({ hasText: 'Loading analytics\u2026' });
    await expect(loadingStatus).toHaveCount(1);
    await expect(loadingStatus).toBeVisible();
    await expect(
      main.getByText('Loading analytics\u2026', { exact: true }),
    ).toHaveCount(1);
    await expect(main.getByText('NOK', { exact: true })).toHaveCount(0);
    await expect(main.getByText('USD', { exact: true })).toHaveCount(0);
    initialStartDate = await page
      .getByLabel('Start date', { exact: true })
      .inputValue();
    initialEndDate = await page.getByLabel('End date', { exact: true }).inputValue();
    safeInvariant(
      (Date.parse(`${initialEndDate}T00:00:00Z`) -
        Date.parse(`${initialStartDate}T00:00:00Z`)) /
        86_400_000 ===
        6,
      'ADMIN_ANALYTICS_INITIAL_RANGE_NOT_SEVEN_DAYS',
    );
    await expect
      .poll(() => adminAnalyticsModeRequests(controller, 'healthy-multi').length)
      .toBe(ADMIN_ANALYTICS_ENDPOINTS.length);
    await assertResponsiveSurface(page);
  } finally {
    releaseInitialResponses();
    controller.nextBatchResponseGate = null;
  }
  await assertAdminAnalyticsResponseStatuses(
    initialAnalyticsResponses,
    'ADMIN_ANALYTICS_INITIAL_STATUS_MISMATCH',
  );

  const main = page.locator('#admin-main-content');
  const filters = adminAnalyticsSection(page, 'Draft filters');
  const overview = adminAnalyticsSection(page, 'Overview');
  const products = adminAnalyticsSection(page, 'Product sales');
  const categories = adminAnalyticsSection(page, 'Category sales');
  const orderTypes = adminAnalyticsSection(page, 'Order types');
  for (const heading of [
    'Draft filters',
    'Overview',
    'Product sales',
    'Category sales',
    'Order types',
  ]) {
    await expect(
      page.getByRole('heading', { exact: true, level: 2, name: heading }),
    ).toBeVisible();
  }

  const initialAppliedContext = await assertAppliedAnalyticsContext(page, {
    currency: 'All returned currencies, reported separately',
    endDate: initialEndDate,
    limit: '50 per currency',
    startDate: initialStartDate,
  });
  await expect(
    initialAppliedContext.getByText('Applied', { exact: true }),
  ).toBeVisible();
  const initialAppliedText = await initialAppliedContext.innerText();
  const initialNokRevenue = await visibleExactText(
    overview,
    formatSyntheticAnalyticsMoney(12_345_600, 'NOK'),
    'ADMIN_ANALYTICS_NOK_REVENUE_MISSING',
  );
  const initialUsdRevenue = await visibleExactText(
    overview,
    formatSyntheticAnalyticsMoney(42_750, 'USD'),
    'ADMIN_ANALYTICS_USD_REVENUE_MISSING',
  );
  await assertTextNotClipped(initialNokRevenue, 'ADMIN_ANALYTICS_NOK_REVENUE_CLIPPED');
  await assertTextNotClipped(initialUsdRevenue, 'ADMIN_ANALYTICS_USD_REVENUE_CLIPPED');
  const productCaption = 'Historical product sales in backend rank order';
  const categoryCaption = 'Historical category sales in backend rank order';
  const orderTypeCaption = 'Paid order types in backend order';
  for (const caption of [productCaption, categoryCaption, orderTypeCaption]) {
    await assertAdminAnalyticsCollectionLayout(
      page,
      `${caption} \u2014 NOK`,
      viewport.width,
    );
    await assertAdminAnalyticsCollectionLayout(
      page,
      `${caption} \u2014 USD`,
      viewport.width,
    );
  }
  const visibleProductCollection = adminAnalyticsCollection(
    page,
    `${productCaption} \u2014 NOK`,
    viewport.width,
  );
  const visibleCategoryCollection = adminAnalyticsCollection(
    page,
    `${categoryCaption} \u2014 NOK`,
    viewport.width,
  );
  await assertLongTextWraps(
    await visibleExactText(
      visibleProductCollection,
      ADMIN_ANALYTICS_LONG_PRODUCT_NAME,
      'ADMIN_ANALYTICS_LONG_PRODUCT_MISSING',
    ),
  );
  await assertLongTextWraps(
    await visibleExactText(
      visibleCategoryCollection,
      ADMIN_ANALYTICS_LONG_CATEGORY_NAME,
      'ADMIN_ANALYTICS_LONG_CATEGORY_MISSING',
    ),
  );
  const analyticsText = await main.innerText();
  expect(analyticsText).not.toMatch(
    /\b(?:combined|conversion|exchange rate|fx|growth|margin|profit|trend)\b/iu,
  );
  expect(analyticsText).not.toMatch(
    /payment (?:failure|failed|pending|status)|card details|refund/iu,
  );
  expect(analyticsText).not.toContain(ADMIN_ANALYTICS_PRIVATE_RESPONSE_COPY);

  const startDate = page.getByLabel('Start date', { exact: true });
  const endDate = page.getByLabel('End date', { exact: true });
  const currency = page.getByLabel('Currency (optional)', { exact: true });
  const limit = page.getByLabel('Breakdown limit', { exact: true });
  const applyButton = filters.locator('button').filter({ hasText: 'Apply filters' });
  const refreshButton = filters.locator('button').filter({ hasText: 'Refresh' });
  const sevenDayPreset = filters.getByRole('button', { exact: true, name: '7 days' });
  const thirtyDayPreset = filters.getByRole('button', {
    exact: true,
    name: '30 days',
  });
  const ninetyDayPreset = filters.getByRole('button', {
    exact: true,
    name: '90 days',
  });
  for (const [control, code] of [
    [startDate, 'ADMIN_ANALYTICS_START_TARGET_TOO_SMALL'],
    [endDate, 'ADMIN_ANALYTICS_END_TARGET_TOO_SMALL'],
    [currency, 'ADMIN_ANALYTICS_CURRENCY_TARGET_TOO_SMALL'],
    [limit, 'ADMIN_ANALYTICS_LIMIT_TARGET_TOO_SMALL'],
    [applyButton, 'ADMIN_ANALYTICS_APPLY_TARGET_TOO_SMALL'],
    [refreshButton, 'ADMIN_ANALYTICS_REFRESH_TARGET_TOO_SMALL'],
    [sevenDayPreset, 'ADMIN_ANALYTICS_7_DAY_TARGET_TOO_SMALL'],
    [thirtyDayPreset, 'ADMIN_ANALYTICS_30_DAY_TARGET_TOO_SMALL'],
    [ninetyDayPreset, 'ADMIN_ANALYTICS_90_DAY_TARGET_TOO_SMALL'],
  ] as const) {
    await assertMinimumTouchTarget(control, code);
  }
  await expect(sevenDayPreset).toHaveAttribute('aria-pressed', 'true');
  await expect(thirtyDayPreset).toHaveAttribute('aria-pressed', 'false');

  await assertPurposefulAdminAnalyticsMotion(
    main.locator('> section > header').first(),
    filters,
    products.locator('> div').last(),
    initialAppliedContext,
  );

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await blurActiveElement(page);
  await tabTo(page, applyButton, 64);
  await assertVisibleKeyboardFocus(applyButton);
  await assertReducedMotionContract(page, [
    main.locator('> section').first(),
    initialAppliedContext,
    filters,
    applyButton,
    products,
  ]);
  await assertResponsiveSurface(page);
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

  await thirtyDayPreset.click();
  await expect(
    main.getByRole('status').filter({ hasText: 'Changes not applied' }),
  ).toBeVisible();
  await expect(
    main.getByText(
      'The controls contain draft changes. Current results still use the applied context shown above.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(sevenDayPreset).toHaveAttribute('aria-pressed', 'true');
  await expect(thirtyDayPreset).toHaveAttribute('aria-pressed', 'false');
  expect(await initialAppliedContext.innerText()).toBe(initialAppliedText);
  expect(controller.requests).toHaveLength(ADMIN_ANALYTICS_ENDPOINTS.length);

  await startDate.fill('2026-08-01');
  await endDate.fill('2026-08-07');
  await currency.fill('nok');
  await limit.fill('7');
  await expect(currency).toHaveValue('NOK');
  expect(await initialAppliedContext.innerText()).toBe(initialAppliedText);
  await expect(initialNokRevenue).toBeVisible();

  controller.mode = 'healthy-filtered';
  let releaseSuccessfulApply = (): void => undefined;
  controller.nextBatchResponseGate = new Promise<void>((resolve) => {
    releaseSuccessfulApply = resolve;
  });
  const successfulApplyResponses = waitForAdminAnalyticsResponses(page);
  const requestCountBeforeApply = controller.requests.length;
  const movedAnalyticsFocusTarget =
    viewport.width === 320
      ? page
          .getByRole('navigation', { name: 'Administrator navigation' })
          .getByRole('link', { exact: true, name: 'Exports' })
      : null;
  let duplicateRequestObserved: boolean;
  try {
    await blurActiveElement(page);
    await tabTo(page, applyButton, 64);
    await assertVisibleKeyboardFocus(applyButton);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => controller.requests.length)
      .toBe(requestCountBeforeApply + ADMIN_ANALYTICS_ENDPOINTS.length);
    await expect(
      main.getByText(
        'Applying filters\u2026 Previous applied results remain visible until all sections succeed.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(applyButton).toBeDisabled();
    await expect(refreshButton).toBeDisabled();
    await assertAppliedAnalyticsContext(page, {
      currency: 'All returned currencies, reported separately',
      endDate: initialEndDate,
      limit: '50 per currency',
      startDate: initialStartDate,
    });
    await expect(
      initialAppliedContext.getByText('Previous applied data', { exact: true }),
    ).toBeVisible();
    await expect(initialNokRevenue).toBeVisible();
    const duplicateRequest = page
      .waitForRequest(
        (request) => {
          const parsed = parseUrl(request.url());
          return ADMIN_ANALYTICS_ENDPOINTS.some(
            ({ pathname }) => parsed?.pathname === pathname,
          );
        },
        { timeout: 250 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.keyboard.press('Enter');
    duplicateRequestObserved = await duplicateRequest;
    if (movedAnalyticsFocusTarget !== null) {
      await movedAnalyticsFocusTarget.focus();
      await assertVisibleKeyboardFocus(movedAnalyticsFocusTarget);
    }
    await assertResponsiveSurface(page);
  } finally {
    releaseSuccessfulApply();
    controller.nextBatchResponseGate = null;
  }
  safeInvariant(!duplicateRequestObserved, 'ADMIN_ANALYTICS_DUPLICATE_APPLY_REQUEST');
  await assertAdminAnalyticsResponseStatuses(
    successfulApplyResponses,
    'ADMIN_ANALYTICS_SUCCESSFUL_APPLY_STATUS_MISMATCH',
  );
  await visibleExactText(
    products,
    ADMIN_ANALYTICS_FILTERED_PRODUCT_NAME,
    'ADMIN_ANALYTICS_FILTERED_PRODUCT_MISSING',
  );
  const filteredAppliedContext = await assertAppliedAnalyticsContext(page, {
    currency: 'NOK',
    endDate: '2026-08-07',
    limit: '7 per currency',
    startDate: '2026-08-01',
  });
  if (movedAnalyticsFocusTarget === null) {
    await expect(filteredAppliedContext).toBeFocused();
    await assertVisibleKeyboardFocus(filteredAppliedContext);
  } else {
    await expect(movedAnalyticsFocusTarget).toBeFocused();
  }
  const filteredAppliedText = await filteredAppliedContext.innerText();
  const filteredRevenueText = formatSyntheticAnalyticsMoney(7_380_000, 'NOK');
  const filteredRevenue = await visibleExactText(
    overview,
    filteredRevenueText,
    'ADMIN_ANALYTICS_FILTERED_REVENUE_MISSING',
  );
  await expect(main.getByText('Changes not applied', { exact: true })).toHaveCount(0);
  await expect(main.getByText(ADMIN_ANALYTICS_LONG_PRODUCT_NAME)).toHaveCount(0);
  await assertResponsiveSurface(page);

  await startDate.fill('2026-08-10');
  await endDate.fill('2026-08-16');
  await currency.fill('usd');
  await limit.fill('5');
  controller.mode = 'all-malformed';
  const failedApplyResponses = waitForAdminAnalyticsResponses(page);
  await blurActiveElement(page);
  await tabTo(page, applyButton, 64);
  await assertVisibleKeyboardFocus(applyButton);
  await page.keyboard.press('Enter');
  await assertAdminAnalyticsResponseStatuses(
    failedApplyResponses,
    'ADMIN_ANALYTICS_FAILED_APPLY_TRANSPORT_STATUS_MISMATCH',
  );
  await expect(main.getByText('Filters not applied', { exact: true })).toBeVisible();
  await expect(
    main.getByText(
      'One or more analytics sections could not load the requested filters. Previous results and applied context are unchanged.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(main.getByText('Section unavailable', { exact: true })).toHaveCount(4);
  const failedApplyFeedback = main
    .locator('div[tabindex]')
    .filter({ hasText: 'Filters not applied' });
  await expect(failedApplyFeedback).toBeFocused();
  await assertVisibleKeyboardFocus(failedApplyFeedback);
  expect(await filteredAppliedContext.innerText()).toBe(filteredAppliedText);
  await expect(filteredRevenue).toBeVisible();
  await expect(
    await visibleExactText(
      products,
      ADMIN_ANALYTICS_FILTERED_PRODUCT_NAME,
      'ADMIN_ANALYTICS_FILTERED_PRODUCT_NOT_PRESERVED',
    ),
  ).toBeVisible();
  await expect(startDate).toHaveValue('2026-08-10');
  await expect(endDate).toHaveValue('2026-08-16');
  await expect(currency).toHaveValue('USD');
  await expect(limit).toHaveValue('5');
  expect(await main.innerText()).not.toContain(ADMIN_ANALYTICS_PRIVATE_RESPONSE_COPY);
  await assertResponsiveSurface(page);

  controller.mode = 'partial-products';
  const partialRefreshResponses = waitForAdminAnalyticsResponses(page);
  await refreshButton.click();
  await assertAdminAnalyticsResponseStatuses(
    partialRefreshResponses,
    'ADMIN_ANALYTICS_PARTIAL_REFRESH_STATUS_MISMATCH',
  );
  await expect(
    products.getByText('Section unavailable', { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText('Section unavailable', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    categories.getByText('Section unavailable', { exact: true }),
  ).toHaveCount(0);
  await expect(
    orderTypes.getByText('Section unavailable', { exact: true }),
  ).toHaveCount(0);
  await visibleExactText(
    categories,
    'Partially refreshed authoritative category',
    'ADMIN_ANALYTICS_PARTIAL_CATEGORY_MISSING',
  );
  await visibleExactText(
    overview,
    formatSyntheticAnalyticsMoney(9_999_900, 'NOK'),
    'ADMIN_ANALYTICS_PARTIAL_OVERVIEW_MISSING',
  );
  await visibleExactText(
    products,
    ADMIN_ANALYTICS_FILTERED_PRODUCT_NAME,
    'ADMIN_ANALYTICS_PARTIAL_PRODUCT_NOT_PRESERVED',
  );
  expect(await filteredAppliedContext.innerText()).toBe(filteredAppliedText);
  await expect(
    main.getByRole('status').filter({ hasText: 'Changes not applied' }),
  ).toBeVisible();
  await assertResponsiveSurface(page);

  await startDate.fill('2026-01-10');
  await endDate.fill('2026-01-16');
  await currency.fill('');
  await limit.fill('4');
  controller.mode = 'zero';
  const zeroApplyResponses = waitForAdminAnalyticsResponses(page);
  await applyButton.click();
  await assertAdminAnalyticsResponseStatuses(
    zeroApplyResponses,
    'ADMIN_ANALYTICS_ZERO_APPLY_STATUS_MISMATCH',
  );
  await assertAppliedAnalyticsContext(page, {
    currency: 'All returned currencies, reported separately',
    endDate: '2026-01-16',
    limit: '4 per currency',
    startDate: '2026-01-10',
  });
  await expect(main.getByText('No paid orders in this period.')).toBeVisible();
  await expect(main.getByText('No product sales in this period.')).toBeVisible();
  await expect(main.getByText('No category sales in this period.')).toBeVisible();
  await expect(main.getByText('No order-type sales in this period.')).toBeVisible();
  await expect(main.getByText('Section unavailable', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Filters not applied', { exact: true })).toHaveCount(0);
  await expect(main.getByText('Changes not applied', { exact: true })).toHaveCount(0);
  await expect(main.getByRole('alert')).toHaveCount(0);
  await assertResponsiveSurface(page);

  const initialRequests = adminAnalyticsModeRequests(controller, 'healthy-multi');
  const initialRequest = initialRequests[0];
  safeInvariant(
    initialRequest !== undefined,
    'ADMIN_ANALYTICS_INITIAL_REQUEST_MISSING',
  );
  safeInvariant(
    initialRequest.start.startsWith(`${initialStartDate}T00:00:00`) &&
      initialRequest.end.startsWith(`${nextDateOnly(initialEndDate)}T00:00:00`),
    'ADMIN_ANALYTICS_INITIAL_QUERY_RANGE_MISMATCH',
  );
  assertSyntheticAdminAnalyticsBatch(initialRequests, {
    currency: null,
    end: initialRequest.end,
    limit: 50,
    mode: 'healthy-multi',
    start: initialRequest.start,
  });
  assertSyntheticAdminAnalyticsBatch(
    adminAnalyticsModeRequests(controller, 'healthy-filtered'),
    {
      currency: 'NOK',
      end: '2026-08-08T00:00:00+02:00',
      limit: 7,
      mode: 'healthy-filtered',
      start: '2026-08-01T00:00:00+02:00',
    },
  );
  assertSyntheticAdminAnalyticsBatch(
    adminAnalyticsModeRequests(controller, 'all-malformed'),
    {
      currency: 'USD',
      end: '2026-08-17T00:00:00+02:00',
      limit: 5,
      mode: 'all-malformed',
      start: '2026-08-10T00:00:00+02:00',
    },
  );
  assertSyntheticAdminAnalyticsBatch(
    adminAnalyticsModeRequests(controller, 'partial-products'),
    {
      currency: 'NOK',
      end: '2026-08-08T00:00:00+02:00',
      limit: 7,
      mode: 'partial-products',
      start: '2026-08-01T00:00:00+02:00',
    },
  );
  assertSyntheticAdminAnalyticsBatch(adminAnalyticsModeRequests(controller, 'zero'), {
    currency: null,
    end: '2026-01-17T00:00:00+01:00',
    limit: 4,
    mode: 'zero',
    start: '2026-01-10T00:00:00+01:00',
  });
  expect(controller.requests).toHaveLength(ADMIN_ANALYTICS_ENDPOINTS.length * 5);
  for (const { pathname } of ADMIN_ANALYTICS_ENDPOINTS) {
    expect(
      controller.requests.filter((request) => request.pathname === pathname),
    ).toHaveLength(5);
  }
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ADMIN_ANALYTICS_VIEWPORT_CHANGED',
  );
}

function adminExportsCard(
  page: Page,
  heading: 'Orders' | 'Payments' | 'Product sales',
): Locator {
  const labelledBy = {
    Orders: 'orders-export-heading',
    Payments: 'payments-export-heading',
    'Product sales': 'product-export-heading',
  } as const;
  return page.locator(
    `#admin-main-content section[aria-labelledby=${labelledBy[heading]}]`,
  );
}

async function adminExportOperationWithTimeout<T>(
  operation: Promise<T>,
  code: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(code)), 10_000);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function assertAdminExportDownload(
  page: Page,
  action: () => Promise<void> | void,
  expectedFilename: string,
  code: string,
): Promise<void> {
  const downloadPromise = page
    .waitForEvent('download', { timeout: 10_000 })
    .catch(() => {
      throw new Error(`${code}_EVENT_MISSING`);
    });
  await action();
  const download = await downloadPromise;
  let downloadSettled = false;
  try {
    expect(download.suggestedFilename(), code).toBe(expectedFilename);
    const failure = await adminExportOperationWithTimeout(
      download.failure(),
      `${code}_COMPLETION_TIMEOUT`,
    );
    downloadSettled = true;
    safeInvariant(failure === null, `${code}_FAILED`);
  } finally {
    if (downloadSettled) {
      await adminExportOperationWithTimeout(
        download.delete(),
        `${code}_CLEANUP_TIMEOUT`,
      );
    }
  }
}

async function assertPurposefulAdminExportsMotion(
  pageHeader: Locator,
  parameterPanel: Locator,
  exportCard: Locator,
): Promise<void> {
  const motion = await Promise.all(
    [pageHeader, parameterPanel, exportCard].map((locator) =>
      locator.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
        const maximumDurationMs = (value: string) =>
          Math.max(
            ...value.split(',').map((entry) => {
              const normalized = entry.trim();
              const numericValue = Number.parseFloat(normalized);
              if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
              return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
            }),
          );
        return {
          animationDelayMs: maximumDurationMs(style.animationDelay),
          animationDurationMs: maximumDurationMs(style.animationDuration),
          animationName: style.animationName,
          iterationsAreFinite: style.animationIterationCount
            .split(',')
            .every((entry) => Number.parseFloat(entry.trim()) === 1),
          transitionDelayMs: maximumDurationMs(style.transitionDelay),
          transitionDurationMs: maximumDurationMs(style.transitionDuration),
        };
      }),
    ),
  );
  for (const [entry, code] of [
    [motion[0], 'ADMIN_EXPORTS_HEADER_MOTION_MISMATCH'],
    [motion[1], 'ADMIN_EXPORTS_PARAMETERS_MOTION_MISMATCH'],
    [motion[2], 'ADMIN_EXPORTS_CARD_MOTION_MISMATCH'],
  ] as const) {
    safeInvariant(
      entry !== undefined &&
        entry.animationName !== 'none' &&
        entry.animationDelayMs >= 0 &&
        entry.animationDelayMs <= 80 &&
        entry.animationDurationMs >= 120 &&
        entry.animationDurationMs <= 220 &&
        entry.iterationsAreFinite,
      code,
    );
  }
  const cardMotion = motion[2];
  safeInvariant(
    cardMotion !== undefined &&
      cardMotion.transitionDelayMs <= 0.011 &&
      cardMotion.transitionDurationMs >= 120 &&
      cardMotion.transitionDurationMs <= 220,
    'ADMIN_EXPORTS_CARD_TRANSITION_MISMATCH',
  );
}

async function assertAdminExportsViewport(
  page: Page,
  viewport: (typeof ADMIN_EXPORTS_VIEWPORTS)[number],
  controller: SyntheticAdminExportsController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  await page.goto('/admin/exports');
  await assertResponseStatus(
    currentUserResponse,
    200,
    'ADMIN_EXPORTS_CURRENT_USER_STATUS_MISMATCH',
  );
  await assertLocation(page, '/admin/exports');

  const main = page.locator('#admin-main-content');
  await expect(
    main.getByRole('heading', { exact: true, level: 1, name: 'Exports' }),
  ).toHaveCount(1);
  const parameterHeading = main.getByRole('heading', {
    exact: true,
    level: 2,
    name: 'Parameters for the next download',
  });
  await expect(parameterHeading).toBeVisible();
  await expect(
    main.getByRole('heading', {
      exact: true,
      level: 2,
      name: 'Available CSV exports',
    }),
  ).toBeVisible();
  await expect(main.getByRole('heading', { level: 3 })).toHaveCount(3);

  const ordersCard = adminExportsCard(page, 'Orders');
  const productSalesCard = adminExportsCard(page, 'Product sales');
  const paymentsCard = adminExportsCard(page, 'Payments');
  for (const card of [ordersCard, productSalesCard, paymentsCard]) {
    await expect(card).toBeVisible();
    await expect(card.getByText('CSV', { exact: true })).toHaveCount(1);
  }
  const pageText = await main.innerText();
  expect(pageText).not.toMatch(
    /\b(?:XLSX|PDF|scheduled exports?|email delivery|export history|retention)\b/iu,
  );
  expect(pageText).not.toContain(ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY);
  expect(pageText).not.toContain(ADMIN_EXPORTS_TOKEN);

  const startDate = page.getByLabel('Start date', { exact: true });
  const endDate = page.getByLabel('End date', { exact: true });
  const currency = page.getByLabel(/^Currency \(optional\)/u);
  const orderStatus = ordersCard.getByLabel(/^Order status/u);
  const orderType = ordersCard.getByLabel(/^Order type/u);
  const ordersButton = ordersCard.getByRole('button');
  const productSalesButton = productSalesCard.getByRole('button');
  const paymentsButton = paymentsCard.getByRole('button');
  await expect(ordersButton).toHaveAccessibleName('Download orders CSV');
  await expect(productSalesButton).toHaveAccessibleName('Download product sales CSV');
  await expect(paymentsButton).toHaveAccessibleName('Download payments CSV');

  for (const [control, code] of [
    [startDate, 'ADMIN_EXPORTS_START_TARGET_TOO_SMALL'],
    [endDate, 'ADMIN_EXPORTS_END_TARGET_TOO_SMALL'],
    [currency, 'ADMIN_EXPORTS_CURRENCY_TARGET_TOO_SMALL'],
    [orderStatus, 'ADMIN_EXPORTS_STATUS_TARGET_TOO_SMALL'],
    [orderType, 'ADMIN_EXPORTS_ORDER_TYPE_TARGET_TOO_SMALL'],
    [ordersButton, 'ADMIN_EXPORTS_ORDERS_TARGET_TOO_SMALL'],
    [productSalesButton, 'ADMIN_EXPORTS_PRODUCT_TARGET_TOO_SMALL'],
    [paymentsButton, 'ADMIN_EXPORTS_PAYMENTS_TARGET_TOO_SMALL'],
  ] as const) {
    await assertMinimumTouchTarget(control, code);
  }
  await assertResponsiveSurface(page);
  const pageHeader = main.locator('> section > header').first();
  const parameters = main.locator('section[aria-labelledby=export-filters-heading]');
  await assertPurposefulAdminExportsMotion(pageHeader, parameters, ordersCard);

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await blurActiveElement(page);
  await tabTo(page, ordersButton, 64);
  await assertVisibleKeyboardFocus(ordersButton);
  await assertReducedMotionContract(page, [
    pageHeader,
    parameters,
    ordersCard,
    ordersButton,
  ]);
  await assertResponsiveSurface(page);
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

  await startDate.fill(ADMIN_EXPORTS_PRIMARY_RANGE.startDate);
  await endDate.fill(ADMIN_EXPORTS_PRIMARY_RANGE.endDate);
  await currency.fill('nok');
  await expect(currency).toHaveValue('NOK');
  await orderStatus.selectOption('completed');
  await orderType.selectOption('takeaway');
  const nextContext = ordersCard.locator('#orders-next-context');
  await expect(nextContext).toBeVisible();

  let releaseOrdersResponse = (): void => undefined;
  controller.responseGates.orders = new Promise<void>((resolve) => {
    releaseOrdersResponse = resolve;
  });
  const ordersResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/orders.csv`,
  );
  const requestCountBeforeOrders = controller.requests.length;
  let observedDownloadCount = 0;
  page.on('download', () => {
    observedDownloadCount += 1;
  });
  try {
    await ordersButton.hover();
    const restingButtonBox = await ordersButton.boundingBox();
    safeInvariant(restingButtonBox !== null, 'H2B_BUTTON_RESTING_BOX_MISSING');
    await page.mouse.move(
      restingButtonBox.x + restingButtonBox.width / 2,
      restingButtonBox.y + restingButtonBox.height / 2,
    );
    try {
      await page.mouse.down();
      await page.waitForTimeout(180);
      const activeButtonBox = await ordersButton.boundingBox();
      const activeButtonMotion = await ordersButton.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
        const maximumDurationMs = (value: string) =>
          Math.max(
            ...value.split(',').map((entry) => {
              const normalized = entry.trim();
              const numericValue = Number.parseFloat(normalized);
              if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
              return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
            }),
          );
        return {
          transform: style.transform,
          transitionDurationMs: maximumDurationMs(style.transitionDuration),
        };
      });
      safeInvariant(activeButtonBox !== null, 'H2B_BUTTON_ACTIVE_BOX_MISSING');
      safeInvariant(
        activeButtonMotion.transform !== 'none' &&
          activeButtonMotion.transitionDurationMs >= 100 &&
          activeButtonMotion.transitionDurationMs <= 220 &&
          Math.abs(activeButtonBox.width - restingButtonBox.width) <= 0.1 &&
          Math.abs(activeButtonBox.height - restingButtonBox.height) <= 0.1 &&
          activeButtonBox.y - restingButtonBox.y >= 0.5 &&
          activeButtonBox.y - restingButtonBox.y <= 1.1,
        'H2B_BUTTON_PRESS_MOTION_MISMATCH',
      );
    } finally {
      await page.mouse.move(1, 1);
      await page.mouse.up();
    }
    expect(controller.requests).toHaveLength(requestCountBeforeOrders);

    await blurActiveElement(page);
    await tabTo(page, ordersButton, 64);
    await assertVisibleKeyboardFocus(ordersButton);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => controller.requests.length)
      .toBe(requestCountBeforeOrders + 1);
    await expect(ordersCard).toHaveAttribute('aria-busy', 'true');
    await expect(ordersButton).toHaveAttribute('aria-busy', 'true');
    await expect(ordersButton).toBeDisabled();
    await expect(productSalesButton).toBeEnabled();
    await expect(paymentsButton).toBeEnabled();
    const pendingNotice = ordersCard
      .getByRole('status')
      .filter({ hasText: /Preparing Orders CSV/iu });
    await expect(pendingNotice).toBeVisible();
    await expect(pendingNotice).toHaveAttribute('aria-atomic', 'true');
    await expect(pendingNotice).toHaveAttribute('aria-live', 'polite');
    await expect(pendingNotice).toHaveAttribute('data-variant', 'info');
    await expect(pendingNotice).toContainText('Request context:');
    await expect(pendingNotice).toContainText(ADMIN_EXPORTS_PRIMARY_RANGE.startDate);
    await expect(pendingNotice).toContainText(ADMIN_EXPORTS_PRIMARY_RANGE.endDate);
    await expect(pendingNotice).toContainText('NOK');
    const spinner = ordersButton.locator(
      ':scope > span[aria-hidden=true]:last-child > span',
    );
    await expect(spinner).toHaveCount(1);
    const pendingMotion = await Promise.all(
      [spinner, pendingNotice].map((locator) =>
        locator.evaluate((element) => {
          const runtime = globalThis as typeof globalThis & BrowserRuntime;
          const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
          const maximumDurationMs = (value: string) =>
            Math.max(
              ...value.split(',').map((entry) => {
                const normalized = entry.trim();
                const numericValue = Number.parseFloat(normalized);
                if (!Number.isFinite(numericValue)) return Number.POSITIVE_INFINITY;
                return normalized.endsWith('ms') ? numericValue : numericValue * 1_000;
              }),
            );
          return {
            animationDelayMs: maximumDurationMs(style.animationDelay),
            animationDurationMs: maximumDurationMs(style.animationDuration),
            animationIterationCount: style.animationIterationCount,
            animationName: style.animationName,
          };
        }),
      ),
    );
    const spinnerMotion = pendingMotion[0];
    const noticeMotion = pendingMotion[1];
    safeInvariant(
      spinnerMotion !== undefined &&
        spinnerMotion.animationName !== 'none' &&
        spinnerMotion.animationDelayMs <= 0.011 &&
        spinnerMotion.animationDurationMs >= 500 &&
        spinnerMotion.animationDurationMs <= 1_000 &&
        spinnerMotion.animationIterationCount === 'infinite',
      'H2B_BUTTON_LOADING_MOTION_MISMATCH',
    );
    safeInvariant(
      noticeMotion !== undefined &&
        noticeMotion.animationName !== 'none' &&
        noticeMotion.animationDelayMs <= 0.011 &&
        noticeMotion.animationDurationMs >= 120 &&
        noticeMotion.animationDurationMs <= 220 &&
        noticeMotion.animationIterationCount === '1',
      'H2B_NOTICE_REVEAL_MOTION_MISMATCH',
    );

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await assertReducedMotionContract(page, [ordersButton, spinner, pendingNotice]);
    await assertResponsiveSurface(page);
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });

    const duplicateRequest = page
      .waitForRequest(
        (request) =>
          parseUrl(request.url())?.pathname === `${ADMIN_EXPORTS_API_ROOT}/orders.csv`,
        { timeout: 250 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.keyboard.press('Enter');
    safeInvariant(!(await duplicateRequest), 'ADMIN_EXPORTS_DUPLICATE_ORDERS_REQUEST');

    await startDate.fill(ADMIN_EXPORTS_SECONDARY_RANGE.startDate);
    await endDate.fill(ADMIN_EXPORTS_SECONDARY_RANGE.endDate);
    await currency.fill('usd');
    await expect(currency).toHaveValue('USD');
    await expect(nextContext).toContainText('USD');
    await expect(pendingNotice).toContainText('NOK');

    controller.modes.payments = 'valid-fallback';
    const paymentsResponse = waitForApiResponse(
      page,
      'GET',
      `${ADMIN_EXPORTS_API_ROOT}/payments.csv`,
    );
    await assertAdminExportDownload(
      page,
      () => paymentsButton.click(),
      'payments.csv',
      'ADMIN_EXPORTS_PAYMENTS_FALLBACK_FILENAME_MISMATCH',
    );
    await assertResponseStatus(
      paymentsResponse,
      200,
      'ADMIN_EXPORTS_PAYMENTS_STATUS_MISMATCH',
    );
    const paymentsSuccess = paymentsCard
      .getByRole('status')
      .filter({ hasText: /Payments CSV download started/iu });
    await expect(paymentsSuccess).toContainText('Request context:');
    await expect(paymentsSuccess).toContainText('USD');
    await expect(paymentsSuccess).toContainText('Download filename:');
    await expect(paymentsSuccess).toContainText('payments.csv');
    await expect(ordersButton).toBeDisabled();

    await assertAdminExportDownload(
      page,
      () => {
        releaseOrdersResponse();
      },
      ADMIN_EXPORTS_LONG_FILENAME,
      'ADMIN_EXPORTS_ORDERS_FILENAME_MISMATCH',
    );
  } finally {
    releaseOrdersResponse();
    controller.responseGates.orders = null;
  }
  await assertResponseStatus(
    ordersResponse,
    200,
    'ADMIN_EXPORTS_ORDERS_STATUS_MISMATCH',
  );
  const ordersSuccess = ordersCard
    .getByRole('status')
    .filter({ hasText: /Orders CSV download started/iu });
  await expect(ordersSuccess).toContainText('Request context:');
  await expect(ordersSuccess).toContainText(ADMIN_EXPORTS_PRIMARY_RANGE.startDate);
  await expect(ordersSuccess).toContainText(ADMIN_EXPORTS_PRIMARY_RANGE.endDate);
  await expect(ordersSuccess).toContainText('NOK');
  await expect(ordersSuccess).toContainText('Download filename:');
  const longFilename = ordersSuccess.getByText(ADMIN_EXPORTS_LONG_FILENAME, {
    exact: true,
  });
  await assertLongTextWraps(longFilename);
  await expect(ordersCard).not.toHaveAttribute('aria-busy');

  controller.modes['product-sales'] = 'valid-safe';
  const productResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/product-sales.csv`,
  );
  await assertAdminExportDownload(
    page,
    () => productSalesButton.click(),
    syntheticAdminExportSafeFilename('product-sales'),
    'ADMIN_EXPORTS_PRODUCT_FILENAME_MISMATCH',
  );
  await assertResponseStatus(
    productResponse,
    200,
    'ADMIN_EXPORTS_PRODUCT_STATUS_MISMATCH',
  );
  const productSuccess = productSalesCard
    .getByRole('status')
    .filter({ hasText: /Product sales CSV download started/iu });
  await expect(productSuccess).toContainText('USD');
  await expect(observedDownloadCount).toBe(3);
  await assertLocation(page, '/admin/exports');
  await assertResponsiveSurface(page);

  const requestsBeforeClientValidation = controller.requests.length;
  const downloadsBeforeClientValidation = observedDownloadCount;
  await currency.fill('N1');
  await paymentsButton.click();
  await expect(main.getByText(/three uppercase ASCII letters/iu)).toBeVisible();
  await expect(currency).toBeFocused();
  expect(controller.requests).toHaveLength(requestsBeforeClientValidation);
  expect(observedDownloadCount).toBe(downloadsBeforeClientValidation);
  await currency.fill('USD');

  controller.modes['product-sales'] = 'invalid-mime';
  const invalidMimeResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/product-sales.csv`,
  );
  const downloadsBeforeInvalidMime = observedDownloadCount;
  await blurActiveElement(page);
  await tabTo(page, productSalesButton, 64);
  await assertVisibleKeyboardFocus(productSalesButton);
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    invalidMimeResponse,
    200,
    'ADMIN_EXPORTS_INVALID_MIME_STATUS_MISMATCH',
  );
  const invalidMimeNotice = productSalesCard
    .getByRole('alert')
    .filter({ hasText: /invalid CSV response/iu });
  await expect(invalidMimeNotice).toBeVisible();
  await expect(productSalesButton).toBeFocused();
  expect(observedDownloadCount).toBe(downloadsBeforeInvalidMime);
  await expect(ordersSuccess).toBeVisible();
  await expect(paymentsCard.getByRole('status')).toBeVisible();

  controller.modes['product-sales'] = 'invalid-parameters';
  const invalidParametersResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/product-sales.csv`,
  );
  const downloadsBeforeInvalidParameters = observedDownloadCount;
  await productSalesButton.click();
  await assertResponseStatus(
    invalidParametersResponse,
    422,
    'ADMIN_EXPORTS_INVALID_PARAMETERS_STATUS_MISMATCH',
  );
  await expect(
    productSalesCard
      .getByRole('alert')
      .filter({ hasText: /parameters were not accepted/iu }),
  ).toBeVisible();
  expect(observedDownloadCount).toBe(downloadsBeforeInvalidParameters);

  controller.modes.payments = 'server-error';
  const serverErrorResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/payments.csv`,
  );
  const downloadsBeforeServerError = observedDownloadCount;
  await paymentsButton.click();
  await assertResponseStatus(
    serverErrorResponse,
    503,
    'ADMIN_EXPORTS_SERVER_ERROR_STATUS_MISMATCH',
  );
  await expect(
    paymentsCard.getByRole('alert').filter({ hasText: /temporarily unavailable/iu }),
  ).toBeVisible();
  expect(observedDownloadCount).toBe(downloadsBeforeServerError);
  await expect(ordersSuccess).toBeVisible();

  controller.modes.orders = 'forbidden';
  const forbiddenResponse = waitForApiResponse(
    page,
    'GET',
    `${ADMIN_EXPORTS_API_ROOT}/orders.csv`,
  );
  const downloadsBeforeForbidden = observedDownloadCount;
  await ordersButton.click();
  await assertResponseStatus(
    forbiddenResponse,
    403,
    'ADMIN_EXPORTS_FORBIDDEN_STATUS_MISMATCH',
  );
  await expect(
    ordersCard.getByRole('alert').filter({ hasText: /not permitted/iu }),
  ).toBeVisible();
  expect(observedDownloadCount).toBe(downloadsBeforeForbidden);
  await expect(productSalesCard.getByRole('alert')).toBeVisible();
  await expect(paymentsCard.getByRole('alert')).toBeVisible();

  const ordersRequests = controller.requests.filter(({ kind }) => kind === 'orders');
  const productRequests = controller.requests.filter(
    ({ kind }) => kind === 'product-sales',
  );
  const paymentRequests = controller.requests.filter(({ kind }) => kind === 'payments');
  expect(ordersRequests).toHaveLength(2);
  expect(productRequests).toHaveLength(3);
  expect(paymentRequests).toHaveLength(2);
  assertSyntheticAdminExportRequest(ordersRequests[0]!, {
    currency: 'NOK',
    end: ADMIN_EXPORTS_PRIMARY_RANGE.end,
    kind: 'orders',
    mode: 'valid-safe',
    orderStatus: 'completed',
    orderType: 'takeaway',
    start: ADMIN_EXPORTS_PRIMARY_RANGE.start,
  });
  assertSyntheticAdminExportRequest(ordersRequests[1]!, {
    currency: 'USD',
    end: ADMIN_EXPORTS_SECONDARY_RANGE.end,
    kind: 'orders',
    mode: 'forbidden',
    orderStatus: 'completed',
    orderType: 'takeaway',
    start: ADMIN_EXPORTS_SECONDARY_RANGE.start,
  });
  for (const [request, mode] of [
    [productRequests[0], 'valid-safe'],
    [productRequests[1], 'invalid-mime'],
    [productRequests[2], 'invalid-parameters'],
  ] as const) {
    safeInvariant(request !== undefined, 'ADMIN_EXPORTS_PRODUCT_REQUEST_MISSING');
    assertSyntheticAdminExportRequest(request, {
      currency: 'USD',
      end: ADMIN_EXPORTS_SECONDARY_RANGE.end,
      kind: 'product-sales',
      mode,
      start: ADMIN_EXPORTS_SECONDARY_RANGE.start,
    });
  }
  for (const [request, mode] of [
    [paymentRequests[0], 'valid-fallback'],
    [paymentRequests[1], 'server-error'],
  ] as const) {
    safeInvariant(request !== undefined, 'ADMIN_EXPORTS_PAYMENT_REQUEST_MISSING');
    assertSyntheticAdminExportRequest(request, {
      currency: 'USD',
      end: ADMIN_EXPORTS_SECONDARY_RANGE.end,
      kind: 'payments',
      mode,
      start: ADMIN_EXPORTS_SECONDARY_RANGE.start,
    });
  }
  expect(controller.requests).toHaveLength(7);
  expect(observedDownloadCount).toBe(3);
  expect(await main.innerText()).not.toContain(ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY);
  expect(await main.innerText()).not.toContain(ADMIN_EXPORTS_TOKEN);
  await assertResponsiveSurface(page);
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ADMIN_EXPORTS_VIEWPORT_CHANGED',
  );
}

const ADMIN_ORDERS_VIEWPORTS = G2_ADMIN_VIEWPORTS;
const ADMIN_ORDERS_EMAIL =
  'stage21-f2a-operational-administrator-with-a-deliberately-long-identity@example.invalid';
const ADMIN_ORDERS_TOKEN = 'synthetic.stage21.f2a.admin.token';
const ADMIN_ORDERS_USER_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ORDERS_API_PATH = '/api/v1/admin/orders';
const ADMIN_ORDERS_PRIVATE_COPY =
  'private payment metadata must never reach the administrator orders overview';

const SYNTHETIC_ADMIN_ORDERS = Object.freeze([
  {
    created_at: '2026-08-27T10:00:00+00:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-23456789ABCD',
    status: 'preparing',
    table_number: 7,
    total_amount: 12_550,
    updated_at: '2026-08-27T10:02:00+00:00',
  },
  {
    created_at: '2026-08-27T09:00:00+00:00',
    currency: 'USD',
    order_type: 'takeaway',
    public_order_number: 'ROA-BCDEFGHJKLMN',
    status: 'cancelled',
    table_number: null,
    total_amount: 99_999,
    updated_at: '2026-08-27T09:04:00+00:00',
  },
  {
    created_at: '2026-08-27T08:00:00+00:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-CDEFGHJKLMNP',
    status: 'ready',
    table_number: 12,
    total_amount: 41_250,
    updated_at: '2026-08-27T08:10:00+00:00',
  },
  {
    created_at: '2026-08-27T07:00:00+00:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-DEFGHJKLMNPQ',
    status: 'completed',
    table_number: 3,
    total_amount: 88_800,
    updated_at: '2026-08-27T07:15:00+00:00',
  },
  {
    created_at: '2026-08-27T06:00:00+00:00',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: 'ROA-EFGHJKLMNPQR',
    status: 'created',
    table_number: null,
    total_amount: 987_654_321,
    updated_at: '2026-08-27T06:25:00+00:00',
  },
  {
    created_at: '2026-08-27T05:00:00+00:00',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: 'ROA-FGHJKLMNPQRS',
    status: 'accepted',
    table_number: null,
    total_amount: 20_000,
    updated_at: '2026-08-27T05:05:00+00:00',
  },
] as const);
const ADMIN_ORDER_DETAIL_NUMBER = SYNTHETIC_ADMIN_ORDERS[0].public_order_number;
const ADMIN_ORDER_DETAIL_API_PATH = `${ADMIN_ORDERS_API_PATH}/${ADMIN_ORDER_DETAIL_NUMBER}`;
const ADMIN_ORDER_DETAIL_ITEM_NAME =
  'RoastedRootVegetableBowlWithJuniperLingonberryAndPickledShallots';
const SYNTHETIC_ADMIN_ORDER_DETAIL = Object.freeze({
  created_at: '2026-08-27T10:00:00+00:00',
  currency: 'NOK',
  items: [
    {
      category_name: 'SeasonalNordicMainsPreparedForLongContentResponsiveVerification',
      discount_amount: 0,
      id: '44444444-4444-4444-8444-444444444451',
      line_total_amount: 12_550,
      menu_item_id: '44444444-4444-4444-8444-444444444452',
      name: ADMIN_ORDER_DETAIL_ITEM_NAME,
      position: 0,
      quantity: 1,
      tax_rate_bps: 2_500,
      unit_cost_amount: 6_200,
      unit_price_amount: 12_550,
    },
  ],
  order_id: '44444444-4444-4444-8444-444444444450',
  order_type: 'dine_in',
  payments: [
    {
      amount: 12_550,
      checkout_expires_at: '2026-08-27T10:31:00+00:00',
      created_at: '2026-08-27T10:01:00+00:00',
      currency: 'NOK',
      id: '44444444-4444-4444-8444-444444444453',
      status: 'succeeded',
      updated_at: '2026-08-27T10:02:00+00:00',
    },
  ],
  public_order_number: ADMIN_ORDER_DETAIL_NUMBER,
  status: 'preparing',
  status_history: [
    {
      changed_at: '2026-08-27T10:00:00+00:00',
      new_status: 'created',
      previous_status: null,
      sequence: 0,
    },
    {
      changed_at: '2026-08-27T10:01:00+00:00',
      new_status: 'accepted',
      previous_status: 'created',
      sequence: 1,
    },
    {
      changed_at: '2026-08-27T10:02:00+00:00',
      new_status: 'preparing',
      previous_status: 'accepted',
      sequence: 2,
    },
  ],
  subtotal_amount: 12_550,
  table_number: 7,
  total_amount: 12_550,
  updated_at: '2026-08-27T10:02:00+00:00',
});

function syntheticAdminOrderDetail(status: 'preparing' | 'ready') {
  if (status === 'preparing') return SYNTHETIC_ADMIN_ORDER_DETAIL;
  return {
    ...SYNTHETIC_ADMIN_ORDER_DETAIL,
    status,
    status_history: [
      ...SYNTHETIC_ADMIN_ORDER_DETAIL.status_history,
      {
        changed_at: '2026-08-27T10:04:00+00:00',
        new_status: 'ready',
        previous_status: 'preparing',
        sequence: 3,
      },
    ],
    updated_at: '2026-08-27T10:04:00+00:00',
  };
}

interface SyntheticAdminOrdersRequest {
  readonly authorization: string | null;
  readonly capability: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly postData: string | null;
  readonly search: string;
}

interface SyntheticAdminOrdersController {
  authoritativeDetailStatus?: 'preparing' | 'ready';
  conflictNextStatusPatch?: boolean;
  detailFailuresRemaining: number;
  emptyDefault: boolean;
  malformedNext: boolean;
  nextDetailResponseGate: Promise<void> | null;
  nextPageGate: Promise<void> | null;
  nextStatusPatchResponseGate?: Promise<void> | null;
  readonly networkIssues: string[];
  readonly requests: SyntheticAdminOrdersRequest[];
}

function captureSyntheticAdminOrdersRequest(
  request: Request,
  parsed: URL,
): SyntheticAdminOrdersRequest {
  const headers = request.headers();
  return {
    authorization: headers.authorization ?? null,
    capability: headers['x-order-access-token'] ?? null,
    method: request.method(),
    pathname: parsed.pathname,
    postData: request.postData(),
    search: parsed.search,
  };
}

function syntheticAdminOrdersPage(
  controller: SyntheticAdminOrdersController,
  status: string | null,
  orderType: string | null,
  offset: number,
) {
  if (
    controller.emptyDefault &&
    status === null &&
    orderType === null &&
    offset === 0
  ) {
    return { items: [], limit: 50, offset: 0, total: 0 };
  }

  let items = [...SYNTHETIC_ADMIN_ORDERS];
  if (status !== null) {
    items = items.filter((order) => order.status === status);
  }
  if (orderType !== null) {
    items = items.filter((order) => order.order_type === orderType);
  }
  if (status === 'ready' && orderType === null) {
    return { items, limit: 50, offset, total: 51 };
  }
  return {
    items: offset === 0 ? items : [],
    limit: 50,
    offset,
    total: status === null && orderType === null ? 51 : items.length,
  };
}

async function installSyntheticAdminOrdersRouting(
  page: Page,
  controller: SyntheticAdminOrdersController,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      controller.networkIssues.push('admin-orders-invalid-url');
      await route.abort();
      return;
    }
    if (parsed.origin !== baseOrigin) {
      controller.networkIssues.push(`admin-orders-external-request:${parsed.hostname}`);
      await route.abort();
      return;
    }

    const method = request.method();
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.requests.push(captureSyntheticAdminOrdersRequest(request, parsed));
      await route.fulfill({
        body: JSON.stringify({
          email: ADMIN_ORDERS_EMAIL,
          id: ADMIN_ORDERS_USER_ID,
          is_active: true,
          role: 'admin',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      parsed.pathname === ADMIN_ORDER_DETAIL_API_PATH &&
      parsed.search === '' &&
      method === 'GET'
    ) {
      controller.requests.push(captureSyntheticAdminOrdersRequest(request, parsed));
      const detailResponseGate = controller.nextDetailResponseGate;
      controller.nextDetailResponseGate = null;
      if (detailResponseGate !== null) await detailResponseGate;
      if (controller.detailFailuresRemaining > 0) {
        controller.detailFailuresRemaining -= 1;
        await route.fulfill({
          body: JSON.stringify({ detail: 'Private synthetic detail failure' }),
          contentType: 'application/json',
          status: 503,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify(
          syntheticAdminOrderDetail(
            controller.authoritativeDetailStatus ?? 'preparing',
          ),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (
      parsed.pathname === `${ADMIN_ORDER_DETAIL_API_PATH}/status` &&
      parsed.search === '' &&
      method === 'PATCH'
    ) {
      controller.requests.push(captureSyntheticAdminOrdersRequest(request, parsed));
      const statusPatchResponseGate = controller.nextStatusPatchResponseGate ?? null;
      controller.nextStatusPatchResponseGate = null;
      if (statusPatchResponseGate !== null) await statusPatchResponseGate;
      const headers = request.headers();
      if (
        headers.authorization !== `Bearer ${ADMIN_ORDERS_TOKEN}` ||
        headers['x-order-access-token'] !== undefined ||
        request.postData() !== JSON.stringify({ status: 'ready' })
      ) {
        controller.networkIssues.push('admin-order-status-request-contract');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Invalid synthetic status update' }),
          contentType: 'application/json',
          status: 422,
        });
        return;
      }
      if (controller.conflictNextStatusPatch !== true) {
        controller.networkIssues.push('admin-order-status-unexpected-patch');
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic status update' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      controller.conflictNextStatusPatch = false;
      controller.authoritativeDetailStatus = 'ready';
      await route.fulfill({
        body: JSON.stringify({ detail: 'Private synthetic mutation conflict' }),
        contentType: 'application/json',
        status: 409,
      });
      return;
    }

    if (parsed.pathname === ADMIN_ORDERS_API_PATH && method === 'GET') {
      controller.requests.push(captureSyntheticAdminOrdersRequest(request, parsed));
      const status = parsed.searchParams.get('status');
      const orderType = parsed.searchParams.get('order_type');
      const limit = parsed.searchParams.get('limit');
      const offsetText = parsed.searchParams.get('offset');
      const offset = offsetText === null ? Number.NaN : Number(offsetText);
      const expected = new URLSearchParams();
      if (status !== null) expected.set('status', status);
      if (orderType !== null) expected.set('order_type', orderType);
      expected.set('limit', '50');
      expected.set('offset', String(offset));
      const supportedStatus =
        status === null ||
        [
          'created',
          'accepted',
          'preparing',
          'ready',
          'completed',
          'cancelled',
        ].includes(status);
      const supportedOrderType =
        orderType === null || orderType === 'dine_in' || orderType === 'takeaway';
      if (
        !supportedStatus ||
        !supportedOrderType ||
        limit !== '50' ||
        (offset !== 0 && offset !== 50) ||
        parsed.search !== `?${expected.toString()}`
      ) {
        controller.networkIssues.push(`admin-orders-query:${parsed.search}`);
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic orders query' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      if (controller.malformedNext) {
        controller.malformedNext = false;
        await route.fulfill({
          body: JSON.stringify({
            items: [],
            limit: 50,
            offset,
            private_detail: ADMIN_ORDERS_PRIVATE_COPY,
            total: 0,
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (
        status === 'ready' &&
        orderType === null &&
        offset === 50 &&
        controller.nextPageGate !== null
      ) {
        await controller.nextPageGate;
      }
      await route.fulfill({
        body: JSON.stringify(
          syntheticAdminOrdersPage(controller, status, orderType, offset),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `admin-orders-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic admin-orders request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }

    await route.continue();
  });
}

async function openSyntheticAdminOrders(
  page: Page,
  controller: SyntheticAdminOrdersController,
): Promise<void> {
  const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
  const ordersResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await page.goto('/admin/orders');
  await Promise.all([
    assertResponseStatus(
      currentUserResponse,
      200,
      'ADMIN_ORDERS_CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(ordersResponse, 200, 'ADMIN_ORDERS_STATUS_MISMATCH'),
  ]);
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  safeInvariant(!controller.malformedNext, 'ADMIN_ORDERS_MALFORMED_RESPONSE_UNUSED');
}

async function assertPurposefulAdminOrdersMotion(
  pageSurface: Locator,
  visibleEntry: Locator,
): Promise<void> {
  const motion = await Promise.all(
    [pageSurface, visibleEntry].map((locator) =>
      locator.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
        const durationMs = (value: string) => {
          const normalized = value.trim();
          const number = Number.parseFloat(normalized);
          if (!Number.isFinite(number)) return Number.POSITIVE_INFINITY;
          return normalized.endsWith('ms') ? number : number * 1_000;
        };
        return {
          animationDelayMs: Math.max(
            ...style.animationDelay.split(',').map(durationMs),
          ),
          animationDurationMs: Math.max(
            ...style.animationDuration.split(',').map(durationMs),
          ),
          animationIterations: style.animationIterationCount,
          transitionDelayMs: Math.max(
            ...style.transitionDelay.split(',').map(durationMs),
          ),
          transitionDurationMs: Math.max(
            ...style.transitionDuration.split(',').map(durationMs),
          ),
        };
      }),
    ),
  );
  for (const entry of motion) {
    const purposefulDurationMs = Math.max(
      entry.animationDurationMs,
      entry.transitionDurationMs,
    );
    safeInvariant(
      entry.animationDelayMs <= 0.011 &&
        entry.transitionDelayMs <= 0.011 &&
        purposefulDurationMs >= 120 &&
        purposefulDurationMs <= 220 &&
        entry.animationIterations
          .split(',')
          .every((value) => Number.parseFloat(value.trim()) <= 1),
      'ADMIN_ORDERS_MOTION_MISMATCH',
    );
  }
}

async function assertAdminOrdersLocation(
  page: Page,
  expectedSearch: string,
): Promise<void> {
  await expect
    .poll(() => {
      const current = new URL(page.url());
      return { pathname: current.pathname, search: current.search };
    })
    .toEqual({ pathname: '/admin/orders', search: expectedSearch });
}

async function assertAdminOrdersViewport(
  page: Page,
  viewport: (typeof ADMIN_ORDERS_VIEWPORTS)[number],
  controller: SyntheticAdminOrdersController,
): Promise<void> {
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await openSyntheticAdminOrders(page, controller);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByText(/Showing 1.*6 of 51/u)).toBeVisible();

  const main = page.locator('#admin-main-content');
  const pageSurface = main.locator('> section').first();
  const table = page.getByRole('table', {
    name: 'Administrator orders, newest first',
  });
  const cards = page.getByRole('list', {
    name: 'Administrator orders, newest first',
  });
  const desktopLayout = viewport.width >= 1024;
  const collection = desktopLayout ? table : cards;
  const visibleEntry = desktopLayout
    ? table.locator('tbody tr').first()
    : cards.locator('li').first();
  const detailLink = desktopLayout
    ? table.locator('tbody th[scope="row"] a').first()
    : cards.getByRole('link', { name: /^View order ROA-/u }).first();
  const visibleOrderNumber = desktopLayout
    ? table.locator('tbody th[scope="row"] a').first()
    : cards.getByRole('heading', { level: 2 }).first();
  if (desktopLayout) {
    await expect(table).toBeVisible();
    await expect(cards).toBeHidden();
    expect(await table.locator('tbody th[scope="row"] a').allTextContents()).toEqual(
      SYNTHETIC_ADMIN_ORDERS.map((order) => order.public_order_number),
    );
  } else {
    await expect(cards).toBeVisible();
    await expect(table).toBeHidden();
    expect(await cards.getByRole('heading', { level: 2 }).allTextContents()).toEqual(
      SYNTHETIC_ADMIN_ORDERS.map((order) => order.public_order_number),
    );
  }

  const statusVariants = [
    ['Created', 'neutral'],
    ['Accepted', 'info'],
    ['Preparing', 'warning'],
    ['Ready', 'info'],
    ['Completed', 'success'],
    ['Cancelled', 'danger'],
  ] as const;
  for (const [label, variant] of statusVariants) {
    const labelNode = collection
      .locator('[data-variant] > span:last-child')
      .filter({ hasText: new RegExp(`^${label}$`, 'u') });
    await expect(labelNode).toHaveCount(1);
    await expect(labelNode.locator('..')).toHaveAttribute('data-variant', variant);
    await expect(labelNode.locator('..').locator('[aria-hidden="true"]')).toHaveCount(
      1,
    );
  }
  const readyBadge = collection
    .locator('[data-variant] > span:last-child')
    .filter({ hasText: /^Ready$/u })
    .locator('..');
  const acceptedBadge = collection
    .locator('[data-variant] > span:last-child')
    .filter({ hasText: /^Accepted$/u })
    .locator('..');
  safeInvariant(
    (await readyBadge.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      return runtime.getComputedStyle(element as unknown as RuntimeElement)
        .backgroundColor;
    })) !==
      (await acceptedBadge.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return runtime.getComputedStyle(element as unknown as RuntimeElement)
          .backgroundColor;
      })),
    'ADMIN_ORDERS_READY_PINE_TREATMENT_MISSING',
  );

  const largestOrder = (
    desktopLayout ? table.locator('tbody tr') : cards.locator('li')
  ).filter({ hasText: 'ROA-EFGHJKLMNPQR' });
  const largestTotal = desktopLayout
    ? largestOrder.locator('td').nth(3)
    : definitionValue(largestOrder, 'Total');
  await assertTextNotClipped(largestTotal, 'ADMIN_ORDERS_LONG_TOTAL_CLIPPED');
  await assertLongTextWraps(
    page.locator('header').getByText(ADMIN_ORDERS_EMAIL, { exact: true }),
  );
  await assertLongTextWraps(visibleOrderNumber);
  await assertMinimumTouchTarget(detailLink, 'ADMIN_ORDERS_DETAIL_TARGET_TOO_SMALL');
  await assertPurposefulAdminOrdersMotion(pageSurface, visibleEntry);
  const mainText = await main.innerText();
  expect(mainText).not.toMatch(/payment|stripe|card details|private payment/iu);
  await assertResponsiveSurface(page);

  const statusSelect = page.getByRole('combobox', {
    name: 'Status',
    exact: true,
  });
  await statusSelect.focus();
  await assertVisibleKeyboardFocus(statusSelect);
  const readyResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await statusSelect.selectOption('ready', { timeout: 5_000 });
  await assertResponseStatus(readyResponse, 200, 'ADMIN_ORDERS_READY_STATUS_MISMATCH');
  await assertAdminOrdersLocation(page, '?status=ready');
  await expect(page.getByText(/Showing 1.*1 of 51/u)).toBeVisible();
  await expect(statusSelect).toBeFocused();

  const nextButton = page.getByRole('button', { name: 'Next', exact: true });
  await blurActiveElement(page);
  await tabTo(page, nextButton, 48);
  await assertVisibleKeyboardFocus(nextButton);
  let releaseNextPage = (): void => undefined;
  controller.nextPageGate = new Promise<void>((resolve) => {
    releaseNextPage = resolve;
  });
  const orderRequestCountBeforeNext = controller.requests.filter(
    ({ pathname }) => pathname === ADMIN_ORDERS_API_PATH,
  ).length;
  const nextResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  const movedOrdersFocusTarget =
    viewport.width === 320
      ? page
          .getByRole('navigation', { name: 'Administrator navigation' })
          .getByRole('link', { exact: true, name: 'Menu' })
      : null;
  let duplicateObserved: boolean;
  try {
    await page.keyboard.press('Enter');
    await expect
      .poll(
        () =>
          controller.requests.filter(
            ({ pathname }) => pathname === ADMIN_ORDERS_API_PATH,
          ).length,
      )
      .toBe(orderRequestCountBeforeNext + 1);
    await expect(
      page.getByRole('status').getByText('Loading orders', { exact: true }),
    ).toBeVisible();
    const duplicateRequestObserved = page
      .waitForRequest(
        (request) => {
          const parsed = parseUrl(request.url());
          return parsed?.pathname === ADMIN_ORDERS_API_PATH;
        },
        { timeout: 250 },
      )
      .then(
        () => true,
        () => false,
      );
    await page.keyboard.press('Enter');
    duplicateObserved = await duplicateRequestObserved;
    if (movedOrdersFocusTarget !== null) {
      await movedOrdersFocusTarget.focus();
      await assertVisibleKeyboardFocus(movedOrdersFocusTarget);
    }
  } finally {
    releaseNextPage();
    controller.nextPageGate = null;
  }
  safeInvariant(!duplicateObserved, 'ADMIN_ORDERS_DUPLICATE_PAGE_REQUEST');
  await assertResponseStatus(nextResponse, 200, 'ADMIN_ORDERS_NEXT_STATUS_MISMATCH');
  await assertAdminOrdersLocation(page, '?status=ready&offset=50');
  const secondPageSummary = page.getByText(/Showing 51.*51 of 51/u);
  if (movedOrdersFocusTarget === null) {
    await expect(secondPageSummary).toBeFocused();
    await assertVisibleKeyboardFocus(secondPageSummary);
  } else {
    await expect(movedOrdersFocusTarget).toBeFocused();
  }
  const previousButton = page.getByRole('button', {
    name: 'Previous',
    exact: true,
  });
  await expect(previousButton).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await assertResponsiveSurface(page);
  await blurActiveElement(page);
  await tabTo(page, previousButton, 48);
  await assertVisibleKeyboardFocus(previousButton);
  const previousResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(
    previousResponse,
    200,
    'ADMIN_ORDERS_PREVIOUS_STATUS_MISMATCH',
  );
  await assertAdminOrdersLocation(page, '?status=ready');
  const returnedSummary = page.getByText(/Showing 1.*1 of 51/u);
  await expect(returnedSummary).toBeFocused();
  await assertVisibleKeyboardFocus(returnedSummary);

  const orderTypeSelect = page.getByRole('combobox', {
    name: 'Order type',
    exact: true,
  });
  await orderTypeSelect.focus();
  await assertVisibleKeyboardFocus(orderTypeSelect);
  const emptyResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await orderTypeSelect.selectOption('takeaway', {
    timeout: 5_000,
  });
  await assertResponseStatus(emptyResponse, 200, 'ADMIN_ORDERS_EMPTY_STATUS_MISMATCH');
  await assertAdminOrdersLocation(page, '?status=ready&order_type=takeaway');
  await expect(
    page.getByRole('heading', { level: 2, name: 'No matching orders' }),
  ).toBeVisible();
  await expect(orderTypeSelect).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Orders pagination' })).toHaveCount(
    0,
  );
  await assertResponsiveSurface(page);

  const defaultResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await assertResponseStatus(
    defaultResponse,
    200,
    'ADMIN_ORDERS_CLEAR_STATUS_MISMATCH',
  );
  await assertAdminOrdersLocation(page, '');
  await expect(statusSelect).toBeFocused();
  await expect(page.getByText(/Showing 1.*6 of 51/u)).toBeVisible();

  controller.malformedNext = true;
  const failedRefresh = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await assertResponseStatus(
    failedRefresh,
    200,
    'ADMIN_ORDERS_MALFORMED_REFRESH_STATUS_MISMATCH',
  );
  const refreshAlert = page.getByRole('alert');
  await expect(refreshAlert.getByText('Orders refresh failed')).toBeVisible();
  await expect(page.getByText(ADMIN_ORDERS_PRIVATE_COPY, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    collection.getByText(SYNTHETIC_ADMIN_ORDERS[0].public_order_number, {
      exact: true,
    }),
  ).toBeVisible();
  const retryButton = refreshAlert.getByRole('button', { name: 'Retry orders' });
  await assertMinimumTouchTarget(retryButton, 'ADMIN_ORDERS_RETRY_TARGET_TOO_SMALL');
  await assertResponsiveSurface(page);
  await blurActiveElement(page);
  await tabTo(page, retryButton, 48);
  await assertVisibleKeyboardFocus(retryButton);
  const retryResponse = waitForApiResponse(page, 'GET', ADMIN_ORDERS_API_PATH);
  await page.keyboard.press('Enter');
  await assertResponseStatus(retryResponse, 200, 'ADMIN_ORDERS_RETRY_STATUS_MISMATCH');
  await expect(refreshAlert).toHaveCount(0);
  const retriedSummary = page.getByText(/Showing 1.*6 of 51/u);
  await expect(retriedSummary).toBeFocused();
  await assertVisibleKeyboardFocus(retriedSummary);

  controller.emptyDefault = true;
  await openSyntheticAdminOrders(page, controller);
  await expect(
    page.getByRole('heading', { level: 2, name: 'No orders yet' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Orders pagination' })).toHaveCount(
    0,
  );
  await assertResponsiveSurface(page);

  controller.emptyDefault = false;
  await openSyntheticAdminOrders(page, controller);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  const reducedEntry = desktopLayout
    ? table.locator('tbody tr').first()
    : cards.locator('li').first();
  await assertReducedMotionContract(page, [pageSurface, reducedEntry]);
  await reducedEntry.hover();
  await expect
    .poll(() =>
      reducedEntry.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return runtime.getComputedStyle(element as unknown as RuntimeElement).transform;
      }),
    )
    .toBe('none');
  await blurActiveElement(page);
  await tabTo(page, statusSelect, 32);
  await assertVisibleKeyboardFocus(statusSelect);
  await assertMinimumTouchTarget(statusSelect, 'ADMIN_ORDERS_STATUS_TARGET_TOO_SMALL');
  await assertMinimumTouchTarget(
    orderTypeSelect,
    'ADMIN_ORDERS_ORDER_TYPE_TARGET_TOO_SMALL',
  );
  await assertResponsiveSurface(page);

  const orderRequests = controller.requests.filter(
    ({ pathname }) => pathname === ADMIN_ORDERS_API_PATH,
  );
  expect(orderRequests.map(({ search }) => search)).toEqual([
    '?limit=50&offset=0',
    '?status=ready&limit=50&offset=0',
    '?status=ready&limit=50&offset=50',
    '?status=ready&limit=50&offset=0',
    '?status=ready&order_type=takeaway&limit=50&offset=0',
    '?limit=50&offset=0',
    '?limit=50&offset=0',
    '?limit=50&offset=0',
    '?limit=50&offset=0',
    '?limit=50&offset=0',
  ]);
  for (const request of controller.requests) {
    expect(request).toMatchObject({
      authorization: `Bearer ${ADMIN_ORDERS_TOKEN}`,
      capability: null,
      method: 'GET',
      postData: null,
    });
  }
  safeInvariant(
    viewport.width === (await page.viewportSize())?.width &&
      viewport.height === (await page.viewportSize())?.height,
    'ADMIN_ORDERS_VIEWPORT_CHANGED',
  );
}

interface G1MenuRecoveryController {
  failRequests: boolean;
  readonly networkIssues: string[];
  requestCount: number;
}

interface G1RouteGuardController {
  readonly networkIssues: string[];
  nextResponseGate: Promise<void> | null;
  requestCount: number;
  succeedNextRequest: boolean;
}

interface G1StorageEntry {
  readonly key: string;
  readonly value: string;
}

type G1CustomerRouteState =
  | 'account-detail-long'
  | 'account-empty'
  | 'cart-empty'
  | 'checkout-long'
  | 'landing'
  | 'menu-long'
  | 'not-found'
  | 'order-status-error'
  | 'standard';

interface G1CustomerRouteExpectation {
  readonly appShell: boolean;
  readonly heading: string;
  readonly pathname: string;
  readonly state: G1CustomerRouteState;
}

const G1_PUBLIC_ROUTE_EXPECTATIONS: readonly G1CustomerRouteExpectation[] = [
  {
    appShell: true,
    heading: 'Fresh food, ordered your way',
    pathname: '/',
    state: 'landing',
  },
  { appShell: true, heading: 'Our menu', pathname: '/menu', state: 'menu-long' },
  { appShell: true, heading: 'Your cart', pathname: '/cart', state: 'cart-empty' },
  {
    appShell: true,
    heading: 'Order created',
    pathname: CHECKOUT_ROUTE,
    state: 'checkout-long',
  },
  {
    appShell: true,
    heading: 'You returned from secure checkout',
    pathname: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/payment-return`,
    state: 'standard',
  },
  {
    appShell: true,
    heading: 'You left secure checkout',
    pathname: `/orders/${CHECKOUT_PUBLIC_ORDER_NUMBER}/checkout-cancelled`,
    state: 'standard',
  },
  { appShell: false, heading: 'Sign in', pathname: '/login', state: 'standard' },
  {
    appShell: false,
    heading: 'Create account',
    pathname: '/register',
    state: 'standard',
  },
  {
    appShell: true,
    heading: 'Page not found',
    pathname: '/g1-customer-not-found',
    state: 'not-found',
  },
  {
    appShell: true,
    heading: 'Order status',
    pathname: ORDER_STATUS_ROUTE,
    state: 'order-status-error',
  },
];

const G1_ACCOUNT_ROUTE_EXPECTATIONS: readonly G1CustomerRouteExpectation[] = [
  {
    appShell: true,
    heading: 'My orders',
    pathname: '/account',
    state: 'account-empty',
  },
  {
    appShell: true,
    heading: 'Order details',
    pathname: `/account/orders/${ACCOUNT_LONG_ORDER_NUMBER}`,
    state: 'account-detail-long',
  },
];

async function seedG1SessionStorage(
  context: BrowserContext,
  entries: readonly G1StorageEntry[],
): Promise<void> {
  await context.addInitScript(
    ({ storageEntries }) => {
      const runtime = globalThis as typeof globalThis & {
        location: { protocol: string };
        sessionStorage: { setItem: (key: string, value: string) => void };
      };
      if (
        runtime.location.protocol === 'http:' ||
        runtime.location.protocol === 'https:'
      ) {
        for (const entry of storageEntries) {
          runtime.sessionStorage.setItem(entry.key, entry.value);
        }
      }
    },
    { storageEntries: entries },
  );
}

async function installG1MenuRecoveryRouting(
  page: Page,
  controller: G1MenuRecoveryController,
): Promise<void> {
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      controller.networkIssues.push('g1-menu-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (
      parsed.pathname === AUTH_MENU_API_PATH &&
      parsed.search === '' &&
      request.method() === 'GET'
    ) {
      controller.requestCount += 1;
      await route.fulfill({
        body: JSON.stringify(
          controller.failRequests
            ? { detail: 'Private synthetic menu failure' }
            : SYNTHETIC_CART_MENU,
        ),
        contentType: 'application/json',
        status: controller.failRequests ? 503 : 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `g1-menu-unexpected-api:${request.method()}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
}

async function installG1RouteGuardRecoveryRouting(
  page: Page,
  controller: G1RouteGuardController,
): Promise<void> {
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      controller.networkIssues.push('g1-route-guard-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      request.method() === 'GET'
    ) {
      controller.requestCount += 1;
      const responseGate = controller.nextResponseGate;
      controller.nextResponseGate = null;
      if (responseGate !== null) {
        await responseGate;
      }
      if (controller.succeedNextRequest) {
        controller.succeedNextRequest = false;
        await route.fulfill({
          body: JSON.stringify({
            email: ACCOUNT_EMAIL,
            id: ACCOUNT_USER_ID,
            is_active: true,
            role: 'customer',
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ detail: 'Private synthetic session failure' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    if (
      parsed.pathname === ACCOUNT_ORDERS_API_PATH &&
      parsed.search === '?limit=50&offset=0' &&
      request.method() === 'GET'
    ) {
      await route.fulfill({
        body: JSON.stringify({ items: [], limit: 50, offset: 0, total: 0 }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      controller.networkIssues.push(
        `g1-route-guard-unexpected-api:${request.method()}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
}

async function installG1CustomerMatrixRouting(
  page: Page,
  networkIssues: string[],
): Promise<void> {
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('g1-matrix-external-or-invalid-request');
      await route.abort();
      return;
    }
    const method = request.method();

    if (method === 'GET' && parsed.pathname === AUTH_MENU_API_PATH) {
      await route.fulfill({
        body: JSON.stringify(SYNTHETIC_CART_MENU),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (method === 'GET' && parsed.pathname === CHECKOUT_ORDER_API_PATH) {
      await route.fulfill({
        body: JSON.stringify(SYNTHETIC_CHECKOUT_ORDER),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (method === 'GET' && parsed.pathname === ORDER_STATUS_API_PATH) {
      await route.fulfill({
        body: JSON.stringify({ detail: 'Synthetic recoverable status failure' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    if (method === 'GET' && parsed.pathname === AUTH_ME_API_PATH) {
      await route.fulfill({
        body: JSON.stringify({
          email: ACCOUNT_EMAIL,
          id: ACCOUNT_USER_ID,
          is_active: true,
          role: 'customer',
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (
      method === 'GET' &&
      parsed.pathname === accountDetailApiPath(ACCOUNT_LONG_ORDER_NUMBER)
    ) {
      await route.fulfill({
        body: JSON.stringify(
          syntheticAccountDetailOrder(ACCOUNT_LONG_ORDER_NUMBER, 'completed'),
        ),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (method === 'GET' && parsed.pathname === ACCOUNT_ORDERS_API_PATH) {
      await route.fulfill({
        body: JSON.stringify(syntheticAccountPage([], 0, 0)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push(
        `g1-matrix-unexpected-api:${method}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
}

async function assertG1LandingPriorityImage(
  page: Page,
  viewportWidth: number,
): Promise<void> {
  const heroImage = page.getByRole('img', {
    exact: true,
    name: 'A candlelit dining table set with Nordic-inspired dishes',
  });
  await expect(heroImage).toBeVisible();
  const imageRuntime = await heroImage.evaluate(async (element) => {
    const image = element as unknown as RuntimeElement & {
      decode: () => Promise<void>;
    };
    const runtime = globalThis as typeof globalThis & { devicePixelRatio: number };
    await image.decode();
    return {
      currentSrc: image.currentSrc ?? '',
      devicePixelRatio: runtime.devicePixelRatio,
      fetchPriority: image.getAttribute('fetchpriority'),
      height: image.getAttribute('height'),
      loading: image.getAttribute('loading'),
      naturalHeight: image.naturalHeight ?? 0,
      naturalWidth: image.naturalWidth ?? 0,
      width: image.getAttribute('width'),
    };
  });
  const selectedImage = new URL(imageRuntime.currentSrc);
  const expectedCandidateWidth =
    viewportWidth === 430 || viewportWidth === 768 ? 1024 : 640;
  safeInvariant(
    selectedImage.origin === baseOrigin &&
      selectedImage.pathname ===
        `/images/brand/optimized/hero/restaurant-hero-${expectedCandidateWidth}w.webp`,
    'G1_LANDING_RESPONSIVE_IMAGE_CANDIDATE_MISMATCH',
  );
  safeInvariant(
    imageRuntime.fetchPriority === 'high' &&
      imageRuntime.loading === 'eager' &&
      imageRuntime.width === '1672' &&
      imageRuntime.height === '941' &&
      imageRuntime.naturalHeight > 0 &&
      imageRuntime.naturalWidth > 0,
    'G1_LANDING_LCP_PRIORITY_CONTRACT_MISMATCH',
  );
  await expect(page.locator('main img[fetchpriority=high]')).toHaveCount(1);
}

async function assertG1CustomerMatrixRoute(
  page: Page,
  expectation: G1CustomerRouteExpectation,
  viewport: (typeof G1_CUSTOMER_VIEWPORTS)[number],
): Promise<void> {
  await page.goto(expectation.pathname);
  const main = page.getByRole('main');
  const heading = main.getByRole('heading', {
    exact: true,
    level: 1,
    name: expectation.heading,
  });
  await expect(main).toHaveCount(1);
  await expect(main).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await assertTextNotClipped(heading, 'G1_MATRIX_HEADING_CLIPPED');

  if (expectation.appShell) {
    await expect(page.getByRole('banner')).toHaveCount(1);
    const headerControls = page.locator(
      'header a:visible, header button:visible:not([disabled])',
    );
    const controlCount = await headerControls.count();
    safeInvariant(controlCount > 0, 'G1_MATRIX_HEADER_CONTROLS_MISSING');
    for (let index = 0; index < controlCount; index += 1) {
      await assertMinimumTouchTarget(
        headerControls.nth(index),
        'G1_MATRIX_HEADER_TARGET_TOO_SMALL',
      );
    }
  } else {
    await expect(page.getByRole('banner')).toHaveCount(0);
  }

  if (expectation.state === 'landing') {
    await assertG1LandingPriorityImage(page, viewport.width);
  }
  if (expectation.state === 'menu-long') {
    await assertTextNotClipped(
      page.getByRole('heading', {
        exact: true,
        level: 3,
        name: CART_FALLBACK_ITEM_NAME,
      }),
      'G1_MATRIX_MENU_LONG_NAME_CLIPPED',
    );
  }
  if (expectation.state === 'cart-empty') {
    await expect(page.getByText('Your cart is empty.', { exact: true })).toBeVisible();
  }
  if (expectation.state === 'checkout-long') {
    await assertTextNotClipped(
      page.getByText(CHECKOUT_LONG_ITEM_NAME, { exact: true }),
      'G1_MATRIX_CHECKOUT_LONG_NAME_CLIPPED',
    );
  }
  if (expectation.state === 'not-found') {
    const homeLink = main.getByRole('link', { exact: true, name: 'Back home' });
    await assertMinimumTouchTarget(homeLink, 'G1_MATRIX_NOT_FOUND_TARGET_TOO_SMALL');
  }
  if (expectation.state === 'order-status-error') {
    const alert = main.getByRole('alert');
    await expect(alert).toContainText('We could not refresh the order');
    await assertMinimumTouchTarget(
      alert.getByRole('button', { exact: true, name: 'Retry status' }),
      'G1_MATRIX_ORDER_STATUS_RETRY_TARGET_TOO_SMALL',
    );
  }
  if (expectation.state === 'account-empty') {
    await expect(
      main.getByRole('heading', { exact: true, level: 2, name: 'No orders yet' }),
    ).toBeVisible();
  }
  if (expectation.state === 'account-detail-long') {
    await assertTextNotClipped(
      main.getByText(ACCOUNT_DETAIL_LONG_ITEM_NAME, { exact: true }),
      'G1_MATRIX_ACCOUNT_LONG_NAME_CLIPPED',
    );
  }

  await blurActiveElement(page);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(page.locator(':focus'));
  await assertReducedMotionContract(page, [main, heading]);
  const media = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      devicePixelRatio: number;
      document: { documentElement: { clientWidth: number; scrollWidth: number } };
      innerWidth: number;
      matchMedia: (query: string) => { matches: boolean };
    };
    return {
      clientWidth: runtime.document.documentElement.clientWidth,
      devicePixelRatio: runtime.devicePixelRatio,
      forcedColors: runtime.matchMedia('(forced-colors: active)').matches,
      innerWidth: runtime.innerWidth,
      reducedMotion: runtime.matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollWidth: runtime.document.documentElement.scrollWidth,
    };
  });
  safeInvariant(media.reducedMotion, 'G1_MATRIX_REDUCED_MOTION_MISMATCH');
  safeInvariant(
    media.forcedColors === (viewport.width === 430),
    'G1_MATRIX_FORCED_COLORS_MISMATCH',
  );
  safeInvariant(
    media.devicePixelRatio === viewport.deviceScaleFactor,
    'G1_MATRIX_DEVICE_SCALE_FACTOR_MISMATCH',
  );
  if (viewport.width === 320) {
    // 320 CSS pixels deterministically represents a 640-pixel layout at 200% zoom.
    safeInvariant(
      media.innerWidth === 320 &&
        media.clientWidth === 320 &&
        media.scrollWidth <= 320 + OVERFLOW_TOLERANCE_PX,
      'G1_MATRIX_200_PERCENT_REFLOW_MISMATCH',
    );
  }
  await assertResponsiveSurface(page);
}

async function assertG1CustomerRouteMatrix(browser: Browser): Promise<void> {
  const publicStorageEntries: readonly G1StorageEntry[] = [
    {
      key: CHECKOUT_ACCESS_STORAGE_KEY,
      value: JSON.stringify({
        publicOrderNumber: CHECKOUT_PUBLIC_ORDER_NUMBER,
        token: CHECKOUT_CAPABILITY,
        version: 1,
      }),
    },
    {
      key: CHECKOUT_ATTEMPT_STORAGE_KEY,
      value: JSON.stringify({
        idempotencyKey: CHECKOUT_ATTEMPT_ID,
        publicOrderNumber: CHECKOUT_PUBLIC_ORDER_NUMBER,
        version: 1,
      }),
    },
    {
      key: ORDER_STATUS_ACCESS_STORAGE_KEY,
      value: JSON.stringify({
        publicOrderNumber: ORDER_STATUS_PUBLIC_ORDER_NUMBER,
        token: ORDER_STATUS_CAPABILITY,
        version: 1,
      }),
    },
  ];
  const accountStorageEntries: readonly G1StorageEntry[] = [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ACCOUNT_TOKEN, version: 1 }),
    },
  ];

  for (const viewport of G1_CUSTOMER_VIEWPORTS) {
    const contextOptions = {
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      forcedColors: viewport.width === 430 ? ('active' as const) : ('none' as const),
      reducedMotion: 'reduce' as const,
      viewport: { height: viewport.height, width: viewport.width },
    };
    const publicContext = await browser.newContext(contextOptions);
    await seedG1SessionStorage(publicContext, publicStorageEntries);
    const publicPage = await publicContext.newPage();
    const publicNetworkIssues: string[] = [];
    const publicGuard = new BrowserSafetyGuard(
      publicPage,
      [CHECKOUT_CAPABILITY, CHECKOUT_ATTEMPT_ID, ORDER_STATUS_CAPABILITY],
      [],
      [{ method: 'GET', pathname: ORDER_STATUS_API_PATH, status: 503 }],
    );
    await installG1CustomerMatrixRouting(publicPage, publicNetworkIssues);
    try {
      for (const expectation of G1_PUBLIC_ROUTE_EXPECTATIONS) {
        await assertG1CustomerMatrixRoute(publicPage, expectation, viewport);
      }
      expect(publicNetworkIssues, 'G1_PUBLIC_MATRIX_NETWORK_FAILURE').toEqual([]);
    } finally {
      try {
        publicGuard.assertClean();
      } finally {
        await closeContext(publicContext);
      }
    }

    const accountContext = await browser.newContext(contextOptions);
    await seedG1SessionStorage(accountContext, accountStorageEntries);
    const accountPage = await accountContext.newPage();
    const accountNetworkIssues: string[] = [];
    const accountGuard = new BrowserSafetyGuard(accountPage, [ACCOUNT_TOKEN]);
    await installG1CustomerMatrixRouting(accountPage, accountNetworkIssues);
    try {
      for (const expectation of G1_ACCOUNT_ROUTE_EXPECTATIONS) {
        await assertG1CustomerMatrixRoute(accountPage, expectation, viewport);
      }
      expect(accountNetworkIssues, 'G1_ACCOUNT_MATRIX_NETWORK_FAILURE').toEqual([]);
    } finally {
      try {
        accountGuard.assertClean();
      } finally {
        await closeContext(accountContext);
      }
    }
  }
}

async function assertG1ContainedQuantityFocusRing(
  quantityControl: Locator,
  focusedButton: Locator,
): Promise<void> {
  await assertVisibleKeyboardFocus(focusedButton);
  const ring = await focusedButton.evaluate((element, tolerance) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const button = element as unknown as RuntimeElement;
    const parent = button.closest('[role="group"]');
    if (parent === null) return null;
    const buttonBox = button.getBoundingClientRect();
    const parentBox = parent.getBoundingClientRect();
    const style = runtime.getComputedStyle(button);
    return {
      bottomContained: buttonBox.bottom <= parentBox.bottom + tolerance,
      hasInsetRing: style.boxShadow.includes('inset'),
      leftContained: buttonBox.left >= parentBox.left - tolerance,
      outlineOffset: Number.parseFloat(style.outlineOffset),
      rightContained: buttonBox.right <= parentBox.right + tolerance,
      topContained: buttonBox.top >= parentBox.top - tolerance,
    };
  }, OVERFLOW_TOLERANCE_PX);
  safeInvariant(ring !== null, 'G1_QUANTITY_GROUP_BOX_MISSING');
  safeInvariant(
    ring.bottomContained &&
      ring.leftContained &&
      ring.rightContained &&
      ring.topContained &&
      ring.hasInsetRing &&
      ring.outlineOffset <= 0,
    'G1_QUANTITY_FOCUS_RING_CLIPPED',
  );
  await assertContainedWithin(
    focusedButton,
    quantityControl,
    'G1_QUANTITY_BUTTON_OUTSIDE_GROUP',
  );
}

async function assertG1MenuAndShellRecovery(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  const page = await context.newPage();
  const controller: G1MenuRecoveryController = {
    failRequests: true,
    networkIssues: [],
    requestCount: 0,
  };
  const guard = new BrowserSafetyGuard(
    page,
    [],
    [],
    [{ method: 'GET', pathname: AUTH_MENU_API_PATH, status: 503 }],
  );
  await installG1MenuRecoveryRouting(page, controller);

  try {
    const initialResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    await page.goto('/menu');
    await assertResponseStatus(initialResponse, 503, 'G1_MENU_INITIAL_503_MISMATCH');
    const cartLink = page
      .getByRole('navigation', { name: 'Customer navigation' })
      .getByRole('link', { exact: true, name: 'Cart' });
    await assertMinimumTouchTarget(cartLink, 'G1_SHELL_CART_TARGET_TOO_SMALL');
    const retry = page.getByRole('button', { exact: true, name: 'Retry' });
    await expect(retry).toBeVisible();
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await blurActiveElement(page);
    await tabTo(page, retry, 64);
    await assertVisibleKeyboardFocus(retry);

    const repeatedFailure = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    await page.keyboard.press('Enter');
    await assertResponseStatus(repeatedFailure, 503, 'G1_MENU_REPEATED_503_MISMATCH');
    await expect(retry).toBeFocused();
    await assertVisibleKeyboardFocus(retry);
    await expect(page.getByRole('alert')).not.toContainText(
      'Private synthetic menu failure',
    );

    controller.failRequests = false;
    const recoveryResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    await page.keyboard.press('Enter');
    await assertResponseStatus(recoveryResponse, 200, 'G1_MENU_RECOVERY_MISMATCH');
    await expect(retry).toHaveCount(0);
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Our menu' }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { exact: true, name: 'Menu categories' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);
    safeInvariant(controller.requestCount >= 3, 'G1_MENU_REQUEST_COUNT_TOO_LOW');
    expect(controller.networkIssues, 'G1_MENU_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertG1RouteGuardRecovery(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(context, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ACCOUNT_TOKEN, version: 1 }),
    },
  ]);
  const page = await context.newPage();
  const controller: G1RouteGuardController = {
    networkIssues: [],
    nextResponseGate: null,
    requestCount: 0,
    succeedNextRequest: false,
  };
  const guard = new BrowserSafetyGuard(
    page,
    [ACCOUNT_TOKEN],
    [],
    [{ method: 'GET', pathname: AUTH_ME_API_PATH, status: 503 }],
  );
  await installG1RouteGuardRecoveryRouting(page, controller);

  try {
    const initialResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    await page.goto('/account');
    await assertResponseStatus(
      initialResponse,
      503,
      'G1_ROUTE_GUARD_INITIAL_503_MISMATCH',
    );
    const alert = page.getByRole('alert');
    const retry = alert.getByRole('button', {
      exact: true,
      name: 'Retry validation',
    });
    const logout = alert.getByRole('button', { exact: true, name: 'Log out' });
    await expect(alert).not.toContainText('Private synthetic session failure');
    await assertMinimumTouchTarget(retry, 'G1_ROUTE_GUARD_RETRY_TARGET_TOO_SMALL');
    await assertMinimumTouchTarget(logout, 'G1_ROUTE_GUARD_LOGOUT_TARGET_TOO_SMALL');
    await blurActiveElement(page);
    await tabTo(page, retry, 64);
    await assertVisibleKeyboardFocus(retry);

    let releaseRepeatedFailure = (): void => undefined;
    controller.nextResponseGate = new Promise<void>((resolve) => {
      releaseRepeatedFailure = resolve;
    });
    const repeatedFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    try {
      await page.keyboard.press('Enter');
      await expect(
        page.getByText('Checking your session', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toBeFocused();
    } finally {
      releaseRepeatedFailure();
    }
    await assertResponseStatus(
      repeatedFailure,
      503,
      'G1_ROUTE_GUARD_REPEATED_503_MISMATCH',
    );
    await expect(retry).toBeFocused();
    await assertVisibleKeyboardFocus(retry);
    controller.succeedNextRequest = true;
    const recoveryResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    const accountResponse = waitForApiResponse(page, 'GET', ACCOUNT_ORDERS_API_PATH);
    await page.keyboard.press('Enter');
    await Promise.all([
      assertResponseStatus(
        recoveryResponse,
        200,
        'G1_ROUTE_GUARD_RECOVERY_STATUS_MISMATCH',
      ),
      assertResponseStatus(
        accountResponse,
        200,
        'G1_ROUTE_GUARD_ACCOUNT_STATUS_MISMATCH',
      ),
    ]);
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'My orders' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
    await assertResponsiveSurface(page);
    safeInvariant(controller.requestCount >= 3, 'G1_ROUTE_GUARD_REQUEST_COUNT_TOO_LOW');
    expect(controller.networkIssues, 'G1_ROUTE_GUARD_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertStandaloneAuthRouteFocus(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  const page = await context.newPage();
  const networkIssues: string[] = [];
  const guard = new BrowserSafetyGuard(page, []);
  let loginChunkRequestCount = 0;
  let releaseLoginChunk = (): void => undefined;
  const loginChunkGate = new Promise<void>((resolve) => {
    releaseLoginChunk = resolve;
  });
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('standalone-auth-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push(
        'standalone-auth-unexpected-api:' + request.method() + ':' + parsed.pathname,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    if (/^\/assets\/LoginPage-[A-Za-z0-9_-]+\.js$/u.test(parsed.pathname)) {
      loginChunkRequestCount += 1;
      await loginChunkGate;
      await route.continue();
      return;
    }
    await route.continue();
  });

  try {
    await page.goto('/');
    const loginLink = page
      .getByRole('navigation', { exact: true, name: 'Customer navigation' })
      .getByRole('link', { exact: true, name: 'Log in' });
    await loginLink.focus();
    const loginNavigation = page.keyboard.press('Enter');
    const loadingMain = page.getByRole('main');
    try {
      await expect.poll(() => loginChunkRequestCount).toBe(1);
      await expect(loadingMain).toHaveAttribute('aria-busy', 'true');
      await expect(
        loadingMain.getByText('Loading page', { exact: true }),
      ).toBeVisible();
      await expect(loadingMain).toBeFocused();
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const focusTarget = runtime.document.createElement('button');
        focusTarget.id = 'stage-i-connected-focus';
        focusTarget.textContent = 'Persistent focus target';
        runtime.document.body.append(focusTarget);
        focusTarget.focus?.();
      });
    } finally {
      releaseLoginChunk();
    }
    await loginNavigation;
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Sign in' }),
    ).toBeVisible();
    const persistentFocusTarget = page.locator('#stage-i-connected-focus');
    await expect(persistentFocusTarget).toBeFocused();
    await assertResponsiveSurface(page);
    await persistentFocusTarget.evaluate((element) => element.remove());

    const registerLink = page.getByRole('link', {
      exact: true,
      name: 'Create an account',
    });
    await registerLink.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Create account' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
    await assertResponsiveSurface(page);
    expect(loginChunkRequestCount, 'STANDALONE_LOGIN_CHUNK_REQUEST_MISMATCH').toBe(1);
    expect(networkIssues, 'STANDALONE_AUTH_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    releaseLoginChunk();
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertStandaloneAuthSessionRetryFocus(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  await seedG1SessionStorage(context, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ACCOUNT_TOKEN, version: 1 }),
    },
  ]);
  const page = await context.newPage();
  const networkIssues: string[] = [];
  let requestCount = 0;
  let nextResponseGate: Promise<void> | null = null;
  let releaseResponse = (): void => undefined;
  const holdNextResponse = (): void => {
    nextResponseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
  };
  const guard = new BrowserSafetyGuard(
    page,
    [ACCOUNT_TOKEN],
    [],
    [{ method: 'GET', pathname: AUTH_ME_API_PATH, status: 503 }],
  );
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('standalone-session-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      request.method() === 'GET'
    ) {
      requestCount += 1;
      const responseGate = nextResponseGate;
      nextResponseGate = null;
      if (responseGate !== null) {
        await responseGate;
      }
      await route.fulfill({
        body: JSON.stringify({ detail: 'Private synthetic session failure' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push(
        'standalone-session-unexpected-api:' + request.method() + ':' + parsed.pathname,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });

  try {
    const initialFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    await page.goto('/login');
    await assertResponseStatus(
      initialFailure,
      503,
      'STANDALONE_SESSION_INITIAL_FAILURE_STATUS_MISMATCH',
    );
    let retry = page.getByRole('button', {
      exact: true,
      name: 'Retry validation',
    });
    await retry.focus();
    await assertVisibleKeyboardFocus(retry);

    holdNextResponse();
    const repeatedFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    try {
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', {
          exact: true,
          level: 1,
          name: 'Checking your session',
        }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toBeFocused();
    } finally {
      releaseResponse();
    }
    await assertResponseStatus(
      repeatedFailure,
      503,
      'STANDALONE_SESSION_REPEATED_FAILURE_STATUS_MISMATCH',
    );
    await expect(
      page.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Session validation is unavailable',
      }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();

    retry = page.getByRole('button', {
      exact: true,
      name: 'Retry validation',
    });
    await retry.focus();
    holdNextResponse();
    const movedFocusFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    try {
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('heading', {
          exact: true,
          level: 1,
          name: 'Checking your session',
        }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toBeFocused();
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        const focusTarget = runtime.document.createElement('button');
        focusTarget.id = 'stage-i-session-connected-focus';
        focusTarget.textContent = 'Persistent session focus target';
        runtime.document.body.append(focusTarget);
        focusTarget.focus?.();
      });
    } finally {
      releaseResponse();
    }
    await assertResponseStatus(
      movedFocusFailure,
      503,
      'STANDALONE_SESSION_MOVED_FOCUS_FAILURE_STATUS_MISMATCH',
    );
    const persistentFocusTarget = page.locator('#stage-i-session-connected-focus');
    await expect(persistentFocusTarget).toBeFocused();
    await persistentFocusTarget.evaluate((element) => element.remove());
    safeInvariant(requestCount === 3, 'STANDALONE_SESSION_REQUEST_COUNT_MISMATCH');
    expect(networkIssues, 'STANDALONE_SESSION_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    releaseResponse();
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertG1CartQuoteAndMinimumBoundary(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(context, [
    {
      key: CART_STORAGE_KEY,
      value: JSON.stringify({
        items: [{ menuItemId: CART_IMAGE_ITEM_ID, quantity: 2 }],
        version: 1,
      }),
    },
  ]);
  const page = await context.newPage();
  const quoteRequests: SyntheticCartQuoteItem[][] = [];
  const networkIssues: string[] = [];
  const failureController: SyntheticCartFailureController = {
    controlled503Count: 0,
    failQuotes: true,
  };
  const guard = new BrowserSafetyGuard(
    page,
    [],
    [],
    [{ method: 'POST', pathname: '/api/v1/orders/quote', status: 503 }],
  );
  await installSyntheticCartRouting(
    page,
    quoteRequests,
    networkIssues,
    failureController,
  );

  try {
    const initialResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.goto('/cart');
    await assertResponseStatus(initialResponse, 503, 'G1_CART_INITIAL_503_MISMATCH');
    const retry = page.getByRole('button', { exact: true, name: 'Retry quote' });
    await expect(retry).toBeVisible();
    await blurActiveElement(page);
    await tabTo(page, retry, 64);
    await assertVisibleKeyboardFocus(retry);

    const repeatedFailure = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.keyboard.press('Enter');
    await assertResponseStatus(repeatedFailure, 503, 'G1_CART_REPEATED_503_MISMATCH');
    await expect(retry).toBeFocused();
    await assertVisibleKeyboardFocus(retry);

    failureController.failQuotes = false;
    const recoveryResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.keyboard.press('Enter');
    await assertResponseStatus(recoveryResponse, 200, 'G1_CART_RECOVERY_MISMATCH');
    await expect(retry).toHaveCount(0);
    await expect(
      page.getByRole('heading', { exact: true, level: 2, name: 'Server quote' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        exact: true,
        name: 'Place order and continue to payment',
      }),
    ).toBeEnabled();

    const quantityControl = page.getByRole('group', {
      exact: true,
      name: `Quantity for ${MENU_ITEM_NAME}`,
    });
    const value = quantityControl.getByLabel(`${MENU_ITEM_NAME} quantity`, {
      exact: true,
    });
    const decrement = quantityControl.getByRole('button', {
      exact: true,
      name: `Decrease quantity for ${MENU_ITEM_NAME}`,
    });
    const increment = quantityControl.getByRole('button', {
      exact: true,
      name: `Increase quantity for ${MENU_ITEM_NAME}`,
    });
    await expect(value).toHaveText('2');
    await assertMinimumTouchTarget(decrement, 'G1_CART_DECREMENT_TARGET_TOO_SMALL');
    await assertMinimumTouchTarget(increment, 'G1_CART_INCREMENT_TARGET_TOO_SMALL');
    await decrement.focus();
    await assertG1ContainedQuantityFocusRing(quantityControl, decrement);
    const boundaryQuote = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.keyboard.press('Enter');
    await expect(value).toHaveText('1');
    await expect(increment).toBeFocused();
    await assertG1ContainedQuantityFocusRing(quantityControl, increment);
    await assertResponseStatus(boundaryQuote, 200, 'G1_CART_MINIMUM_QUOTE_MISMATCH');

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await increment.focus();
    const forcedColorsRing = await increment.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
      return {
        outlineOffset: Number.parseFloat(style.outlineOffset),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    safeInvariant(
      forcedColorsRing.outlineOffset <= -forcedColorsRing.outlineWidth &&
        forcedColorsRing.outlineStyle !== 'none' &&
        forcedColorsRing.outlineWidth >= 2,
      'G1_CART_FORCED_COLORS_QUANTITY_RING_MISSING',
    );
    await assertResponsiveSurface(page);
    expect(failureController.controlled503Count).toBeGreaterThanOrEqual(2);
    expect(networkIssues, 'G1_CART_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertG1CartMaximumBoundary(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  await seedG1SessionStorage(context, [
    {
      key: CART_STORAGE_KEY,
      value: JSON.stringify({
        items: [{ menuItemId: CART_IMAGE_ITEM_ID, quantity: 98 }],
        version: 1,
      }),
    },
  ]);
  const page = await context.newPage();
  const quoteRequests: SyntheticCartQuoteItem[][] = [];
  const networkIssues: string[] = [];
  const guard = new BrowserSafetyGuard(page, []);
  await installSyntheticCartRouting(page, quoteRequests, networkIssues);

  try {
    const initialResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.goto('/cart');
    await assertResponseStatus(
      initialResponse,
      200,
      'G1_CART_MAX_INITIAL_QUOTE_MISMATCH',
    );
    const quantityControl = page.getByRole('group', {
      exact: true,
      name: `Quantity for ${MENU_ITEM_NAME}`,
    });
    const value = quantityControl.getByLabel(`${MENU_ITEM_NAME} quantity`, {
      exact: true,
    });
    const decrement = quantityControl.getByRole('button', {
      exact: true,
      name: `Decrease quantity for ${MENU_ITEM_NAME}`,
    });
    const increment = quantityControl.getByRole('button', {
      exact: true,
      name: `Increase quantity for ${MENU_ITEM_NAME}`,
    });
    await expect(value).toHaveText('98');
    await increment.focus();
    await assertG1ContainedQuantityFocusRing(quantityControl, increment);
    const boundaryQuote = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.keyboard.press('Enter');
    await expect(value).toHaveText('99');
    await expect(decrement).toBeFocused();
    await assertG1ContainedQuantityFocusRing(quantityControl, decrement);
    await expect(increment).toBeDisabled();
    await assertResponseStatus(boundaryQuote, 200, 'G1_CART_MAXIMUM_QUOTE_MISMATCH');
    await assertResponsiveSurface(page);
    expect(networkIssues, 'G1_CART_MAX_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

function computedColorChannels(value: string, code: string): readonly number[] {
  const channels = value.match(/[0-9.]+/gu)?.map(Number) ?? [];
  safeInvariant(
    channels.length >= 3 &&
      channels.slice(0, 3).every((channel) => Number.isFinite(channel)),
    code,
  );
  return channels.slice(0, 3);
}

function relativeLuminance(channels: readonly number[]): number {
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
  );
}

async function assertG2TextContrast(
  locator: Locator,
  code: string,
  minimumRatio = 4.5,
): Promise<void> {
  await expect(locator).toBeVisible();
  const colors = await locator.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const foreground = runtime.getComputedStyle(
      element as unknown as RuntimeElement,
    ).color;
    let background = 'rgb(255, 255, 255)';
    let candidate: RuntimeElement | null = element as unknown as RuntimeElement;
    while (candidate !== null) {
      const value = runtime.getComputedStyle(candidate).backgroundColor;
      const channels = value.match(/[0-9.]+/gu)?.map(Number) ?? [];
      if (channels.length === 3 || (channels.length >= 4 && channels[3] === 1)) {
        background = value;
        break;
      }
      candidate = candidate.parentElement;
    }
    return { background, foreground };
  });
  const foregroundLuminance = relativeLuminance(
    computedColorChannels(colors.foreground, `${code}_FOREGROUND_INVALID`),
  );
  const backgroundLuminance = relativeLuminance(
    computedColorChannels(colors.background, `${code}_BACKGROUND_INVALID`),
  );
  const ratio =
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  safeInvariant(ratio >= minimumRatio, code);
}

async function assertG2AdminShellBasics(page: Page): Promise<void> {
  const main = page.locator('#admin-main-content');
  await expect(main).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole('navigation', { name: 'Administrator navigation' }),
  ).toBeVisible();
  const shellControls = page
    .locator('header a, header button')
    .or(
      page
        .getByRole('navigation', { name: 'Administrator navigation' })
        .getByRole('link'),
    );
  for (let index = 0; index < (await shellControls.count()); index += 1) {
    const control = shellControls.nth(index);
    if (await control.isVisible()) {
      await assertMinimumTouchTarget(control, 'G2_ADMIN_SHELL_TARGET_TOO_SMALL');
    }
  }
  await assertResponsiveSurface(page);
}

async function assertG2AdminDetailAndNotFoundMatrix(browser: Browser): Promise<void> {
  const storedSession = JSON.stringify({
    accessToken: ADMIN_ORDERS_TOKEN,
    version: 1,
  });
  for (const viewport of G2_ADMIN_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      forcedColors: viewport.width === 430 ? 'active' : 'none',
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await seedG1SessionStorage(context, [
      { key: ACCOUNT_AUTH_STORAGE_KEY, value: storedSession },
    ]);
    const page = await context.newPage();
    const controller: SyntheticAdminOrdersController = {
      detailFailuresRemaining: 0,
      emptyDefault: false,
      malformedNext: false,
      nextDetailResponseGate: null,
      nextPageGate: null,
      networkIssues: [],
      requests: [],
    };
    const guard = new BrowserSafetyGuard(page, [
      ADMIN_ORDERS_EMAIL,
      ADMIN_ORDERS_TOKEN,
    ]);
    await installSyntheticAdminOrdersRouting(page, controller);
    try {
      const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
      const detailResponse = waitForApiResponse(
        page,
        'GET',
        ADMIN_ORDER_DETAIL_API_PATH,
      );
      await page.goto(`/admin/orders/${ADMIN_ORDER_DETAIL_NUMBER}`);
      await Promise.all([
        assertResponseStatus(
          currentUserResponse,
          200,
          'G2_ADMIN_DETAIL_CURRENT_USER_STATUS_MISMATCH',
        ),
        assertResponseStatus(detailResponse, 200, 'G2_ADMIN_DETAIL_STATUS_MISMATCH'),
      ]);
      await expect(
        page.getByRole('heading', {
          exact: true,
          level: 1,
          name: `Order ${ADMIN_ORDER_DETAIL_NUMBER}`,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { exact: true, level: 2, name: 'Order items' }),
      ).toBeVisible();
      const itemName = page.getByRole('heading', {
        exact: true,
        level: 3,
        name: ADMIN_ORDER_DETAIL_ITEM_NAME,
      });
      await assertLongTextWraps(itemName);
      await expect(page.getByText('Preparing', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible();
      const backLink = page.getByRole('link', {
        exact: true,
        name: 'Back to Orders',
      });
      const refreshButton = page.getByRole('button', {
        exact: true,
        name: 'Refresh',
      });
      await assertMinimumTouchTarget(backLink, 'G2_ADMIN_DETAIL_BACK_TARGET_TOO_SMALL');
      await assertMinimumTouchTarget(
        refreshButton,
        'G2_ADMIN_DETAIL_REFRESH_TARGET_TOO_SMALL',
      );
      await assertLongTextWraps(
        page.locator('header').getByText(ADMIN_ORDERS_EMAIL, { exact: true }),
      );
      await assertG2AdminShellBasics(page);
      await assertReducedMotionContract(page, [
        page.locator('#admin-main-content > article'),
        backLink,
        refreshButton,
      ]);
      const forcedColorsActive = await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return runtime.matchMedia('(forced-colors: active)').matches;
      });
      expect(forcedColorsActive).toBe(viewport.width === 430);
      if (viewport.width === 375) {
        await assertG2TextContrast(
          page.getByRole('heading', { level: 1 }),
          'G2_ADMIN_DETAIL_HEADING_CONTRAST_TOO_LOW',
        );
        await assertG2TextContrast(
          page
            .getByRole('navigation', { name: 'Administrator navigation' })
            .getByRole('link', { exact: true, name: 'Orders' }),
          'G2_ADMIN_NAV_CONTRAST_TOO_LOW',
        );
      }

      await blurActiveElement(page);
      const skipLink = page.getByRole('link', {
        name: 'Skip to administrator content',
      });
      await page.keyboard.press('Tab');
      await assertVisibleKeyboardFocus(skipLink);
      await page.keyboard.press('Enter');
      await expect(page.locator('#admin-main-content')).toBeFocused();

      const notFoundCurrentUser = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
      await page.goto('/admin/g2-long-unknown-destination-that-must-wrap-safely');
      await assertResponseStatus(
        notFoundCurrentUser,
        200,
        'G2_ADMIN_NOT_FOUND_CURRENT_USER_STATUS_MISMATCH',
      );
      await expect(
        page.getByRole('heading', {
          exact: true,
          level: 1,
          name: 'Administrator page not found',
        }),
      ).toBeVisible();
      const backHome = page.getByRole('link', {
        exact: true,
        name: 'Back to admin home',
      });
      await assertMinimumTouchTarget(backHome, 'G2_ADMIN_NOT_FOUND_TARGET_TOO_SMALL');
      await assertG2AdminShellBasics(page);
      expect(controller.networkIssues, 'G2_ADMIN_MATRIX_NETWORK_FAILURE').toEqual([]);
      for (const request of controller.requests) {
        expect(request.authorization).toBe(`Bearer ${ADMIN_ORDERS_TOKEN}`);
        expect(request.capability).toBeNull();
        expect(request.postData).toBeNull();
      }
    } finally {
      try {
        guard.assertClean();
      } finally {
        await closeContext(context);
      }
    }
  }
}

async function assertG2AdminGuardFocusRecovery(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    forcedColors: 'active',
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(context, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ADMIN_ORDERS_TOKEN, version: 1 }),
    },
  ]);
  const page = await context.newPage();
  const networkIssues: string[] = [];
  let responseGate: Promise<void> | null = null;
  let successfulRecovery = false;
  const guard = new BrowserSafetyGuard(
    page,
    [ADMIN_ORDERS_TOKEN],
    [],
    [{ method: 'GET', pathname: AUTH_ME_API_PATH, status: 503 }],
  );
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('g2-admin-guard-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (request.method() === 'GET' && parsed.pathname === AUTH_ME_API_PATH) {
      const gate = responseGate;
      responseGate = null;
      if (gate !== null) await gate;
      if (successfulRecovery) {
        await route.fulfill({
          body: JSON.stringify({
            email: ADMIN_USERS_CURRENT_EMAIL,
            id: ADMIN_USERS_CURRENT_ID,
            is_active: true,
            role: 'super_admin',
          }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      await route.fulfill({
        body: JSON.stringify({ detail: 'Private synthetic session failure' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      parsed.pathname === ADMIN_USERS_API_PATH &&
      parsed.search === '?limit=50&offset=0'
    ) {
      await route.fulfill({
        body: JSON.stringify({ items: [], limit: 50, offset: 0, total: 0 }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push(
        `g2-admin-guard-unexpected-api:${request.method()}:${parsed.pathname}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });
  try {
    const initialFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    await page.goto('/admin/users');
    await assertResponseStatus(
      initialFailure,
      503,
      'G2_ADMIN_GUARD_INITIAL_FAILURE_STATUS_MISMATCH',
    );
    const retryButton = page.getByRole('button', {
      exact: true,
      name: 'Retry validation',
    });
    await assertMinimumTouchTarget(
      retryButton,
      'G2_ADMIN_GUARD_RETRY_TARGET_TOO_SMALL',
    );
    await assertMinimumTouchTarget(
      page.getByRole('button', { exact: true, name: 'Log out' }),
      'G2_ADMIN_GUARD_LOGOUT_TARGET_TOO_SMALL',
    );
    await retryButton.focus();
    await assertVisibleKeyboardFocus(retryButton);
    let releaseRetry = (): void => undefined;
    responseGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const repeatedFailure = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { exact: true, name: 'Checking your session' }),
    ).toBeVisible();
    const checkingMain = page.getByRole('main');
    await expect(checkingMain).toHaveAttribute('tabindex', '-1');
    await expect(checkingMain).toBeFocused();
    releaseRetry();
    await assertResponseStatus(
      repeatedFailure,
      503,
      'G2_ADMIN_GUARD_REPEATED_FAILURE_STATUS_MISMATCH',
    );
    const restoredRetry = page.getByRole('button', {
      exact: true,
      name: 'Retry validation',
    });
    await expect(restoredRetry).toBeFocused();
    await assertVisibleKeyboardFocus(restoredRetry);
    successfulRecovery = true;
    const recoveryResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    const usersResponse = waitForApiResponse(page, 'GET', ADMIN_USERS_API_PATH);
    await page.keyboard.press('Enter');
    await Promise.all([
      assertResponseStatus(
        recoveryResponse,
        200,
        'G2_ADMIN_GUARD_RECOVERY_STATUS_MISMATCH',
      ),
      assertResponseStatus(usersResponse, 200, 'G2_ADMIN_GUARD_USERS_STATUS_MISMATCH'),
    ]);
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Users' }),
    ).toBeVisible();
    await expect(page.locator('#admin-main-content')).toBeFocused();
    await assertResponsiveSurface(page);
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return runtime.matchMedia('(forced-colors: active)').matches;
      }),
    ).toBe(true);
    expect(networkIssues, 'G2_ADMIN_GUARD_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function assertG2AdminDetailFocusRecovery(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(context, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ADMIN_ORDERS_TOKEN, version: 1 }),
    },
  ]);
  const page = await context.newPage();
  const controller: SyntheticAdminOrdersController = {
    detailFailuresRemaining: 2,
    emptyDefault: false,
    malformedNext: false,
    nextDetailResponseGate: null,
    nextPageGate: null,
    networkIssues: [],
    requests: [],
  };
  const guard = new BrowserSafetyGuard(
    page,
    [ADMIN_ORDERS_TOKEN],
    [],
    [{ method: 'GET', pathname: ADMIN_ORDER_DETAIL_API_PATH, status: 503 }],
  );
  await installSyntheticAdminOrdersRouting(page, controller);
  try {
    const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    const initialFailure = waitForApiResponse(page, 'GET', ADMIN_ORDER_DETAIL_API_PATH);
    await page.goto(`/admin/orders/${ADMIN_ORDER_DETAIL_NUMBER}`);
    await Promise.all([
      assertResponseStatus(
        currentUserResponse,
        200,
        'G2_ADMIN_DETAIL_FOCUS_CURRENT_USER_STATUS_MISMATCH',
      ),
      assertResponseStatus(
        initialFailure,
        503,
        'G2_ADMIN_DETAIL_INITIAL_FAILURE_STATUS_MISMATCH',
      ),
    ]);
    let retryButton = page.getByRole('button', {
      exact: true,
      name: 'Retry order',
    });
    await retryButton.focus();
    await assertVisibleKeyboardFocus(retryButton);
    const repeatedFailure = waitForApiResponse(
      page,
      'GET',
      ADMIN_ORDER_DETAIL_API_PATH,
    );
    await page.keyboard.press('Enter');
    await assertResponseStatus(
      repeatedFailure,
      503,
      'G2_ADMIN_DETAIL_REPEATED_FAILURE_STATUS_MISMATCH',
    );
    const errorHeading = page.getByRole('heading', {
      exact: true,
      level: 2,
      name: 'Unable to load order',
    });
    await expect(errorHeading).toBeFocused();
    await assertVisibleKeyboardFocus(errorHeading);

    retryButton = page.getByRole('button', {
      exact: true,
      name: 'Retry order',
    });
    let releaseRecovery = (): void => undefined;
    controller.nextDetailResponseGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoveryResponse = waitForApiResponse(
      page,
      'GET',
      ADMIN_ORDER_DETAIL_API_PATH,
    );
    const movedFocusTarget = page
      .getByRole('navigation', { name: 'Administrator navigation' })
      .getByRole('link', { exact: true, name: 'Admin home' });
    try {
      await retryButton.click();
      await expect(
        page.getByRole('heading', { exact: true, level: 2, name: 'Loading order' }),
      ).toBeVisible();
      await movedFocusTarget.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await assertVisibleKeyboardFocus(movedFocusTarget);
    } finally {
      releaseRecovery();
    }
    await assertResponseStatus(
      recoveryResponse,
      200,
      'G2_ADMIN_DETAIL_RECOVERY_STATUS_MISMATCH',
    );
    await expect(
      page.getByRole('heading', { exact: true, level: 2, name: 'Order summary' }),
    ).toBeVisible();
    await expect(movedFocusTarget).toBeFocused();
    expect(controller.networkIssues, 'G2_ADMIN_DETAIL_FOCUS_NETWORK_FAILURE').toEqual(
      [],
    );
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
}

async function closeContext(context: BrowserContext): Promise<void> {
  let cleanupFailed = false;
  try {
    await context.close();
  } catch (error: unknown) {
    void error;
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    throw new Error('E2E_CONTEXT_CLEANUP_FAILED');
  }
}

async function assertG3DecorativeShellBrand(
  page: Page,
  accessibleName: string,
  size: 24 | 32,
): Promise<void> {
  const brandLink = page
    .getByRole('banner')
    .getByRole('link', { exact: true, name: accessibleName });
  const brandMark = brandLink.locator('svg');
  await expect(brandLink).toHaveCount(1);
  await expect(brandLink.getByText('Nordic Hearth', { exact: true })).toHaveCount(1);
  await expect(brandMark).toHaveCount(1);
  await expect(brandMark).toHaveAttribute('aria-hidden', 'true');
  await expect(brandMark).toHaveAttribute('focusable', 'false');
  await expect(brandMark).toHaveAttribute('height', String(size));
  await expect(brandMark).toHaveAttribute('stroke', 'currentColor');
  await expect(brandMark).toHaveAttribute('width', String(size));
  await expect(brandLink.getByRole('img')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test('keeps Stage 21-G1 customer recovery controls focused and operable', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  await assertG1MenuAndShellRecovery(browser);
  await assertG1CartQuoteAndMinimumBoundary(browser);
  await assertG1CartMaximumBoundary(browser);
  await assertG1RouteGuardRecovery(browser);
  await assertStandaloneAuthRouteFocus(browser);
  await assertStandaloneAuthSessionRetryFocus(browser);
});

test('keeps every customer route responsive and accessible across the G1 matrix', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await assertG1CustomerRouteMatrix(browser);
});

test('keeps the isolated cart story responsive, focused, and locally quoted', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const cartStorageValue = JSON.stringify({
    items: [
      { menuItemId: CART_IMAGE_ITEM_ID, quantity: 1 },
      { menuItemId: CART_FALLBACK_ITEM_ID, quantity: 1 },
    ],
    version: 1,
  });

  for (const viewport of CART_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: CART_STORAGE_KEY, storageValue: cartStorageValue },
    );
    const page = await context.newPage();
    const guard = new BrowserSafetyGuard(page, []);
    const quoteRequests: SyntheticCartQuoteItem[][] = [];
    const networkIssues: string[] = [];
    page.on('requestfailed', (request) => {
      const parsed = parseUrl(request.url());
      if (parsed !== null && parsed.origin === baseOrigin) {
        networkIssues.push('local-request-failed');
      }
    });
    await installSyntheticCartRouting(page, quoteRequests, networkIssues);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertCartViewport(page, viewport, quoteRequests);
      expect(networkIssues, 'CART_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
  await assertCartDelayedValidationFocus(browser);
});

test('keeps checkout initiation responsive, recoverable, and provider-isolated', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const accessStorageValue = JSON.stringify({
    publicOrderNumber: CHECKOUT_PUBLIC_ORDER_NUMBER,
    token: CHECKOUT_CAPABILITY,
    version: 1,
  });
  const attemptStorageValue = JSON.stringify({
    idempotencyKey: CHECKOUT_ATTEMPT_ID,
    publicOrderNumber: CHECKOUT_PUBLIC_ORDER_NUMBER,
    version: 1,
  });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ accessKey, accessValue, attemptKey, attemptValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(accessKey, accessValue);
          runtime.sessionStorage.setItem(attemptKey, attemptValue);
        }
      },
      {
        accessKey: CHECKOUT_ACCESS_STORAGE_KEY,
        accessValue: accessStorageValue,
        attemptKey: CHECKOUT_ATTEMPT_STORAGE_KEY,
        attemptValue: attemptStorageValue,
      },
    );
    const page = await context.newPage();
    const trace: SyntheticCheckoutTrace = {
      checkoutRequests: [],
      networkIssues: [],
      observedLocalRequests: [],
      orderRequests: [],
      providerRequests: [],
    };
    let resolveFirstResponse: (() => void) | null = null;
    const firstCheckoutResponseGate = new Promise<void>((resolve) => {
      resolveFirstResponse = () => resolve();
    });
    const releaseFirstCheckoutResponse = (): void => {
      resolveFirstResponse?.();
      resolveFirstResponse = null;
    };
    const guard = new BrowserSafetyGuard(
      page,
      [CHECKOUT_CAPABILITY, CHECKOUT_ATTEMPT_ID],
      [
        { method: 'POST', pathname: CHECKOUT_SESSION_API_PATH },
        { method: 'GET', pathname: CHECKOUT_PROVIDER_PATH },
      ],
    );
    page.on('requestfailed', (request) => {
      const parsed = parseUrl(request.url());
      trace.networkIssues.push(
        parsed !== null && parsed.origin === baseOrigin
          ? `local-request-failed:${request.method()}:${parsed.pathname}`
          : 'external-request-failed',
      );
    });
    await installSyntheticCheckoutRouting(page, trace, firstCheckoutResponseGate);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertCheckoutViewport(page, viewport, trace, releaseFirstCheckoutResponse);
      expect(trace.networkIssues, 'CHECKOUT_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      releaseFirstCheckoutResponse();
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps order status authoritative, recoverable, and accessible across customer viewports', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const accessStorageValue = JSON.stringify({
    publicOrderNumber: ORDER_STATUS_PUBLIC_ORDER_NUMBER,
    token: ORDER_STATUS_CAPABILITY,
    version: 1,
  });

  for (const viewport of ORDER_STATUS_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      {
        storageKey: ORDER_STATUS_ACCESS_STORAGE_KEY,
        storageValue: accessStorageValue,
      },
    );
    const page = await context.newPage();
    const controller: SyntheticOrderStatusController = {
      controlled503Count: 0,
      failNext: false,
      networkIssues: [],
      requests: [],
      status: 'preparing',
    };
    const guard = new BrowserSafetyGuard(
      page,
      [ORDER_STATUS_CAPABILITY],
      [],
      [{ method: 'GET', pathname: ORDER_STATUS_API_PATH, status: 503 }],
    );
    await installSyntheticOrderStatusRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertOrderStatusViewport(page, viewport, controller);
      expect(
        controller.controlled503Count,
        'ORDER_STATUS_CONTROLLED_503_COUNT_MISMATCH',
      ).toBe(2);
      expect(
        controller.networkIssues,
        'ORDER_STATUS_SYNTHETIC_NETWORK_FAILURE',
      ).toEqual([]);
      expect(controller.requests.length).toBeGreaterThanOrEqual(4);
      for (const request of controller.requests) {
        expect(request).toEqual({
          authorization: null,
          capability: ORDER_STATUS_CAPABILITY,
          method: 'GET',
          postData: null,
        });
      }
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps payment return and cancellation neutral across customer viewports', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const accessStorageValue = JSON.stringify({
    publicOrderNumber: CHECKOUT_PUBLIC_ORDER_NUMBER,
    token: CHECKOUT_CAPABILITY,
    version: 1,
  });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      {
        storageKey: CHECKOUT_ACCESS_STORAGE_KEY,
        storageValue: accessStorageValue,
      },
    );
    const page = await context.newPage();
    const guard = new BrowserSafetyGuard(page, [CHECKOUT_CAPABILITY]);
    const networkIssues: string[] = [];
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        networkIssues.push('neutral-state-external-websocket');
      }
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const parsed = parseUrl(request.url());
      if (parsed === null) {
        networkIssues.push('neutral-state-invalid-url');
        await route.abort();
        return;
      }
      if (parsed.origin !== baseOrigin) {
        networkIssues.push(`neutral-state-external-request:${parsed.hostname}`);
        await route.abort();
        return;
      }
      if (parsed.pathname.startsWith('/api/')) {
        networkIssues.push(
          `neutral-state-unexpected-api:${request.method()}:${parsed.pathname}`,
        );
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected neutral-state API request' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.continue();
    });

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      for (const expectation of NEUTRAL_PAYMENT_PAGES) {
        await assertNeutralPaymentStatePage(page, viewport, expectation);
      }
      await waitForSettledLayout(page);
      expect(networkIssues, 'NEUTRAL_STATE_NETWORK_BOUNDARY_FAILURE').toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps authentication branded, recoverable, and isolated across customer viewports', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  for (const viewport of AUTH_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    const page = await context.newPage();
    const controller: SyntheticAuthController = {
      controlled401Count: 0,
      loginRequests: [],
      menuRequestCount: 0,
      meAuthorizations: [],
      networkIssues: [],
      registrationRequestCount: 0,
    };
    let resolveFirstLoginResponse: (() => void) | null = null;
    const firstLoginResponseGate = new Promise<void>((resolve) => {
      resolveFirstLoginResponse = () => resolve();
    });
    const releaseFirstLoginResponse = (): void => {
      resolveFirstLoginResponse?.();
      resolveFirstLoginResponse = null;
    };
    const guard = new BrowserSafetyGuard(
      page,
      [AUTH_EMAIL, AUTH_PASSWORD, AUTH_TOKEN],
      [],
      [
        { method: 'POST', pathname: AUTH_LOGIN_API_PATH, status: 401 },
        { method: 'POST', pathname: AUTH_REGISTER_API_PATH, status: 503 },
      ],
      [
        {
          errorText: 'net::ERR_ABORTED',
          maximumOccurrences: 1,
          method: 'GET',
          pathname: AUTH_MENU_API_PATH,
          resourceType: 'fetch',
        },
      ],
    );
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('auth-external-websocket');
      }
    });
    await installSyntheticAuthRouting(page, controller, firstLoginResponseGate);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAuthViewport(page, viewport, controller, releaseFirstLoginResponse);
      safeInvariant(
        controller.controlled401Count === 1,
        'AUTH_CONTROLLED_401_COUNT_MISMATCH',
      );
      expect(controller.networkIssues, 'AUTH_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      releaseFirstLoginResponse();
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps account orders branded, authoritative, and isolated across customer viewports', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const storedSession = JSON.stringify({
    accessToken: ACCOUNT_TOKEN,
    version: 1,
  });

  for (const viewport of ACCOUNT_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    let resolveRetryResponse: (() => void) | null = null;
    const retryResponseGate = new Promise<void>((resolve) => {
      resolveRetryResponse = () => resolve();
    });
    const releaseRetryResponse = (): void => {
      resolveRetryResponse?.();
      resolveRetryResponse = null;
    };
    const controller: SyntheticAccountController = {
      meAuthorizations: [],
      mode: 'error',
      networkIssues: [],
      orderRequests: [],
      retryResponseGate,
    };
    const guard = new BrowserSafetyGuard(page, [ACCOUNT_EMAIL, ACCOUNT_TOKEN]);
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('account-external-websocket');
      }
    });
    await installSyntheticAccountRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAccountViewport(page, viewport, controller, releaseRetryResponse);
      expect(controller.networkIssues, 'ACCOUNT_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      releaseRetryResponse();
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps account order detail authoritative, focused, and isolated across customer viewports', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const storedSession = JSON.stringify({
    accessToken: ACCOUNT_TOKEN,
    version: 1,
  });

  for (const viewport of ACCOUNT_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAccountDetailController = {
      detailRequests: [],
      meAuthorizations: [],
      networkIssues: [],
      retryResponseGate: null,
      retryRequestCount: 0,
    };
    const guard = new BrowserSafetyGuard(
      page,
      [ACCOUNT_EMAIL, ACCOUNT_TOKEN],
      [],
      [
        {
          method: 'GET',
          pathname: accountDetailApiPath(ACCOUNT_DETAIL_ACCESS_ORDER_NUMBER),
          status: 404,
        },
        {
          method: 'GET',
          pathname: accountDetailApiPath(ACCOUNT_DETAIL_RETRY_ORDER_NUMBER),
          status: 503,
        },
      ],
    );
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('account-detail-external-websocket');
      }
    });
    await installSyntheticAccountDetailRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAccountDetailViewport(page, viewport, controller);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps the admin home operational, truthful, and isolated across all dashboard viewports', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_HOME_TOKEN,
    version: 1,
  });

  for (const viewport of ADMIN_HOME_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminHomeController = {
      menuFailuresRemaining: 0,
      menuRequestCount: 0,
      mode: 'healthy',
      networkIssues: [],
      nextMenuResponseGate: null,
      requests: [],
    };
    const guard = new BrowserSafetyGuard(page, [ADMIN_HOME_EMAIL, ADMIN_HOME_TOKEN]);
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-home-external-websocket');
      }
    });
    await installSyntheticAdminHomeRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminHomeViewport(page, viewport, controller);
      expect(controller.networkIssues, 'ADMIN_HOME_SYNTHETIC_NETWORK_FAILURE').toEqual(
        [],
      );
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps admin analytics authoritative, responsive, and isolated across all reporting viewports', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_ANALYTICS_TOKEN,
    version: 1,
  });

  for (const viewport of ADMIN_ANALYTICS_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminAnalyticsController = {
      mode: 'healthy-multi',
      networkIssues: [],
      nextBatchResponseGate: null,
      requests: [],
    };
    const guard = new BrowserSafetyGuard(page, [
      ADMIN_ANALYTICS_EMAIL,
      ADMIN_ANALYTICS_TOKEN,
      ADMIN_ANALYTICS_PRIVATE_RESPONSE_COPY,
    ]);
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-analytics-external-websocket');
      }
    });
    await installSyntheticAdminAnalyticsRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminAnalyticsViewport(page, viewport, controller);
      expect(
        controller.networkIssues,
        'ADMIN_ANALYTICS_SYNTHETIC_NETWORK_FAILURE',
      ).toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps admin exports download-safe, responsive, and independently actionable across all viewports', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_EXPORTS_TOKEN,
    version: 1,
  });
  const productErrorSearch = syntheticAdminExportsSearch(
    'product-sales',
    ADMIN_EXPORTS_SECONDARY_RANGE,
    'USD',
  );
  const paymentsErrorSearch = syntheticAdminExportsSearch(
    'payments',
    ADMIN_EXPORTS_SECONDARY_RANGE,
    'USD',
  );
  const ordersErrorSearch = syntheticAdminExportsSearch(
    'orders',
    ADMIN_EXPORTS_SECONDARY_RANGE,
    'USD',
    'completed',
    'takeaway',
  );

  for (const viewport of ADMIN_EXPORTS_VIEWPORTS) {
    const context = await browser.newContext({
      acceptDownloads: true,
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminExportsController = {
      modes: {
        orders: 'valid-safe',
        payments: 'valid-safe',
        'product-sales': 'valid-safe',
      },
      networkIssues: [],
      requests: [],
      responseGates: {},
    };
    const guard = new BrowserSafetyGuard(
      page,
      [ADMIN_EXPORTS_EMAIL, ADMIN_EXPORTS_TOKEN, ADMIN_EXPORTS_PRIVATE_RESPONSE_COPY],
      [],
      [
        {
          method: 'GET',
          pathname: `${ADMIN_EXPORTS_API_ROOT}/product-sales.csv`,
          search: productErrorSearch,
          status: 422,
        },
        {
          method: 'GET',
          pathname: `${ADMIN_EXPORTS_API_ROOT}/payments.csv`,
          search: paymentsErrorSearch,
          status: 503,
        },
        {
          method: 'GET',
          pathname: `${ADMIN_EXPORTS_API_ROOT}/orders.csv`,
          search: ordersErrorSearch,
          status: 403,
        },
      ],
    );
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-exports-external-websocket');
      }
    });
    await installSyntheticAdminExportsRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminExportsViewport(page, viewport, controller);
      expect(
        controller.networkIssues,
        'ADMIN_EXPORTS_SYNTHETIC_NETWORK_FAILURE',
      ).toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps admin users authoritative, privilege-safe, and isolated across all viewports', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_USERS_TOKEN,
    version: 1,
  });

  for (const viewport of ADMIN_USERS_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminUsersController = {
      authoritativeCustomerRole: 'customer',
      failNextPatchStatus: null,
      mode: 'healthy',
      networkIssues: [],
      nextUsersResponseGate: null,
      patchResponseGate: null,
      requests: [],
    };
    const adminRolePath = adminUsersRolePath(ADMIN_USERS_ADMIN_ID);
    const guard = new BrowserSafetyGuard(
      page,
      [ADMIN_USERS_TOKEN],
      [],
      [
        { method: 'PATCH', pathname: adminRolePath, status: 403 },
        { method: 'PATCH', pathname: adminRolePath, status: 409 },
        { method: 'PATCH', pathname: adminRolePath, status: 422 },
      ],
    );
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-users-external-websocket');
      }
    });
    await installSyntheticAdminUsersRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminUsersViewport(page, viewport, controller);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps admin menu money exact, operational, and isolated across all viewports', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_MENU_TOKEN,
    version: 1,
  });

  for (const viewport of ADMIN_MENU_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminMenuController = {
      authoritativeCostAmount: 4_500,
      authoritativePriceAmount: 9_900,
      categoryMode: 'healthy',
      failNextPatch: false,
      itemMode: 'healthy',
      networkIssues: [],
      requests: [],
      saveResponseGate: null,
    };
    const guard = new BrowserSafetyGuard(
      page,
      [ADMIN_MENU_EMAIL, ADMIN_MENU_TOKEN],
      [],
      [
        {
          method: 'PATCH',
          pathname: ADMIN_MENU_ITEMS_API_PATH + '/' + ADMIN_MENU_PRIMARY_ITEM_ID,
          status: 409,
        },
      ],
    );
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-menu-external-websocket');
      }
    });
    await installSyntheticAdminMenuRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminMenuViewport(page, viewport, controller);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps admin orders operational, authoritative, and isolated across all overview viewports', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const storedSession = JSON.stringify({
    accessToken: ADMIN_ORDERS_TOKEN,
    version: 1,
  });

  for (const viewport of ADMIN_ORDERS_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: 'no-preference',
      viewport: { height: viewport.height, width: viewport.width },
    });
    await context.addInitScript(
      ({ storageKey, storageValue }) => {
        const runtime = globalThis as typeof globalThis & {
          location: { protocol: string };
          sessionStorage: { setItem: (key: string, value: string) => void };
        };
        if (
          runtime.location.protocol === 'http:' ||
          runtime.location.protocol === 'https:'
        ) {
          runtime.sessionStorage.setItem(storageKey, storageValue);
        }
      },
      { storageKey: ACCOUNT_AUTH_STORAGE_KEY, storageValue: storedSession },
    );
    const page = await context.newPage();
    const controller: SyntheticAdminOrdersController = {
      detailFailuresRemaining: 0,
      emptyDefault: false,
      malformedNext: false,
      nextDetailResponseGate: null,
      nextPageGate: null,
      networkIssues: [],
      requests: [],
    };
    const guard = new BrowserSafetyGuard(page, [
      ADMIN_ORDERS_EMAIL,
      ADMIN_ORDERS_TOKEN,
      ADMIN_ORDERS_PRIVATE_COPY,
    ]);
    const expectedBaseUrl = new URL(baseOrigin);
    page.on('websocket', (socket) => {
      const parsed = parseUrl(socket.url());
      if (
        parsed === null ||
        parsed.hostname !== expectedBaseUrl.hostname ||
        parsed.port !== expectedBaseUrl.port
      ) {
        controller.networkIssues.push('admin-orders-external-websocket');
      }
    });
    await installSyntheticAdminOrdersRouting(page, controller);

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertAdminOrdersViewport(page, viewport, controller);
      expect(
        controller.networkIssues,
        'ADMIN_ORDERS_SYNTHETIC_NETWORK_FAILURE',
      ).toEqual([]);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps G2 admin detail recovery focus predictable without stealing it', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  await assertG2AdminGuardFocusRecovery(browser);
  await assertG2AdminDetailFocusRecovery(browser);
});

test('keeps admin detail, not-found, and shell accessible across the G2 matrix', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  await assertG2AdminDetailAndNotFoundMatrix(browser);
});

test('keeps the landing brand story responsive, focused, and locally imaged', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  for (const viewport of LANDING_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: baseOrigin,
      forcedColors: 'active',
      reducedMotion: 'reduce',
      viewport: { height: viewport.height, width: viewport.width },
    });
    const page = await context.newPage();
    const guard = new BrowserSafetyGuard(page, []);

    await page.route('**/*', async (route) => {
      const request = route.request();
      const parsed = parseUrl(request.url());
      if (parsed === null || parsed.origin !== baseOrigin) {
        await route.abort();
        return;
      }
      if (parsed.pathname === '/api/v1/menu' && request.method() === 'GET') {
        await route.fulfill({
          body: JSON.stringify({ categories: [] }),
          contentType: 'application/json',
          status: 200,
        });
        return;
      }
      if (parsed.pathname.startsWith('/api/')) {
        await route.fulfill({
          body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
          contentType: 'application/json',
          status: 500,
        });
        return;
      }
      await route.continue();
    });

    let scenarioError: unknown;
    let finalizationError: unknown;
    try {
      await assertLandingViewport(page, viewport);
    } catch (error: unknown) {
      scenarioError = error;
    } finally {
      try {
        guard.assertClean();
      } catch (error: unknown) {
        finalizationError = error;
      }
      try {
        await closeContext(context);
      } catch (error: unknown) {
        finalizationError ??= error;
      }
    }

    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
});

test('keeps G3 customer shell branding and keyboard navigation synthetic from menu to cart', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  const page = await context.newPage();
  const networkIssues: string[] = [];
  const quoteRequests: SyntheticCartQuoteItem[][] = [];
  const guard = new BrowserSafetyGuard(page, []);
  await installSyntheticCartRouting(page, quoteRequests, networkIssues);

  try {
    await page.goto('/');
    await expect(
      page.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeVisible();
    await assertG3DecorativeShellBrand(page, 'Nordic Hearth home', 32);

    const customerNavigation = page.getByRole('navigation', {
      name: 'Customer navigation',
    });
    const menuLink = customerNavigation.getByRole('link', {
      exact: true,
      name: 'Menu',
    });
    await blurActiveElement(page);
    await tabTo(page, menuLink, 24);
    await assertVisibleKeyboardFocus(menuLink);
    const menuResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    await page.keyboard.press('Enter');
    await assertResponseStatus(
      menuResponse,
      200,
      'G3_CUSTOMER_MENU_RESPONSE_STATUS_MISMATCH',
    );
    await assertLocation(page, '/menu');
    const customerMain = page.getByRole('main');
    await expect(
      customerMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Our menu',
      }),
    ).toBeVisible();
    await expect(customerMain).toBeFocused();

    const menuItem = page.getByRole('article', {
      exact: true,
      name: MENU_ITEM_NAME,
    });
    const addToCart = menuItem.getByRole('button', {
      exact: true,
      name: 'Add to cart',
    });
    await tabTo(page, addToCart, 64);
    await assertVisibleKeyboardFocus(addToCart);
    await page.keyboard.press('Enter');
    await expect(menuItem.getByText('1 in cart', { exact: true })).toBeVisible();
    const cartFeedback = menuItem.getByRole('status');
    await expect(cartFeedback).toHaveText(
      MENU_ITEM_NAME + ' added to cart. Quantity is 1.',
    );
    await page.keyboard.press('Enter');
    await expect(menuItem.getByText('2 in cart', { exact: true })).toBeVisible();
    await expect(cartFeedback).toHaveText(
      MENU_ITEM_NAME + ' added to cart. Quantity is 2.',
    );

    const cartLink = customerNavigation.getByRole('link', {
      exact: true,
      name: 'Cart',
    });
    await blurActiveElement(page);
    await tabTo(page, cartLink, 24);
    await assertVisibleKeyboardFocus(cartLink);
    const cartMenuResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    const quoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.keyboard.press('Enter');
    await Promise.all([
      assertResponseStatus(
        cartMenuResponse,
        200,
        'G3_CUSTOMER_CART_MENU_STATUS_MISMATCH',
      ),
      assertResponseStatus(quoteResponse, 200, 'G3_CUSTOMER_QUOTE_STATUS_MISMATCH'),
    ]);
    await assertLocation(page, '/cart');
    await expect(
      customerMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Your cart',
      }),
    ).toBeVisible();
    await expect(customerMain).toBeFocused();
    await expect(cartLineFor(page, MENU_ITEM_NAME)).toHaveCount(1);
    expect(quoteRequests).toEqual([
      [{ menu_item_id: CART_IMAGE_ITEM_ID, quantity: 2 }],
    ]);
    expect(networkIssues, 'G3_CUSTOMER_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
});

test('keeps G3 AppShell session-unavailable state announced by a synthetic response', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(context, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ACCOUNT_TOKEN, version: 1 }),
    },
  ]);
  const page = await context.newPage();
  const networkIssues: string[] = [];
  let releaseSessionResponse = (): void => undefined;
  const sessionResponseGate = new Promise<void>((resolve) => {
    releaseSessionResponse = resolve;
  });
  const guard = new BrowserSafetyGuard(
    page,
    [ACCOUNT_TOKEN],
    [],
    [{ method: 'GET', pathname: AUTH_ME_API_PATH, status: 503 }],
  );
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      networkIssues.push('g3-app-shell-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (
      parsed.pathname === AUTH_ME_API_PATH &&
      parsed.search === '' &&
      request.method() === 'GET'
    ) {
      await sessionResponseGate;
      await route.fulfill({
        body: JSON.stringify({ detail: 'Private synthetic session failure' }),
        contentType: 'application/json',
        status: 503,
      });
      return;
    }
    if (
      parsed.pathname === AUTH_MENU_API_PATH &&
      parsed.search === '' &&
      request.method() === 'GET'
    ) {
      await route.fulfill({
        body: JSON.stringify(SYNTHETIC_CART_MENU),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      networkIssues.push(
        `g3-app-shell-unexpected-api:${request.method()}:${parsed.pathname}${parsed.search}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });

  try {
    const currentUserResponse = waitForApiResponse(page, 'GET', AUTH_ME_API_PATH);
    const menuResponse = waitForApiResponse(page, 'GET', AUTH_MENU_API_PATH);
    await page.goto('/menu');
    await assertResponseStatus(menuResponse, 200, 'G3_APP_SHELL_MENU_STATUS_MISMATCH');
    const customerNavigation = page.getByRole('navigation', {
      name: 'Customer navigation',
    });
    await expect(
      customerNavigation.getByRole('status').filter({
        hasText: 'Checking session...',
      }),
    ).toHaveCount(1);
    releaseSessionResponse();
    await assertResponseStatus(
      currentUserResponse,
      503,
      'G3_APP_SHELL_SESSION_STATUS_MISMATCH',
    );
    await expect(
      customerNavigation.getByRole('status').filter({
        hasText: 'Session unavailable',
      }),
    ).toHaveCount(1);
    await expect(
      customerNavigation.getByText('Checking session...', { exact: true }),
    ).toHaveCount(0);
    await assertG3DecorativeShellBrand(page, 'Nordic Hearth home', 32);
    expect(networkIssues, 'G3_APP_SHELL_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    releaseSessionResponse();
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
});

test('keeps G3 order-status automatic polling authoritative and focus-stable', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const viewport = ORDER_STATUS_VIEWPORTS[0];
  const context = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'no-preference',
    viewport: { height: viewport.height, width: viewport.width },
  });
  await seedG1SessionStorage(context, [
    {
      key: ORDER_STATUS_ACCESS_STORAGE_KEY,
      value: JSON.stringify({
        publicOrderNumber: ORDER_STATUS_PUBLIC_ORDER_NUMBER,
        token: ORDER_STATUS_CAPABILITY,
        version: 1,
      }),
    },
  ]);
  const page = await context.newPage();
  await page.clock.install({ time: '2026-08-26T12:00:00Z' });
  const controller: SyntheticOrderStatusController = {
    controlled503Count: 0,
    failNext: false,
    networkIssues: [],
    requests: [],
    status: 'preparing',
  };
  const guard = new BrowserSafetyGuard(page, [ORDER_STATUS_CAPABILITY]);
  await installSyntheticOrderStatusRouting(page, controller);

  try {
    const initialResponse = waitForApiResponse(page, 'GET', ORDER_STATUS_API_PATH);
    await page.goto(ORDER_STATUS_ROUTE);
    await assertResponseStatus(
      initialResponse,
      200,
      'G3_ORDER_STATUS_INITIAL_STATUS_MISMATCH',
    );
    await assertOrderStatusPresentation(
      page,
      viewport,
      'preparing',
      'Preparing',
      'info',
    );
    const primaryAction = page.locator('[data-action-priority=primary]');
    await primaryAction.focus();
    await assertVisibleKeyboardFocus(primaryAction);

    controller.status = 'ready';
    const pollingResponse = waitForApiResponse(page, 'GET', ORDER_STATUS_API_PATH);
    await page.clock.fastForward(8_000);
    await assertResponseStatus(
      pollingResponse,
      200,
      'G3_ORDER_STATUS_POLL_STATUS_MISMATCH',
    );
    await assertOrderStatusPresentation(page, viewport, 'ready', 'Ready', 'info');
    await expect(primaryAction).toBeFocused();
    await expect(
      page.getByRole('status').filter({ hasText: 'Current status: Ready' }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('status').filter({ hasText: 'Current status: Preparing' }),
    ).toHaveCount(0);
    expect(controller.requests).toHaveLength(2);
    expect(
      controller.networkIssues,
      'G3_ORDER_STATUS_SYNTHETIC_NETWORK_FAILURE',
    ).toEqual([]);
  } finally {
    try {
      guard.assertClean();
    } finally {
      await closeContext(context);
    }
  }
});

test('keeps G3 admin shell current-route semantics and conflict recovery authoritative', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const homeContext = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  await seedG1SessionStorage(homeContext, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ADMIN_HOME_TOKEN, version: 1 }),
    },
  ]);
  const homePage = await homeContext.newPage();
  const homeController: SyntheticAdminHomeController = {
    menuFailuresRemaining: 0,
    menuRequestCount: 0,
    mode: 'healthy',
    networkIssues: [],
    nextMenuResponseGate: null,
    requests: [],
  };
  const homeGuard = new BrowserSafetyGuard(homePage, [ADMIN_HOME_TOKEN]);
  await installSyntheticAdminHomeRouting(homePage, homeController);

  try {
    const currentUserResponse = waitForApiResponse(homePage, 'GET', AUTH_ME_API_PATH);
    const ordersResponse = waitForApiResponse(
      homePage,
      'GET',
      ADMIN_HOME_ORDERS_API_PATH,
    );
    const menuResponse = waitForApiResponse(homePage, 'GET', ADMIN_HOME_MENU_API_PATH);
    const analyticsResponse = waitForApiResponse(
      homePage,
      'GET',
      ADMIN_HOME_ANALYTICS_API_PATH,
    );
    await homePage.goto('/admin');
    await Promise.all([
      assertResponseStatus(
        currentUserResponse,
        200,
        'G3_ADMIN_HOME_CURRENT_USER_STATUS_MISMATCH',
      ),
      assertResponseStatus(ordersResponse, 200, 'G3_ADMIN_HOME_ORDERS_STATUS_MISMATCH'),
      assertResponseStatus(menuResponse, 200, 'G3_ADMIN_HOME_MENU_STATUS_MISMATCH'),
      assertResponseStatus(
        analyticsResponse,
        200,
        'G3_ADMIN_HOME_ANALYTICS_STATUS_MISMATCH',
      ),
    ]);
    await expect(
      homePage.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Administrator workspace',
      }),
    ).toBeVisible();
    await assertG3DecorativeShellBrand(homePage, 'Nordic Hearth', 24);
    const homeNavigation = homePage.getByRole('navigation', {
      name: 'Administrator navigation',
    });
    await expect(homeNavigation.locator('[aria-current=page]')).toHaveCount(1);
    await expect(
      homeNavigation.getByRole('link', { exact: true, name: 'Admin home' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      homePage.getByRole('banner').getByRole('link', {
        exact: true,
        name: 'Nordic Hearth',
      }),
    ).not.toHaveAttribute('aria-current');
    expect(
      homeController.networkIssues,
      'G3_ADMIN_HOME_SYNTHETIC_NETWORK_FAILURE',
    ).toEqual([]);
  } finally {
    try {
      homeGuard.assertClean();
    } finally {
      await closeContext(homeContext);
    }
  }

  const detailContext = await browser.newContext({
    baseURL: baseOrigin,
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  await seedG1SessionStorage(detailContext, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ADMIN_ORDERS_TOKEN, version: 1 }),
    },
  ]);
  const detailPage = await detailContext.newPage();
  const detailController: SyntheticAdminOrdersController = {
    authoritativeDetailStatus: 'preparing',
    conflictNextStatusPatch: true,
    detailFailuresRemaining: 0,
    emptyDefault: false,
    malformedNext: false,
    nextDetailResponseGate: null,
    nextPageGate: null,
    nextStatusPatchResponseGate: null,
    networkIssues: [],
    requests: [],
  };
  const statusApiPath = `${ADMIN_ORDER_DETAIL_API_PATH}/status`;
  const detailGuard = new BrowserSafetyGuard(
    detailPage,
    [ADMIN_ORDERS_TOKEN, 'Private synthetic mutation conflict'],
    [],
    [{ method: 'PATCH', pathname: statusApiPath, status: 409 }],
  );
  await installSyntheticAdminOrdersRouting(detailPage, detailController);
  let releaseStatusPatch = (): void => undefined;

  try {
    await openSyntheticAdminOrders(detailPage, detailController);
    await assertG3DecorativeShellBrand(detailPage, 'Nordic Hearth', 24);
    const adminNavigation = detailPage.getByRole('navigation', {
      name: 'Administrator navigation',
    });
    await expect(adminNavigation.locator('[aria-current=page]')).toHaveCount(1);
    await expect(
      adminNavigation.getByRole('link', { exact: true, name: 'Orders' }),
    ).toHaveAttribute('aria-current', 'page');

    const detailLink = detailPage.getByRole('link', {
      exact: true,
      name: `View order ${ADMIN_ORDER_DETAIL_NUMBER}`,
    });
    await blurActiveElement(detailPage);
    await tabTo(detailPage, detailLink, 64);
    await assertVisibleKeyboardFocus(detailLink);
    const detailResponse = waitForApiResponse(
      detailPage,
      'GET',
      ADMIN_ORDER_DETAIL_API_PATH,
    );
    await detailPage.keyboard.press('Enter');
    await assertResponseStatus(detailResponse, 200, 'G3_ADMIN_DETAIL_STATUS_MISMATCH');
    await assertLocation(detailPage, `/admin/orders/${ADMIN_ORDER_DETAIL_NUMBER}`);
    const adminMain = detailPage.getByRole('main');
    await expect(
      adminMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: `Order ${ADMIN_ORDER_DETAIL_NUMBER}`,
      }),
    ).toBeVisible();
    await expect(adminMain).toBeFocused();

    const markReadyButton = adminMain.getByRole('button', {
      exact: true,
      name: 'Mark ready',
    });
    await blurActiveElement(detailPage);
    await tabTo(detailPage, markReadyButton, 96);
    await assertVisibleKeyboardFocus(markReadyButton);
    await detailPage.keyboard.press('Enter');
    const confirmationHeading = adminMain.getByRole('heading', {
      exact: true,
      level: 3,
      name: 'Mark this order as ready?',
    });
    await expect(confirmationHeading).toBeFocused();
    const confirmButton = adminMain.getByRole('button', {
      exact: true,
      name: 'Confirm Mark ready',
    });
    await detailPage.keyboard.press('Tab');
    await assertVisibleKeyboardFocus(confirmButton);

    detailController.nextStatusPatchResponseGate = new Promise<void>((resolve) => {
      releaseStatusPatch = resolve;
    });
    const patchResponse = waitForApiResponse(detailPage, 'PATCH', statusApiPath);
    const authoritativeRefresh = waitForApiResponse(
      detailPage,
      'GET',
      ADMIN_ORDER_DETAIL_API_PATH,
    );
    try {
      await detailPage.keyboard.press('Enter');
      await expect(
        adminMain.getByRole('status').filter({ hasText: 'Updating order status' }),
      ).toHaveCount(1);
      const orderSummary = adminMain.getByRole('region', {
        exact: true,
        name: 'Order summary',
      });
      await expect(orderSummary.getByText('Preparing', { exact: true })).toBeVisible();
      await expect(orderSummary.getByText('Ready', { exact: true })).toHaveCount(0);
      await expect(
        adminMain.getByText('Order status updated.', { exact: true }),
      ).toHaveCount(0);
    } finally {
      releaseStatusPatch();
    }
    await Promise.all([
      assertResponseStatus(
        patchResponse,
        409,
        'G3_ADMIN_DETAIL_CONFLICT_STATUS_MISMATCH',
      ),
      assertResponseStatus(
        authoritativeRefresh,
        200,
        'G3_ADMIN_DETAIL_AUTHORITATIVE_REFRESH_STATUS_MISMATCH',
      ),
    ]);
    const conflictNotice = adminMain.getByRole('alert').filter({
      hasText:
        'The order changed or this action is not currently allowed. The latest order details have been loaded.',
    });
    await expect(conflictNotice).toHaveCount(1);
    await expect(conflictNotice).not.toContainText(
      'Private synthetic mutation conflict',
    );
    const actionsHeading = adminMain.getByRole('heading', {
      exact: true,
      level: 2,
      name: 'Order actions',
    });
    await expect(actionsHeading).toBeFocused();
    const orderSummary = adminMain.getByRole('region', {
      exact: true,
      name: 'Order summary',
    });
    const readyStatus = orderSummary.getByText('Ready', { exact: true });
    await expect(readyStatus).toBeVisible();
    await expect(readyStatus.locator('..')).toHaveAttribute('data-variant', 'info');
    await expect(
      adminMain.getByRole('button', { exact: true, name: 'Complete order' }),
    ).toBeEnabled();
    await expect(
      adminMain.getByRole('button', { exact: true, name: 'Mark ready' }),
    ).toHaveCount(0);
    await expect(
      adminMain.getByText('Order status updated.', { exact: true }),
    ).toHaveCount(0);

    const patchRequests = detailController.requests.filter(
      ({ pathname }) => pathname === statusApiPath,
    );
    expect(patchRequests).toEqual([
      {
        authorization: `Bearer ${ADMIN_ORDERS_TOKEN}`,
        capability: null,
        method: 'PATCH',
        pathname: statusApiPath,
        postData: JSON.stringify({ status: 'ready' }),
        search: '',
      },
    ]);
    expect(
      detailController.requests.filter(
        ({ method, pathname }) =>
          method === 'GET' && pathname === ADMIN_ORDER_DETAIL_API_PATH,
      ),
    ).toHaveLength(2);
    expect(
      detailController.networkIssues,
      'G3_ADMIN_DETAIL_SYNTHETIC_NETWORK_FAILURE',
    ).toEqual([]);
  } finally {
    releaseStatusPatch();
    try {
      detailGuard.assertClean();
    } finally {
      await closeContext(detailContext);
    }
  }
});

async function assertH1AdminUsersChunkIsolation(
  browser: Browser,
  isPageChunkPath: (pathname: string, stem: string) => boolean,
): Promise<void> {
  const authorizedContext = await browser.newContext({
    baseURL: baseOrigin,
    forcedColors: 'active',
    reducedMotion: 'reduce',
    viewport: { height: 800, width: 1280 },
  });
  await seedG1SessionStorage(authorizedContext, [
    {
      key: ACCOUNT_AUTH_STORAGE_KEY,
      value: JSON.stringify({ accessToken: ADMIN_USERS_TOKEN, version: 1 }),
    },
  ]);
  const authorizedPage = await authorizedContext.newPage();
  const authorizedController: SyntheticAdminUsersController = {
    authoritativeCustomerRole: 'customer',
    failNextPatchStatus: null,
    mode: 'healthy',
    networkIssues: [],
    nextUsersResponseGate: null,
    patchResponseGate: null,
    requests: [],
  };
  const authorizedGuard = new BrowserSafetyGuard(authorizedPage, [ADMIN_USERS_TOKEN]);
  const authorizedAdminUsersChunkResponses: number[] = [];
  let authorizedAdminUsersChunkRequests = 0;
  authorizedPage.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      isPageChunkPath(parsed.pathname, 'AdminUsersPage')
    ) {
      authorizedAdminUsersChunkRequests += 1;
    }
  });
  authorizedPage.on('response', (response) => {
    const parsed = parseUrl(response.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      isPageChunkPath(parsed.pathname, 'AdminUsersPage')
    ) {
      authorizedAdminUsersChunkResponses.push(response.status());
    }
  });
  await installSyntheticAdminUsersRouting(authorizedPage, authorizedController);

  try {
    const currentUserResponse = waitForApiResponse(
      authorizedPage,
      'GET',
      AUTH_ME_API_PATH,
    );
    const usersResponse = waitForApiResponse(
      authorizedPage,
      'GET',
      ADMIN_USERS_API_PATH,
    );
    await authorizedPage.goto('/admin/users');
    await Promise.all([
      assertResponseStatus(
        currentUserResponse,
        200,
        'H1_AUTHORIZED_CURRENT_USER_STATUS_MISMATCH',
      ),
      assertResponseStatus(
        usersResponse,
        200,
        'H1_AUTHORIZED_ADMIN_USERS_STATUS_MISMATCH',
      ),
    ]);
    await assertLocation(authorizedPage, '/admin/users');
    await expect(
      authorizedPage.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Users',
      }),
    ).toBeVisible();
    expect(
      authorizedAdminUsersChunkRequests,
      'H1_AUTHORIZED_ADMIN_USERS_CHUNK_REQUEST_COUNT_MISMATCH',
    ).toBe(1);
    expect(
      authorizedAdminUsersChunkResponses,
      'H1_AUTHORIZED_ADMIN_USERS_CHUNK_RESPONSE_MISMATCH',
    ).toEqual([200]);
    expect(
      authorizedController.networkIssues,
      'H1_AUTHORIZED_ADMIN_USERS_SYNTHETIC_NETWORK_FAILURE',
    ).toEqual([]);
  } finally {
    try {
      authorizedGuard.assertClean();
    } finally {
      await closeContext(authorizedContext);
    }
  }

  const unauthorizedContext = await browser.newContext({
    baseURL: baseOrigin,
    forcedColors: 'active',
    reducedMotion: 'reduce',
    viewport: { height: 568, width: 320 },
  });
  const unauthorizedPage = await unauthorizedContext.newPage();
  const unauthorizedNetworkIssues: string[] = [];
  const unauthorizedGuard = new BrowserSafetyGuard(unauthorizedPage, []);
  let unauthorizedAdminUsersChunkRequests = 0;
  unauthorizedPage.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      isPageChunkPath(parsed.pathname, 'AdminUsersPage')
    ) {
      unauthorizedAdminUsersChunkRequests += 1;
    }
  });
  await unauthorizedPage.route('**/*', async (route) => {
    const request = route.request();
    const parsed = parseUrl(request.url());
    if (parsed === null || parsed.origin !== baseOrigin) {
      unauthorizedNetworkIssues.push('h1-unauthorized-external-or-invalid-request');
      await route.abort();
      return;
    }
    if (parsed.pathname.startsWith('/api/')) {
      unauthorizedNetworkIssues.push(
        `h1-unauthorized-unexpected-api:${request.method()}:${parsed.pathname}`,
      );
      await route.fulfill({
        body: JSON.stringify({ detail: 'Unexpected synthetic API request' }),
        contentType: 'application/json',
        status: 500,
      });
      return;
    }
    await route.continue();
  });

  try {
    await unauthorizedPage.goto('/admin/users');
    await expect(
      unauthorizedPage.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Sign in',
      }),
    ).toBeVisible();
    await expect
      .poll(
        () => {
          const current = new URL(unauthorizedPage.url());
          return {
            next: current.searchParams.get('next'),
            pathname: current.pathname,
          };
        },
        { message: 'H1_UNAUTHORIZED_ADMIN_USERS_REDIRECT_MISMATCH' },
      )
      .toEqual({ next: '/admin/users', pathname: '/login' });
    expect(
      unauthorizedAdminUsersChunkRequests,
      'H1_UNAUTHORIZED_ADMIN_USERS_CHUNK_REQUESTED',
    ).toBe(0);
    expect(
      unauthorizedNetworkIssues,
      'H1_UNAUTHORIZED_ADMIN_USERS_SYNTHETIC_NETWORK_FAILURE',
    ).toEqual([]);
  } finally {
    try {
      unauthorizedGuard.assertClean();
    } finally {
      await closeContext(unauthorizedContext);
    }
  }
}

test('keeps H1 production route chunks lazy, guarded, and history-safe', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const hashedJavaScriptPathPattern =
    /^\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+\.js$/u;
  const lazyPageChunkStems = [
    'AccountOrderDetailPage',
    'AccountOrdersPage',
    'LoginPage',
    'RegisterPage',
    'CartPage',
    'CheckoutCancelledPage',
    'CheckoutPage',
    'PaymentReturnPage',
    'MenuPage',
    'OrderStatusPage',
    'AdminAnalyticsPage',
    'AdminExportsPage',
    'AdminHomePage',
    'AdminMenuPage',
    'AdminOrderDetailPage',
    'AdminOrdersPage',
    'AdminUsersPage',
  ] as const;
  const isPageChunkPath = (pathname: string, stem: string): boolean => {
    const prefix = `/assets/${stem}-`;
    return (
      pathname.startsWith(prefix) &&
      /^[A-Za-z0-9_-]+\.js$/u.test(pathname.slice(prefix.length))
    );
  };
  const isLazyPageChunkPath = (pathname: string): boolean =>
    lazyPageChunkStems.some((stem) => isPageChunkPath(pathname, stem));

  const customerContext = await browser.newContext({
    baseURL: baseOrigin,
    forcedColors: 'active',
    reducedMotion: 'reduce',
    viewport: { height: 812, width: 375 },
  });
  const customerPage = await customerContext.newPage();
  const customerNetworkIssues: string[] = [];
  const quoteRequests: SyntheticCartQuoteItem[][] = [];
  const customerGuard = new BrowserSafetyGuard(customerPage, []);
  const customerJavaScriptResponses: Array<{
    readonly pathname: string;
    readonly status: number;
  }> = [];
  let menuChunkRequestCount = 0;
  let releaseMenuChunk = (): void => undefined;
  const menuChunkGate = new Promise<void>((resolve) => {
    releaseMenuChunk = resolve;
  });

  customerPage.on('response', (response) => {
    const parsed = parseUrl(response.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname.endsWith('.js')
    ) {
      customerJavaScriptResponses.push({
        pathname: parsed.pathname,
        status: response.status(),
      });
    }
  });
  await installSyntheticCartRouting(customerPage, quoteRequests, customerNetworkIssues);
  await customerPage.route(
    /\/assets\/MenuPage-[A-Za-z0-9_-]+\.js(?:\?.*)?$/u,
    async (route) => {
      const parsed = parseUrl(route.request().url());
      safeInvariant(
        parsed !== null && isPageChunkPath(parsed.pathname, 'MenuPage'),
        'H1_MENU_CHUNK_PATH_INVALID',
      );
      menuChunkRequestCount += 1;
      await menuChunkGate;
      await route.continue();
    },
  );

  try {
    await customerPage.goto('/');
    await expect(
      customerPage.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeVisible();

    const landingJavaScriptResponses = [...customerJavaScriptResponses];
    const productionPreviewDetected = landingJavaScriptResponses.some(({ pathname }) =>
      hashedJavaScriptPathPattern.test(pathname),
    );
    test.skip(
      !productionPreviewDetected,
      'H1 route-chunk proof runs only against a production preview.',
    );
    if (!productionPreviewDetected) return;

    expect(
      landingJavaScriptResponses.length,
      'H1_PRODUCTION_ENTRY_JAVASCRIPT_MISSING',
    ).toBeGreaterThan(0);
    expect(
      landingJavaScriptResponses.every(
        ({ pathname, status }) =>
          hashedJavaScriptPathPattern.test(pathname) && status === 200,
      ),
      'H1_LANDING_JAVASCRIPT_NOT_HASHED_OR_SUCCESSFUL',
    ).toBe(true);
    expect(
      landingJavaScriptResponses.filter(({ pathname }) =>
        isLazyPageChunkPath(pathname),
      ),
      'H1_LAZY_PAGE_CHUNK_EAGER_ON_LANDING',
    ).toEqual([]);
    const mediaPreferences = await customerPage.evaluate(() => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      return {
        forcedColors: runtime.matchMedia('(forced-colors: active)').matches,
        reducedMotion: runtime.matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    });
    expect(mediaPreferences).toEqual({ forcedColors: true, reducedMotion: true });

    const customerBanner = customerPage.getByRole('banner');
    const customerMain = customerPage.getByRole('main');
    const customerNavigation = customerPage.getByRole('navigation', {
      name: 'Customer navigation',
    });
    const menuLink = customerNavigation.getByRole('link', {
      exact: true,
      name: 'Menu',
    });
    await expect(customerBanner).toBeVisible();
    await expect(customerMain).toHaveCount(1);
    await blurActiveElement(customerPage);
    await tabTo(customerPage, menuLink, 24);
    await assertVisibleKeyboardFocus(menuLink);

    try {
      await customerPage.keyboard.press('Enter');
      await assertLocation(customerPage, '/menu');
      await expect.poll(() => menuChunkRequestCount).toBe(1);
      await expect(customerBanner).toBeVisible();
      await expect(customerNavigation).toBeVisible();
      await expect(customerMain).toHaveCount(1);
      await expect(customerMain).toBeFocused();
      const loadingBoundary = customerMain.locator('[aria-busy=true]');
      await expect(loadingBoundary).toHaveCount(1);
      await expect(loadingBoundary).toBeVisible();
      const loadingStatus = loadingBoundary.getByRole('status');
      await expect(loadingStatus).toHaveCount(1);
      await expect(loadingStatus).toBeVisible();
      await expect(
        loadingStatus.getByText('Loading page', { exact: true }),
      ).toBeVisible();
      await expect(
        loadingStatus.getByText('Preparing the requested page.', { exact: true }),
      ).toBeVisible();
    } finally {
      releaseMenuChunk();
    }

    await expect(
      customerMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Our menu',
      }),
    ).toBeVisible();
    await expect(customerMain).toBeFocused();
    await expect(
      customerPage.getByRole('article', { exact: true, name: MENU_ITEM_NAME }),
    ).toBeVisible();
    const menuChunkResponses = customerJavaScriptResponses.filter(({ pathname }) =>
      isPageChunkPath(pathname, 'MenuPage'),
    );
    expect(menuChunkRequestCount, 'H1_MENU_CHUNK_REQUEST_COUNT_MISMATCH').toBe(1);
    expect(menuChunkResponses, 'H1_MENU_CHUNK_RESPONSE_COUNT_MISMATCH').toHaveLength(1);
    expect(menuChunkResponses[0]?.status, 'H1_MENU_CHUNK_STATUS_MISMATCH').toBe(200);

    await customerPage.goBack();
    await assertLocation(customerPage, '/');
    await expect(
      customerMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeVisible();
    await expect(customerMain).toBeFocused();

    const forwardMenuResponse = waitForApiResponse(
      customerPage,
      'GET',
      AUTH_MENU_API_PATH,
    );
    await customerPage.goForward();
    await assertResponseStatus(
      forwardMenuResponse,
      200,
      'H1_HISTORY_MENU_RESPONSE_STATUS_MISMATCH',
    );
    await assertLocation(customerPage, '/menu');
    await expect(
      customerMain.getByRole('heading', {
        exact: true,
        level: 1,
        name: 'Our menu',
      }),
    ).toBeVisible();
    await expect(customerMain).toBeFocused();
    await expect(
      customerPage.getByRole('article', { exact: true, name: MENU_ITEM_NAME }),
    ).toBeVisible();
    expect(menuChunkRequestCount, 'H1_MENU_CHUNK_RELOADED_DURING_HISTORY').toBe(1);
    expect(customerNetworkIssues, 'H1_CUSTOMER_SYNTHETIC_NETWORK_FAILURE').toEqual([]);
  } finally {
    releaseMenuChunk();
    try {
      customerGuard.assertClean();
    } finally {
      await closeContext(customerContext);
    }
  }

  await assertH1AdminUsersChunkIsolation(browser, isPageChunkPath);
});

test('keeps responsive shells, keyboard focus, and runtime boundaries usable', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const administrator = loadAdministratorIdentity();
  const sensitiveValues = [administrator.email, administrator.password];
  const publicGuard = new BrowserSafetyGuard(page, sensitiveValues);
  const adminContext = await browser.newContext({ baseURL: baseOrigin });
  const adminPage = await adminContext.newPage();
  const adminGuard = new BrowserSafetyGuard(adminPage, sensitiveValues);

  let scenarioError: unknown;
  let finalizationError: unknown;
  try {
    await assertPublicLayouts(page);
    await assertCustomerKeyboardContracts(page);
    await assertAuthKeyboardContracts(page);

    await adminPage.setViewportSize({ height: 812, width: 375 });
    await loginAdministrator(adminPage, administrator);
    await createOwnedOrder(adminPage);
    await assertAuthenticatedLayouts(adminPage, administrator);
    await assertAdministratorKeyboardContracts(adminPage);
  } catch (error: unknown) {
    scenarioError = error;
  } finally {
    try {
      publicGuard.assertClean();
      adminGuard.assertClean();
    } catch (error: unknown) {
      finalizationError = error;
    }
    try {
      await closeContext(adminContext);
    } catch (error: unknown) {
      finalizationError ??= error;
    }
  }

  if (scenarioError !== undefined) {
    throw scenarioError;
  }
  if (finalizationError !== undefined) {
    throw finalizationError;
  }
});
